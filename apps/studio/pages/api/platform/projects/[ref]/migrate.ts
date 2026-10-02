import { NextApiRequest, NextApiResponse } from 'next'
import apiWrapper from '@/lib/api/apiWrapper'
import { getStoredProjectByRef } from '@/lib/api/self-hosted/projectsStore'
import {
  startMigration,
  resumeMigration,
  getJob,
  listInterruptedJobs,
  findDbContainer,
  dumpFileExists,
} from '@/lib/api/self-hosted/migrationRunner'

export default (req: NextApiRequest, res: NextApiResponse) => apiWrapper(req, res, handler)

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const ref = req.query.ref as string

  if (req.method === 'GET') {
    // GET ?interrupted=true → list interrupted jobs with dump-file availability
    if (req.query.interrupted === 'true') {
      const project = getStoredProjectByRef(ref)
      const container = project?.docker_project
        ? findDbContainer(project.docker_project, project.docker_host)
        : null

      const interrupted = listInterruptedJobs(ref).map((j) => ({
        id: j.id,
        startedAt: j.startedAt,
        finishedAt: j.finishedAt,
        schemas: j.schemas,
        schemaOnly: j.schemaOnly,
        maskedSourceUrl: j.maskedSourceUrl,
        dumpAvailable: container ? dumpFileExists(j.id, container, project?.docker_host) : false,
      }))
      return res.status(200).json({ interrupted })
    }

    // GET ?job={id} → poll a specific job
    const jobId = req.query.job as string
    if (!jobId) {
      return res.status(400).json({ error: { message: 'Missing ?job= or ?interrupted= query param' } })
    }
    const job = getJob(jobId)
    if (!job || job.targetRef !== ref) {
      return res.status(404).json({ error: { message: 'Job not found' } })
    }
    return res.status(200).json(job)
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', ['GET', 'POST'])
    return res.status(405).json({ error: { message: `Method ${req.method} Not Allowed` } })
  }

  const project = getStoredProjectByRef(ref)
  if (!project) {
    return res.status(404).json({ error: { message: 'Project not found' } })
  }

  if (!project.docker_project) {
    return res.status(400).json({
      error: {
        message:
          'This project does not have an associated Docker stack. ' +
          'Migration is only supported for Docker-orchestrated (stack) projects.',
      },
    })
  }

  if (project.creation_mode === 'embedded') {
    return res.status(400).json({
      error: { message: 'Migration into embedded projects is not yet supported.' },
    })
  }

  const body = (req.body ?? {}) as {
    action?: string
    job_id?: string
    source_db_url?: string
    schemas?: string[]
    schema_only?: boolean
  }

  // POST { action: 'resume', job_id } → resume an interrupted job
  if (body.action === 'resume') {
    const jobId = body.job_id
    if (!jobId) {
      return res.status(400).json({ error: { message: 'job_id is required for resume' } })
    }
    const existing = getJob(jobId)
    if (!existing || existing.targetRef !== ref) {
      return res.status(404).json({ error: { message: 'Job not found' } })
    }
    if (existing.status !== 'interrupted') {
      return res.status(400).json({ error: { message: 'Job is not in interrupted state' } })
    }
    const container = findDbContainer(project.docker_project, project.docker_host)
    if (!container) {
      return res.status(400).json({ error: { message: 'Target container is not running' } })
    }
    if (!dumpFileExists(jobId, container, project.docker_host)) {
      return res.status(400).json({
        error: { message: 'Dump file no longer exists in the container — start a new migration instead' },
      })
    }
    const job = resumeMigration(jobId)
    return res.status(202).json({ job_id: job.id })
  }

  // POST { source_db_url, schemas, schema_only } → start a new migration
  const { source_db_url, schemas = ['public'], schema_only = false } = body

  if (!source_db_url?.trim()) {
    return res.status(400).json({ error: { message: 'source_db_url is required' } })
  }

  const cleanSchemas = (schemas as string[])
    .map((s) => s.trim())
    .filter((s) => /^[a-zA-Z_][a-zA-Z0-9_$]*$/.test(s))

  if (cleanSchemas.length === 0) {
    return res.status(400).json({ error: { message: 'At least one valid schema name is required' } })
  }

  const job = startMigration({
    targetRef: ref,
    targetDockerProject: project.docker_project,
    sourceDbUrl: source_db_url.trim(),
    schemas: cleanSchemas,
    schemaOnly: !!schema_only,
    dockerHost: project.docker_host,
  })

  return res.status(202).json({ job_id: job.id })
}
