import { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import { constructHeaders } from '@/lib/api/apiHelpers'
import { listMigrationVersions } from '@/lib/api/self-hosted/migrations'
import { getStoredProjectByRef } from '@/lib/api/self-hosted/projectsStore'

export default (req: NextApiRequest, res: NextApiResponse) => apiWrapper(req, res, handler)

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET'])
    return res.status(405).json({ data: null, error: { message: `Method ${req.method} Not Allowed` } })
  }

  const ref = req.query.ref as string
  const project = getStoredProjectByRef(ref)

  if (!project && ref !== 'default') {
    return res.status(404).json({ data: null, error: { message: 'Project not found' } })
  }

  const { data, error } = await listMigrationVersions({
    headers: constructHeaders(req.headers),
    ref,
  })

  if (error) {
    return res.status(500).json({ data: null, error: { message: error.message } })
  }

  return res.status(200).json({ ref, migrations: data })
}
