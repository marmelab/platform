import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'

// ── Types ─────────────────────────────────────────────────────────────────────

export type JobStatus = 'pending' | 'running' | 'done' | 'done-with-warnings' | 'error' | 'interrupted'
export type JobPhase = 'dump' | 'restore' | null

export interface MigrationJob {
  id: string
  targetRef: string
  // Runtime-only (never written to disk — contains password)
  sourceDbUrl?: string
  // Persisted fields
  targetDockerProject: string
  dockerHost?: string
  schemas: string[]
  schemaOnly: boolean
  maskedSourceUrl: string
  status: JobStatus
  phase: JobPhase
  restoreErrors: number   // count of "ERROR:" lines in pg_restore stderr
  logs: string[]          // in-memory; disk uses a separate .log file
  startedAt: string
  finishedAt?: string
}

// Fields written to the .json file on disk (no secrets, no log array)
type PersistedMeta = Omit<MigrationJob, 'logs' | 'sourceDbUrl'>

// Shape returned to the UI (safe to expose)
export type MigrationJobView = Omit<MigrationJob, 'sourceDbUrl' | 'targetDockerProject' | 'dockerHost'>

// ── Persistence paths ─────────────────────────────────────────────────────────

const DATA_DIR = process.env.STUDIO_DATA_DIR || path.join(/*turbopackIgnore: true*/ process.cwd(), '.studio-data')
const MIGRATIONS_DIR = path.join(DATA_DIR, 'migrations')

function jobMetaPath(id: string) { return path.join(MIGRATIONS_DIR, `${id}.json`) }
function jobLogPath(id: string)  { return path.join(MIGRATIONS_DIR, `${id}.log`)  }

function saveJobMeta(job: MigrationJob): void {
  try {
    fs.mkdirSync(MIGRATIONS_DIR, { recursive: true })
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { logs, sourceDbUrl, ...meta } = job
    fs.writeFileSync(jobMetaPath(job.id), JSON.stringify(meta, null, 2), 'utf-8')
  } catch { /* non-fatal */ }
}

function appendLogLine(id: string, line: string): void {
  try {
    fs.mkdirSync(MIGRATIONS_DIR, { recursive: true })
    fs.appendFileSync(jobLogPath(id), line + '\n', 'utf-8')
  } catch { /* non-fatal */ }
}

function readLogLines(id: string): string[] {
  try {
    const text = fs.readFileSync(jobLogPath(id), 'utf-8')
    return text.split('\n').filter(Boolean)
  } catch { return [] }
}

// ── In-memory store ───────────────────────────────────────────────────────────

const jobs = new Map<string, MigrationJob>()

// Load a job from disk (cache hit for subsequent calls)
function loadFromDisk(id: string): MigrationJob | undefined {
  const metaPath = jobMetaPath(id)
  if (!fs.existsSync(metaPath)) return undefined
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as PersistedMeta
    const job: MigrationJob = { ...meta, logs: readLogLines(id) }
    jobs.set(id, job)
    return job
  } catch { return undefined }
}

export function getJob(id: string): MigrationJob | undefined {
  return jobs.get(id) ?? loadFromDisk(id)
}

export function listInterruptedJobs(targetRef: string): MigrationJob[] {
  return [...jobs.values()].filter(j => j.targetRef === targetRef && j.status === 'interrupted')
}

// ── Startup recovery ──────────────────────────────────────────────────────────
// Runs once when this module is first imported. Any job that was `running` or
// `pending` in a previous Studio process is transitioned to `interrupted` so the
// UI can surface it and offer resume.

function recoverInterruptedJobs(): void {
  try {
    if (!fs.existsSync(MIGRATIONS_DIR)) return
    const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.json'))
    const sevenDaysAgo = Date.now() - 7 * 24 * 3600 * 1000

    for (const file of files) {
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8')) as PersistedMeta

        // Prune completed jobs older than 7 days
        if (
          (meta.status === 'done' || meta.status === 'done-with-warnings' || meta.status === 'error') &&
          meta.finishedAt &&
          new Date(meta.finishedAt).getTime() < sevenDaysAgo
        ) {
          fs.rmSync(path.join(MIGRATIONS_DIR, file), { force: true })
          try { fs.rmSync(jobLogPath(meta.id), { force: true }) } catch { /* ok */ }
          continue
        }

        const job: MigrationJob = { ...meta, logs: readLogLines(meta.id) }

        if (meta.status === 'running' || meta.status === 'pending') {
          job.status = 'interrupted'
          job.phase = null
          job.finishedAt = new Date().toISOString()
          job.logs.push('Studio process restarted — migration was interrupted.')
          saveJobMeta(job)
          appendLogLine(job.id, 'Studio process restarted — migration was interrupted.')
        }

        jobs.set(meta.id, job)
      } catch { /* skip corrupt file */ }
    }
  } catch { /* MIGRATIONS_DIR unreadable — non-fatal */ }
}

recoverInterruptedJobs()

// ── Docker helpers ────────────────────────────────────────────────────────────

function buildDockerEnv(dockerHost?: string): NodeJS.ProcessEnv {
  const env = {} as NodeJS.ProcessEnv
  for (const key of [
    'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'TMPDIR', 'TMP', 'TEMP',
    'XDG_RUNTIME_DIR', 'DOCKER_HOST', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH',
  ]) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  if (dockerHost) env['DOCKER_HOST'] = dockerHost
  return env
}

export function findDbContainer(dockerProject: string, dockerHost?: string): string | null {
  const result = spawnSync(
    'docker',
    [
      'ps',
      '--filter', `label=com.docker.compose.project=${dockerProject}`,
      '--filter', `label=com.docker.compose.service=db`,
      '--format', '{{.Names}}',
    ],
    { encoding: 'utf-8', timeout: 8000, env: buildDockerEnv(dockerHost) }
  )
  const name = result.stdout?.trim().split('\n')[0]?.trim()
  return name || null
}

export function dumpFileExists(jobId: string, container: string, dockerHost?: string): boolean {
  const result = spawnSync(
    'docker',
    ['exec', container, 'test', '-f', `/tmp/smh-migrate-${jobId}.pgdump`],
    { timeout: 5000, env: buildDockerEnv(dockerHost) }
  )
  return result.status === 0
}

function maskDbUrl(url: string): string {
  try {
    const parsed = new URL(url)
    parsed.password = '****'
    return parsed.toString()
  } catch {
    return url.replace(/:[^:@]+@/, ':****@')
  }
}

// ── Exec helpers ──────────────────────────────────────────────────────────────

// Runs a single `docker exec` and streams stdout/stderr to the log callback.
// For the restore phase, also counts lines that contain "pg_restore: error:"
// so we can distinguish real failures from expected drop-errors.
function runDockerExec(
  args: string[],
  log: (msg: string) => void,
  dockerHost?: string,
  opts: { allowExitCode1?: boolean; onRestoreError?: () => void } = {}
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('docker', args, {
      env: buildDockerEnv(dockerHost),
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const handle = (d: Buffer) => {
      d.toString().split('\n').forEach((line) => {
        const msg = line.trim()
        if (!msg) return
        log(msg)
        // pg_restore writes real errors as "pg_restore: error: ..."
        if (opts.onRestoreError && /^pg_restore:\s+error:/i.test(msg)) {
          opts.onRestoreError()
        }
      })
    }
    proc.stderr.on('data', handle)
    proc.stdout.on('data', handle)
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code === 0 || (code === 1 && opts.allowExitCode1)) resolve()
      else reject(new Error(`docker exec exited with code ${code}`))
    })
  })
}

function cleanupDumpFile(container: string, jobId: string, dockerHost?: string): void {
  spawnSync('docker', ['exec', container, 'rm', '-f', `/tmp/smh-migrate-${jobId}.pgdump`], {
    encoding: 'utf-8', timeout: 10_000, env: buildDockerEnv(dockerHost),
  })
}

// ── Migration start ───────────────────────────────────────────────────────────

export interface StartMigrationOpts {
  targetRef: string
  targetDockerProject: string
  sourceDbUrl: string
  schemas: string[]
  schemaOnly: boolean
  dockerHost?: string
}

export function startMigration(opts: StartMigrationOpts): MigrationJob {
  const id = crypto.randomBytes(8).toString('hex')
  const job: MigrationJob = {
    id,
    targetRef: opts.targetRef,
    targetDockerProject: opts.targetDockerProject,
    dockerHost: opts.dockerHost,
    sourceDbUrl: opts.sourceDbUrl,          // runtime-only, not persisted
    maskedSourceUrl: maskDbUrl(opts.sourceDbUrl),
    schemas: opts.schemas,
    schemaOnly: opts.schemaOnly,
    status: 'pending',
    phase: null,
    restoreErrors: 0,
    logs: [],
    startedAt: new Date().toISOString(),
  }
  jobs.set(id, job)
  saveJobMeta(job)                          // persist immediately so restarts see it
  void runMigration(job, opts)
  return job
}

// ── Resume interrupted job ────────────────────────────────────────────────────
// Skips the dump phase and goes straight to restore using the existing dump file.
// Only valid when status === 'interrupted' and dumpFileExists() is true.

export function resumeMigration(jobId: string): MigrationJob {
  const job = getJob(jobId)
  if (!job) throw new Error('Job not found')
  if (job.status !== 'interrupted') throw new Error('Job is not in interrupted state')

  job.status = 'running'
  job.phase = 'restore'
  job.restoreErrors = 0
  job.finishedAt = undefined
  saveJobMeta(job)

  void runRestorePhase(job)
  return job
}

// ── Core phases ───────────────────────────────────────────────────────────────

async function runMigration(job: MigrationJob, opts: StartMigrationOpts): Promise<void> {
  job.status = 'running'
  saveJobMeta(job)

  const log = (msg: string) => {
    job.logs.push(msg)
    appendLogLine(job.id, msg)
  }

  try {
    log('Locating target database container…')
    const container = findDbContainer(opts.targetDockerProject, opts.dockerHost)
    if (!container) {
      throw new Error(
        `No running postgres container found for project "${opts.targetDockerProject}". ` +
          'Make sure the project is started and healthy before migrating.'
      )
    }
    log(`Target container: ${container}`)

    // ── Phase 1: Dump ─────────────────────────────────────────────────────────
    job.phase = 'dump'
    saveJobMeta(job)

    log(`[1/2] Dumping ${maskDbUrl(opts.sourceDbUrl)} → /tmp/smh-migrate-${job.id}.pgdump (compressed)…`)
    log(`      Schemas: [${opts.schemas.join(', ')}] | ${opts.schemaOnly ? 'schema only' : 'schema + data'}`)

    const dumpArgs = [
      'exec', container,
      'pg_dump', '--verbose', '--no-owner', '--no-acl', '-Fc',
      '-f', `/tmp/smh-migrate-${job.id}.pgdump`,
    ]
    if (opts.schemaOnly) dumpArgs.push('--schema-only')
    for (const s of opts.schemas) dumpArgs.push('--schema', s)
    dumpArgs.push(opts.sourceDbUrl)

    await runDockerExec(dumpArgs, log, opts.dockerHost)
    log('[1/2] Dump complete.')

    // ── Phase 2: Restore ──────────────────────────────────────────────────────
    await runRestorePhaseInner(job, container, log)
  } catch (err) {
    job.status = 'error'
    job.finishedAt = new Date().toISOString()
    job.phase = null
    const msg = err instanceof Error ? err.message : String(err)
    log(`Error: ${msg}`)
    if (job.phase === 'dump' || msg.includes('pg_dump')) {
      log(`Dump file may or may not exist at /tmp/smh-migrate-${job.id}.pgdump inside the container.`)
    } else {
      log(`Dump file is at /tmp/smh-migrate-${job.id}.pgdump — restore can be retried via: smh migrate resume ${job.id}`)
    }
    saveJobMeta(job)
  }
}

async function runRestorePhase(job: MigrationJob): Promise<void> {
  const log = (msg: string) => {
    job.logs.push(msg)
    appendLogLine(job.id, msg)
  }

  try {
    log('Locating target database container…')
    const container = findDbContainer(job.targetDockerProject, job.dockerHost)
    if (!container) {
      throw new Error(
        `No running postgres container found for project "${job.targetDockerProject}". ` +
          'Make sure the project is started and healthy before resuming.'
      )
    }
    log(`Target container: ${container}`)
    await runRestorePhaseInner(job, container, log)
  } catch (err) {
    job.status = 'error'
    job.finishedAt = new Date().toISOString()
    job.phase = null
    log(`Error: ${err instanceof Error ? err.message : String(err)}`)
    log(`Dump file is still at /tmp/smh-migrate-${job.id}.pgdump — can retry again.`)
    saveJobMeta(job)
  }
}

async function runRestorePhaseInner(
  job: MigrationJob,
  container: string,
  log: (msg: string) => void
): Promise<void> {
  job.phase = 'restore'
  saveJobMeta(job)

  log(`[2/2] Restoring from /tmp/smh-migrate-${job.id}.pgdump into postgres…`)

  const restoreArgs = [
    'exec', container,
    'pg_restore', '--verbose', '--no-owner', '--no-acl', '--if-exists', '--clean',
    '-U', 'postgres', '-d', 'postgres',
    `/tmp/smh-migrate-${job.id}.pgdump`,
  ]

  // allowExitCode1: --clean --if-exists emits "object not found" notices on a
  // fresh target and exits 1 even though no real data was lost. We separately
  // count genuine "pg_restore: error:" lines via onRestoreError so the final
  // status can distinguish a clean restore from one with real failures.
  await runDockerExec(restoreArgs, log, job.dockerHost, {
    allowExitCode1: true,
    onRestoreError: () => { job.restoreErrors++ },
  })

  log('[2/2] Restore complete.')

  // Cleanup the dump file
  cleanupDumpFile(container, job.id, job.dockerHost)
  log('Temporary dump file removed.')

  job.status = job.restoreErrors > 0 ? 'done-with-warnings' : 'done'
  job.finishedAt = new Date().toISOString()
  job.phase = null

  if (job.restoreErrors > 0) {
    log(`⚠ Completed with ${job.restoreErrors} restore error(s) — check the log above for "pg_restore: error:" lines.`)
  } else {
    log('Migration completed successfully.')
  }

  saveJobMeta(job)
}
