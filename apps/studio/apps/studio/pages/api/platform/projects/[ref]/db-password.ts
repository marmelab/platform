import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import type { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import { getStoredProjectByRef, updateProjectFields } from '@/lib/api/self-hosted/projectsStore'
import { findDbContainer } from '@/lib/api/self-hosted/migrationRunner'

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

function getStacksDir() {
  const DATA_DIR = process.env.STUDIO_DATA_DIR ?? path.join(process.cwd(), '.studio-data')
  return path.join(DATA_DIR, 'stacks')
}

export default (req: NextApiRequest, res: NextApiResponse) => apiWrapper(req, res, handler)

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { method } = req

  switch (method) {
    case 'PATCH':
      return handlePatch(req, res)
    default:
      res.setHeader('Allow', ['PATCH'])
      res.status(405).json({ data: null, error: { message: `Method ${method} Not Allowed` } })
  }
}

async function handlePatch(req: NextApiRequest, res: NextApiResponse) {
  const ref = req.query.ref as string
  const { password } = req.body as { password?: string }

  if (!password || password.length < 8) {
    return res.status(400).json({ error: { message: 'Password must be at least 8 characters' } })
  }

  const project = getStoredProjectByRef(ref)
  if (!project) {
    return res.status(404).json({ error: { message: 'Project not found' } })
  }

  if (!project.docker_project) {
    return res.status(400).json({
      error: { message: 'Password reset is only supported for Docker-managed projects' },
    })
  }

  const container = findDbContainer(project.docker_project, project.docker_host)
  if (!container) {
    return res.status(503).json({
      error: { message: 'Postgres container is not running. Start the project first.' },
    })
  }

  // Escape single quotes in the password for psql
  const escaped = password.replace(/'/g, "''")
  const result = spawnSync(
    'docker',
    ['exec', container, 'psql', '-U', 'postgres', '-c', `ALTER USER postgres WITH PASSWORD '${escaped}'`],
    { encoding: 'utf-8', timeout: 15_000, env: buildDockerEnv(project.docker_host) }
  )

  if (result.error) {
    return res.status(500).json({ error: { message: result.error.message } })
  }
  if (result.status !== 0) {
    return res.status(500).json({
      error: { message: result.stderr || result.stdout || 'docker exec failed' },
    })
  }

  // Update POSTGRES_PASSWORD in the stack .env file so future `docker compose up` picks it up
  const envFile = path.join(getStacksDir(), ref, '.env')
  if (fs.existsSync(envFile)) {
    const contents = fs.readFileSync(envFile, 'utf-8')
    const updated = contents.replace(/^POSTGRES_PASSWORD=.*/m, `POSTGRES_PASSWORD=${password}`)
    fs.writeFileSync(envFile, updated, 'utf-8')
  }

  // Persist new password in projectsStore
  updateProjectFields(ref, { db_password: password })

  return res.status(200).json({ message: 'Database password updated successfully' })
}
