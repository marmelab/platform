/**
 * WAL streaming replication helpers for multi-head standby stacks.
 *
 * Uses docker compose exec / docker run to configure Postgres streaming replication
 * between stacks without requiring the Studio process to reach Postgres directly.
 *
 * Limitations:
 *  - Only Docker-orchestrated projects (not the default bind-mount stack).
 *  - Primary must have wal_level = replica or logical (Supabase default: logical).
 *  - BASEBACKUP_IMAGE must be the same major Postgres version as supabase/postgres.
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

import type { StoredProject } from './projectsStore'
import { getStoredProjectByRef } from './projectsStore'
import { extractDockerHostname } from './orchestrator'

const DATA_DIR = process.env.STUDIO_DATA_DIR || path.join(/*turbopackIgnore: true*/ process.cwd(), '.studio-data')
const STACKS_DIR = path.join(DATA_DIR, 'stacks')
const MULTI_HEAD_COMPOSE_FILE = path.join(DATA_DIR, 'docker-compose.multi-head.yml')

/**
 * postgres image used for the one-shot pg_basebackup container.
 * Must match the major version of supabase/postgres (currently 15).
 * Override with REPLICATION_BASEBACKUP_IMAGE env var.
 */
const BASEBACKUP_IMAGE = process.env.REPLICATION_BASEBACKUP_IMAGE || 'postgres:15'

// ─────────────────────────────────────────────────────────────
// Docker helpers
// ─────────────────────────────────────────────────────────────

/**
 * Returns a safe env object for docker CLI calls targeting the project's daemon.
 * When the project has a docker_host set, DOCKER_HOST is overridden to route
 * commands to the correct remote daemon.
 */
function projectDockerEnv(project: StoredProject): NodeJS.ProcessEnv {
  const env = {} as NodeJS.ProcessEnv
  for (const key of [
    'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'TMPDIR', 'TMP', 'TEMP',
    'XDG_RUNTIME_DIR', 'DOCKER_HOST', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH', 'DOCKER_BUILDKIT',
  ]) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  if (project.docker_host) env['DOCKER_HOST'] = project.docker_host
  return env
}

function composeBaseArgs(project: StoredProject): string[] {
  const projectName = project.docker_project || `supabase-${project.ref}`
  const args = ['compose', '-p', projectName]
  if (fs.existsSync(MULTI_HEAD_COMPOSE_FILE)) args.push('-f', MULTI_HEAD_COMPOSE_FILE)
  const envFile = path.join(STACKS_DIR, project.ref, '.env')
  if (fs.existsSync(envFile)) args.push('--env-file', envFile)
  return args
}

function runPsql(project: StoredProject, sql: string): { ok: boolean; output: string } {
  const r = spawnSync(
    'docker',
    [...composeBaseArgs(project), 'exec', '-T', 'db', 'psql', '-U', 'postgres', '-t', '-c', sql],
    { encoding: 'utf-8', timeout: 30_000, env: projectDockerEnv(project) }
  )
  return { ok: r.status === 0 && !r.error, output: (r.stdout + r.stderr).trim() }
}

function composeDbService(project: StoredProject, action: 'stop' | 'start'): boolean {
  const r = spawnSync('docker', [...composeBaseArgs(project), action, 'db'], {
    encoding: 'utf-8',
    timeout: 30_000,
    env: projectDockerEnv(project),
  })
  return r.status === 0 && !r.error
}

// ─────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────

/**
 * Seeds the standby DB via pg_basebackup from the primary and starts it in
 * streaming replica mode.
 *
 * Must be called after the standby stack is ACTIVE_HEALTHY (containers exist,
 * named volume is initialised by the first Postgres startup).
 *
 *  1. Ensure pg_hba.conf on the primary allows external replication connections.
 *  2. Create a physical replication slot on the primary (WAL retained until standby
 *     connects; slot name is standby_{standbyRef}).
 *  3. Stop the standby DB container so its data directory can be replaced.
 *  4. Run pg_basebackup in a disposable container that mounts the standby's named
 *     volume. -R writes primary_conninfo + creates standby.signal automatically.
 *  5. Start the standby DB — Postgres reads standby.signal and begins streaming.
 */
export async function setupReplication(primaryRef: string, standbyRef: string): Promise<void> {
  const primary = getStoredProjectByRef(primaryRef)
  const standby = getStoredProjectByRef(standbyRef)
  if (!primary || !standby) throw new Error('Project not found')

  if (primaryRef === 'default') {
    throw new Error(
      'WAL replication is not supported for the default project (it uses a host ' +
        'bind-mount, not a Docker named volume). Create the primary as a new ' +
        'multi-head project to use replication.'
    )
  }
  if (!primary.postgres_port) throw new Error('Primary has no postgres_port configured')

  const slotName = `standby_${standbyRef}`

  // ── 1. pg_hba: ensure replication connections are accepted ──────────────────
  ensureReplicationHba(primary)

  // ── 2. WAL level check ──────────────────────────────────────────────────────
  const walLevel = runPsql(primary, "SELECT setting FROM pg_settings WHERE name = 'wal_level';")
  if (walLevel.ok && walLevel.output === 'minimal') {
    throw new Error(
      'Primary Postgres wal_level=minimal — WAL streaming is not possible. ' +
        'Set wal_level=replica (or logical) in postgresql.conf and restart the DB container.'
    )
  }

  // ── 3. Create physical replication slot (idempotent) ────────────────────────
  const slotResult = runPsql(
    primary,
    `DO $$ BEGIN
       IF NOT EXISTS (
         SELECT FROM pg_replication_slots WHERE slot_name = '${slotName}'
       ) THEN
         PERFORM pg_create_physical_replication_slot('${slotName}', true, false);
       END IF;
     END $$;`
  )
  if (!slotResult.ok) {
    throw new Error(`Failed to create replication slot on primary: ${slotResult.output}`)
  }

  // ── 4. Stop standby DB ──────────────────────────────────────────────────────
  if (!composeDbService(standby, 'stop')) {
    console.warn('[replication] Standby DB stop returned non-zero — continuing anyway')
  }

  // ── 5. pg_basebackup ────────────────────────────────────────────────────────
  // The container runs on the standby's Docker host (via standby's DOCKER_HOST).
  // For a local primary (no docker_host), host.docker.internal is the right peer
  // address from inside the container. For a remote primary, use its actual hostname.
  const volumeName = `${standby.docker_project}_db-data`
  const primaryHost = primary.docker_host
    ? extractDockerHostname(primary.docker_host)
    : 'host.docker.internal'
  const backupCmd = [
    'rm -rf /var/lib/postgresql/data/* /var/lib/postgresql/data/.[!.]*',
    [
      'pg_basebackup',
      `-h ${primaryHost}`,
      `-p ${primary.postgres_port}`,
      '-U supabase_replicator',
      '-D /var/lib/postgresql/data',
      '--wal-method=stream',
      '--checkpoint=fast',
      '-R',
      `--slot=${slotName}`,
      '--progress',
    ].join(' '),
  ].join(' && ')

  const backupDockerArgs = [
    'run', '--rm',
    '-v', `${volumeName}:/var/lib/postgresql/data`,
    '-e', `PGPASSWORD=${primary.db_password}`,
    BASEBACKUP_IMAGE,
    'bash', '-c', backupCmd,
  ]
  // For a local primary the pg_basebackup container needs host-gateway to resolve
  // host.docker.internal (Linux alias; Mac/Win already support it natively).
  if (!primary.docker_host) {
    backupDockerArgs.splice(2, 0, '--add-host', 'host.docker.internal:host-gateway')
  }

  const backup = spawnSync(
    'docker',
    backupDockerArgs,
    { encoding: 'utf-8', timeout: 300_000, env: projectDockerEnv(standby) }
  )

  if (backup.error || backup.status !== 0) {
    // Restart standby DB so the stack doesn't remain fully broken
    composeDbService(standby, 'start')
    throw new Error(
      `pg_basebackup failed:\n${(backup.stderr || backup.stdout || '').trim()}`
    )
  }

  // ── 6. Start standby DB — picks up standby.signal and begins streaming ──────
  if (!composeDbService(standby, 'start')) {
    throw new Error('Failed to start standby DB after pg_basebackup')
  }

  console.log(
    `[replication] Streaming replication active: ${primaryRef} → ${standbyRef} (slot: ${slotName})`
  )
}

/**
 * Promotes the standby Postgres to a writable primary.
 *
 * pg_promote(wait=true, wait_seconds=60) blocks inside Postgres until promotion
 * is complete, so by the time this returns the DB accepts writes.
 * Called by triggerFailover before connection details are swapped in the registry.
 */
export async function promoteStandby(standbyRef: string): Promise<void> {
  const standby = getStoredProjectByRef(standbyRef)
  if (!standby) throw new Error(`Standby project ${standbyRef} not found`)

  const result = runPsql(standby, 'SELECT pg_promote(true, 60);')
  if (!result.ok) {
    // If the DB is not in standby mode pg_promote() returns an error — warn and
    // continue so failover can still swap connection details.
    console.warn(`[replication] pg_promote on ${standbyRef}: ${result.output}`)
    return
  }
  console.log(`[replication] ${standbyRef} promoted to primary`)
}

/**
 * Drops the physical replication slot created by setupReplication.
 *
 * Must be called when deprovisioning a standby, otherwise the primary retains
 * all WAL produced since the slot was created (unbounded disk growth).
 */
export function dropReplicationSlot(primaryRef: string, standbyRef: string): void {
  const primary = getStoredProjectByRef(primaryRef)
  if (!primary) return

  const slotName = `standby_${standbyRef}`
  const result = runPsql(
    primary,
    `DO $$ BEGIN
       IF EXISTS (
         SELECT FROM pg_replication_slots WHERE slot_name = '${slotName}'
       ) THEN
         PERFORM pg_drop_replication_slot('${slotName}');
       END IF;
     END $$;`
  )
  if (!result.ok) {
    console.warn(`[replication] Failed to drop slot ${slotName}: ${result.output}`)
  }
}

// ─────────────────────────────────────────────────────────────
// Internal
// ─────────────────────────────────────────────────────────────

/**
 * Appends a replication rule for supabase_replicator to the primary's pg_hba.conf
 * if one isn't already present, then reloads the config.
 *
 * Supabase's default docker pg_hba.conf already includes this rule, so in practice
 * this is usually a no-op.
 */
function ensureReplicationHba(primary: StoredProject): void {
  const r = spawnSync(
    'docker',
    [
      ...composeBaseArgs(primary),
      'exec', '-T', 'db',
      'bash', '-c',
      // Resolve pg_hba.conf path from Postgres itself so we're always editing the right file
      `HBA=$(psql -U postgres -t -c "SHOW hba_file;" 2>/dev/null | tr -d '[:space:]') && ` +
        `grep -q 'supabase_replicator' "$HBA" || ` +
        `(echo 'host replication supabase_replicator all md5' >> "$HBA" && ` +
        `psql -U postgres -c 'SELECT pg_reload_conf();')`,
    ],
    { encoding: 'utf-8', timeout: 15_000, env: projectDockerEnv(primary) }
  )
  if (r.status !== 0) {
    console.warn('[replication] pg_hba update step (may already be configured):', r.stderr?.trim())
  }
}
