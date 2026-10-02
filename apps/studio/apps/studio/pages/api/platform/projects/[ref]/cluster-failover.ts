import { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import { requireTier } from '@/lib/api/self-hosted/licenseManager'
import { triggerClusterFailover } from '@/lib/api/self-hosted/clusterManager'
import { getStoredProjectByRef } from '@/lib/api/self-hosted/projectsStore'

export default (req: NextApiRequest, res: NextApiResponse) => apiWrapper(req, res, handler)

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST'])
    return res.status(405).json({ data: null, error: { message: `Method ${req.method} Not Allowed` } })
  }

  const ref = req.query.ref as string

  const license = requireTier('cluster-failover')
  if (!license.ok) return res.status(402).json({ data: null, error: { message: license.message } })

  const project = getStoredProjectByRef(ref)
  if (!project) {
    return res.status(404).json({ data: null, error: { message: 'Project not found' } })
  }
  if (!project.cluster_id) {
    return res.status(400).json({ data: null, error: { message: 'Project is not a cluster master' } })
  }

  try {
    await triggerClusterFailover(ref)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return res.status(500).json({ data: null, error: { message } })
  }

  const updated = getStoredProjectByRef(ref)
  return res.status(200).json({ public_url: updated?.public_url })
}
