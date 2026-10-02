import { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import { getStoredProjectByRef } from '@/lib/api/self-hosted/projectsStore'
import {
  getPBMigrationJob,
  startPBMigration,
  type PBMigDirection,
} from '@/lib/api/self-hosted/pocketbaseMigrationRunner'

export default (req: NextApiRequest, res: NextApiResponse) => apiWrapper(req, res, handler)

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const ref = req.query.ref as string
  const supaProject = getStoredProjectByRef(ref)

  if (!supaProject) {
    return res.status(404).json({ data: null, error: { message: 'Project not found' } })
  }

  switch (req.method) {
    case 'GET':
      return handleGet(req, res)
    case 'POST':
      return handlePost(req, res, ref, supaProject)
    default:
      res.setHeader('Allow', ['GET', 'POST'])
      return res.status(405).json({ data: null, error: { message: `Method ${req.method} Not Allowed` } })
  }
}

function handleGet(req: NextApiRequest, res: NextApiResponse) {
  const jobId = req.query.job as string | undefined
  if (!jobId) {
    return res.status(400).json({ data: null, error: { message: 'Missing ?job= query param' } })
  }
  const job = getPBMigrationJob(jobId)
  if (!job) {
    return res.status(404).json({ data: null, error: { message: 'Migration job not found' } })
  }
  return res.status(200).json(job)
}

async function handlePost(
  req: NextApiRequest,
  res: NextApiResponse,
  ref: string,
  supaProject: ReturnType<typeof getStoredProjectByRef> & {}
) {
  const {
    direction,
    pb_url,
    pb_admin_email,
    pb_admin_password,
  } = req.body as {
    direction: PBMigDirection
    pb_url: string
    pb_admin_email: string
    pb_admin_password: string
  }

  if (!direction || !pb_url || !pb_admin_email || !pb_admin_password) {
    return res.status(400).json({
      data: null,
      error: { message: 'direction, pb_url, pb_admin_email, and pb_admin_password are required' },
    })
  }
  if (direction !== 'pb-to-supa' && direction !== 'supa-to-pb') {
    return res.status(400).json({
      data: null,
      error: { message: 'direction must be "pb-to-supa" or "supa-to-pb"' },
    })
  }

  // Re-read project to get service_key (it's stripped from GET responses)
  const fullProject = getStoredProjectByRef(ref)!
  const supaServiceKey = fullProject.service_key
  const supaPublicUrl = fullProject.public_url

  if (!supaServiceKey) {
    return res.status(400).json({
      data: null,
      error: {
        message:
          'This project has no Supabase service key. ' +
          'Migration requires a running Supabase (non-PocketBase) project as one endpoint.',
      },
    })
  }

  const jobId = startPBMigration({
    direction,
    pbUrl: pb_url.replace(/\/$/, ''),
    pbAdminEmail: pb_admin_email,
    pbAdminPassword: pb_admin_password,
    supaRef: ref,
    supaPublicUrl,
    supaServiceKey,
  })

  return res.status(202).json({ job_id: jobId })
}
