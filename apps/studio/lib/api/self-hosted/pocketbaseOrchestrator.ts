/**
 * Docker orchestration for PocketBase projects.
 *
 * Two modes:
 *
 *   pocketbase          — full Docker Compose stack (docker compose up -p pocketbase-{ref})
 *                         Files written to STACKS_DIR/{ref}/
 *
 *   pocketbase-embedded — plain docker run, no Compose project, no stack directory.
 *                         Container name: pb-{ref}
 *                         Volume name:    pb-{ref}-data
 *                         Mirrors Supabase "embedded" (no new Compose stack).
 *
 * Admin superuser is auto-created via PB_SUPERUSER_EMAIL / PB_SUPERUSER_PASSWORD
 * env vars (supported since PocketBase v0.22).
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const DATA_DIR = process.env.STUDIO_DATA_DIR || path.join(/*turbopackIgnore: true*/ process.cwd(), '.studio-data')
const STACKS_DIR = path.join(DATA_DIR, 'stacks')
const MULTI_HEAD_HOST = process.env.MULTI_HEAD_HOST || 'localhost'

// PocketBase default port; additional instances increment by 1.
const DEFAULT_PB_PORT = 8090

// ── Credentials ───────────────────────────────────────────────────────────────

export interface PocketBaseCredentials {
  adminEmail: string
  adminPassword: string
}

export function generatePocketBaseCredentials(): PocketBaseCredentials {
  return {
    adminEmail: `admin-${crypto.randomBytes(4).toString('hex')}@pocketbase.local`,
    adminPassword: crypto.randomBytes(16).toString('hex'),
  }
}

// ── Docker env helper ─────────────────────────────────────────────────────────

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

// ── Port allocation ───────────────────────────────────────────────────────────

/**
 * Returns the next free port for a new PocketBase instance.
 * Starts at DEFAULT_PB_PORT and increments by 1 until an unused port is found.
 */
export function allocatePocketBasePort(usedPorts: number[]): number {
  const used = new Set(usedPorts)
  let port = DEFAULT_PB_PORT
  while (used.has(port)) port += 1
  return port
}

/**
 * Scans for ports already in use by any PocketBase container (both Compose stacks
 * named pocketbase-* and plain embedded containers named pb-*).
 */
export function discoverPocketBasePorts(): number[] {
  const ports: number[] = []
  try {
    // Compose stacks: pocketbase-{ref}-pocketbase-1
    const lsResult = spawnSync('docker', ['compose', 'ls', '--format', 'json', '--all'], {
      encoding: 'utf-8',
      timeout: 8000,
    })
    if (!lsResult.error && lsResult.status === 0) {
      const stacks = JSON.parse(lsResult.stdout.trim() || '[]') as Array<{ Name: string }>
      for (const stack of stacks) {
        if (!stack.Name.startsWith('pocketbase-')) continue
        const psResult = spawnSync(
          'docker',
          ['ps', '--filter', `name=${stack.Name}-pocketbase`, '--format', '{{.Ports}}'],
          { encoding: 'utf-8', timeout: 5000 }
        )
        if (psResult.error || psResult.status !== 0) continue
        const match = psResult.stdout.match(/(?:0\.0\.0\.0:|:::)?(\d+)->8090\/tcp/)
        if (match) ports.push(parseInt(match[1], 10))
      }
    }

    // Plain embedded containers: pb-{ref}
    const psResult = spawnSync(
      'docker',
      ['ps', '--filter', 'name=pb-', '--format', '{{.Ports}}'],
      { encoding: 'utf-8', timeout: 5000 }
    )
    if (!psResult.error && psResult.status === 0) {
      for (const line of psResult.stdout.split('\n')) {
        const match = line.match(/(?:0\.0\.0\.0:|:::)?(\d+)->8090\/tcp/)
        if (match) ports.push(parseInt(match[1], 10))
      }
    }
  } catch { /* non-fatal */ }
  return ports
}

// ── Compose template ──────────────────────────────────────────────────────────

const PB_COMPOSE_TEMPLATE = `services:
  pocketbase:
    image: ghcr.io/pocketbase/pocketbase:latest
    environment:
      PB_SUPERUSER_EMAIL: \${PB_ADMIN_EMAIL}
      PB_SUPERUSER_PASSWORD: \${PB_ADMIN_PASSWORD}
    ports:
      - "\${POCKETBASE_PORT}:8090"
    volumes:
      - pb_data:/pb_data
    restart: unless-stopped
    healthcheck:
      test: ["CMD-SHELL", "wget -qO- http://localhost:8090/api/health || exit 1"]
      interval: 10s
      timeout: 5s
      retries: 18

volumes:
  pb_data:
`

// ── Stack lifecycle ───────────────────────────────────────────────────────────

export async function launchPocketBaseStack(opts: {
  ref: string
  pocketbasePort: number
  credentials: PocketBaseCredentials
  dockerHost?: string
}): Promise<void> {
  const stackDir = path.join(STACKS_DIR, opts.ref)
  fs.mkdirSync(stackDir, { recursive: true })

  const composePath = path.join(stackDir, 'docker-compose.pocketbase.yml')
  fs.writeFileSync(composePath, PB_COMPOSE_TEMPLATE, 'utf-8')

  const envContent = [
    `POCKETBASE_PORT=${opts.pocketbasePort}`,
    `PB_ADMIN_EMAIL=${opts.credentials.adminEmail}`,
    `PB_ADMIN_PASSWORD=${opts.credentials.adminPassword}`,
  ].join('\n') + '\n'
  fs.writeFileSync(path.join(stackDir, '.env'), envContent, 'utf-8')

  const env = buildDockerEnv(opts.dockerHost)
  const result = spawnSync(
    'docker',
    [
      'compose',
      '-p', `pocketbase-${opts.ref}`,
      '--env-file', path.join(stackDir, '.env'),
      '-f', composePath,
      'up', '-d', '--remove-orphans',
    ],
    { env, timeout: 120_000, encoding: 'utf-8' }
  )

  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`docker compose up failed:\n${result.stderr || result.stdout}`)
  }
}

export function teardownPocketBaseStack(ref: string, dockerHost?: string): void {
  const stackDir = path.join(STACKS_DIR, ref)
  const composePath = path.join(stackDir, 'docker-compose.pocketbase.yml')
  const envPath = path.join(stackDir, '.env')

  const env = buildDockerEnv(dockerHost)
  spawnSync(
    'docker',
    [
      'compose',
      '-p', `pocketbase-${ref}`,
      '--env-file', envPath,
      '-f', composePath,
      'down', '--volumes',
    ],
    { env, timeout: 60_000, encoding: 'utf-8' }
  )

  try { fs.rmSync(stackDir, { recursive: true, force: true }) } catch { /* non-fatal */ }
}

// ── Health ────────────────────────────────────────────────────────────────────

export async function waitForPocketBaseHealth(
  publicUrl: string,
  timeoutMs = 120_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${publicUrl}/api/health`, {
        signal: AbortSignal.timeout(3000),
      })
      if (res.ok) return
    } catch { /* keep waiting */ }
    await new Promise((r) => setTimeout(r, 3000))
  }
  throw new Error(
    `PocketBase at ${publicUrl} did not become healthy within ${timeoutMs / 1000}s`
  )
}

export function extractPocketBaseHostname(dockerHost?: string): string {
  if (!dockerHost) return MULTI_HEAD_HOST
  try {
    return new URL(dockerHost).hostname || MULTI_HEAD_HOST
  } catch {
    return MULTI_HEAD_HOST
  }
}

// ── Embedded lifecycle (plain docker run, no Compose project) ─────────────────

/** Container name for an embedded PocketBase instance. */
export function embeddedPocketBaseContainerName(ref: string): string {
  return `pb-${ref}`
}

/** Docker-managed volume name for an embedded PocketBase instance. */
export function embeddedPocketBaseVolumeName(ref: string): string {
  return `pb-${ref}-data`
}

/**
 * Launches a PocketBase container with `docker run` — no Compose stack, no stack
 * directory.  Equivalent to Supabase embedded mode: the existing Docker daemon is
 * reused but no new Compose project is created.
 */
export async function launchEmbeddedPocketBase(opts: {
  ref: string
  pocketbasePort: number
  credentials: PocketBaseCredentials
  dockerHost?: string
}): Promise<void> {
  const containerName = embeddedPocketBaseContainerName(opts.ref)
  const volumeName = embeddedPocketBaseVolumeName(opts.ref)
  const env = buildDockerEnv(opts.dockerHost)

  const result = spawnSync(
    'docker',
    [
      'run', '-d',
      '--name', containerName,
      '--restart', 'unless-stopped',
      '-p', `${opts.pocketbasePort}:8090`,
      '-v', `${volumeName}:/pb_data`,
      '-e', `PB_SUPERUSER_EMAIL=${opts.credentials.adminEmail}`,
      '-e', `PB_SUPERUSER_PASSWORD=${opts.credentials.adminPassword}`,
      'ghcr.io/pocketbase/pocketbase:latest',
    ],
    { env, timeout: 120_000, encoding: 'utf-8' }
  )

  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`docker run failed:\n${result.stderr || result.stdout}`)
  }
}

/**
 * Stops and removes the embedded PocketBase container and its data volume.
 */
export function teardownEmbeddedPocketBase(ref: string, dockerHost?: string): void {
  const containerName = embeddedPocketBaseContainerName(ref)
  const volumeName = embeddedPocketBaseVolumeName(ref)
  const env = buildDockerEnv(dockerHost)

  spawnSync('docker', ['stop', containerName], { env, timeout: 30_000, encoding: 'utf-8' })
  spawnSync('docker', ['rm', containerName], { env, timeout: 30_000, encoding: 'utf-8' })
  spawnSync('docker', ['volume', 'rm', volumeName], { env, timeout: 30_000, encoding: 'utf-8' })
}
