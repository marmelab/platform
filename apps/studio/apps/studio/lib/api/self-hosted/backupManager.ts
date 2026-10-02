import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'

import { findDbContainer } from './migrationRunner'
import { getStoredProjects } from './projectsStore'

const DATA_DIR = process.env.STUDIO_DATA_DIR || path.join(/*turbopackIgnore: true*/ process.cwd(), '.studio-data')
const BACKUPS_DIR = path.join(DATA_DIR, 'backups')
const SCHEDULES_FILE = path.join(DATA_DIR, 'backup-schedules.json')

export type BackupSchedule = 'daily' | 'weekly' | 'off'

export interface BackupMeta {
  id: string
  projectRef: string
  filename: string
  sizeBytes: number
  createdAt: string
}

interface ScheduleEntry {
  schedule: BackupSchedule
  lastRunAt?: string
}

type SchedulesMap = Record<string, ScheduleEntry>

function readSchedules(): SchedulesMap {
  try {
    return JSON.parse(fs.readFileSync(SCHEDULES_FILE, 'utf-8'))
  } catch {
    return {}
  }
}

function writeSchedules(map: SchedulesMap): void {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(SCHEDULES_FILE, JSON.stringify(map, null, 2), 'utf-8')
}

function projectDir(projectRef: string): string {
  return path.join(BACKUPS_DIR, projectRef)
}

export function listBackups(projectRef: string): BackupMeta[] {
  const dir = projectDir(projectRef)
  if (!fs.existsSync(dir)) return []

  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.pgdump'))
    .map((f) => {
      const stat = fs.statSync(path.join(dir, f))
      return {
        id: f.replace('.pgdump', ''),
        projectRef,
        filename: f,
        sizeBytes: stat.size,
        createdAt: stat.mtime.toISOString(),
      }
    })
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
}

export function deleteBackup(projectRef: string, filename: string): void {
  const file = path.join(projectDir(projectRef), path.basename(filename))
  if (fs.existsSync(file)) fs.unlinkSync(file)
}

export function getBackupFilePath(projectRef: string, filename: string): string | null {
  const file = path.join(projectDir(projectRef), path.basename(filename))
  return fs.existsSync(file) ? file : null
}

export function getSchedule(projectRef: string): BackupSchedule {
  return readSchedules()[projectRef]?.schedule ?? 'off'
}

export function getLastRunAt(projectRef: string): string | undefined {
  return readSchedules()[projectRef]?.lastRunAt
}

export function setSchedule(projectRef: string, schedule: BackupSchedule): void {
  const map = readSchedules()
  map[projectRef] = { ...map[projectRef], schedule }
  writeSchedules(map)
}

function buildDockerEnv(dockerHost?: string): NodeJS.ProcessEnv {
  const env = {} as NodeJS.ProcessEnv
  for (const key of [
    'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'TMPDIR', 'TMP', 'TEMP',
    'DOCKER_HOST', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH',
  ]) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  if (dockerHost) env['DOCKER_HOST'] = dockerHost
  return env
}

export async function runBackup(
  projectRef: string,
  dockerProject: string,
  dockerHost?: string,
  dbName = 'postgres'
): Promise<BackupMeta> {
  const container = findDbContainer(dockerProject, dockerHost)
  if (!container) {
    throw new Error(`No running postgres container found for project "${dockerProject}". Make sure the project is running.`)
  }

  const id = crypto.randomBytes(6).toString('hex')
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)
  const filename = `${timestamp}_${id}.pgdump`
  const tmpPath = `/tmp/smh-backup-${id}.pgdump`
  const outDir = projectDir(projectRef)
  const outFile = path.join(outDir, filename)

  fs.mkdirSync(outDir, { recursive: true })

  await new Promise<void>((resolve, reject) => {
    const proc = spawn(
      'docker',
      ['exec', container, 'pg_dump', '-Fc', '--no-owner', '--no-acl', '-f', tmpPath, dbName],
      { env: buildDockerEnv(dockerHost), stdio: 'pipe' }
    )
    const errs: string[] = []
    proc.stderr.on('data', (d: Buffer) => errs.push(d.toString()))
    proc.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`pg_dump failed (exit ${code}): ${errs.join('').slice(0, 400)}`))
    })
    proc.on('error', reject)
  })

  await new Promise<void>((resolve, reject) => {
    const proc = spawn('docker', ['cp', `${container}:${tmpPath}`, outFile], {
      env: buildDockerEnv(dockerHost),
      stdio: 'pipe',
    })
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`docker cp failed (exit ${code})`))))
    proc.on('error', reject)
  })

  spawnSync('docker', ['exec', container, 'rm', '-f', tmpPath], {
    env: buildDockerEnv(dockerHost),
    timeout: 5000,
  })

  const stat = fs.statSync(outFile)
  const meta: BackupMeta = {
    id,
    projectRef,
    filename,
    sizeBytes: stat.size,
    createdAt: stat.mtime.toISOString(),
  }

  const map = readSchedules()
  if (map[projectRef]) {
    map[projectRef].lastRunAt = new Date().toISOString()
    writeSchedules(map)
  }

  return meta
}

export async function runRestore(
  projectRef: string,
  filename: string,
  dockerProject: string,
  dockerHost?: string,
  dbName = 'postgres'
): Promise<void> {
  const container = findDbContainer(dockerProject, dockerHost)
  if (!container) {
    throw new Error(`No running postgres container found for project "${dockerProject}". Make sure the project is running.`)
  }

  const hostFile = getBackupFilePath(projectRef, filename)
  if (!hostFile) throw new Error('Backup file not found')

  const safeId = crypto.randomBytes(4).toString('hex')
  const tmpPath = `/tmp/smh-restore-${safeId}.pgdump`

  // Copy dump file into container
  await new Promise<void>((resolve, reject) => {
    const proc = spawn('docker', ['cp', hostFile, `${container}:${tmpPath}`], {
      env: buildDockerEnv(dockerHost),
      stdio: 'pipe',
    })
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`docker cp failed (exit ${code})`))))
    proc.on('error', reject)
  })

  try {
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(
        'docker',
        [
          'exec', container,
          'pg_restore', '--verbose', '--no-owner', '--no-acl', '--if-exists', '--clean',
          '-U', 'postgres', '-d', dbName,
          tmpPath,
        ],
        { env: buildDockerEnv(dockerHost), stdio: 'pipe' }
      )
      const errs: string[] = []
      proc.stderr.on('data', (d: Buffer) => errs.push(d.toString()))
      proc.on('close', (code) => {
        // exit 1 with --clean --if-exists is expected on a fresh DB; treat it as success
        if (code === 0 || code === 1) resolve()
        else reject(new Error(`pg_restore failed (exit ${code}): ${errs.join('').slice(0, 400)}`))
      })
      proc.on('error', reject)
    })
  } finally {
    spawnSync('docker', ['exec', container, 'rm', '-f', tmpPath], {
      env: buildDockerEnv(dockerHost),
      timeout: 5000,
    })
  }
}

export async function runScheduledBackups(): Promise<void> {
  const projects = getStoredProjects()
  const map = readSchedules()
  const now = new Date()

  for (const project of projects) {
    const entry = map[project.ref]
    if (!entry || entry.schedule === 'off' || !project.docker_project) continue

    const last = entry.lastRunAt ? new Date(entry.lastRunAt) : null
    const msElapsed = last ? now.getTime() - last.getTime() : Infinity
    const threshold = entry.schedule === 'daily' ? 24 * 3600 * 1000 : 7 * 24 * 3600 * 1000

    if (msElapsed >= threshold) {
      try {
        await runBackup(project.ref, project.docker_project, project.docker_host)
      } catch {
        // non-fatal — log nothing to avoid polluting server output
      }
    }
  }
}
