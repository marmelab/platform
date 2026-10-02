import { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import { requireTier } from '@/lib/api/self-hosted/licenseManager'
import { triggerFailover } from '@/lib/api/self-hosted/failoverManager'
import { getStoredProjectByRef } from '@/lib/api/self-hosted/projectsStore'

export default (req: NextApiRequest, res: NextApiResponse) => apiWrapper(req, res, handler)

/**
 * POST /api/platform/projects/{ref}/failover
 *
 * Manually triggers a failover from primary to its standby.
 * Use for planned maintenance, testing failover paths, or when the primary
 * is degraded but hasn't yet hit the automatic health-check threshold.
 *
 * Returns immediately. The primary entry in the registry is updated
 * synchronously; the old primary stack teardown and new standby provisioning
 * happen in the background.
 */
async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST'])
    return res.status(405).json({ data: null, error: { message: `Method ${req.method} Not Allowed` } })
  }

  const ref = req.query.ref as string

  const license = requireTier('failover')
  if (!license.ok) return res.status(402).json({ data: null, error: { message: license.message } })

  const project = getStoredProjectByRef(ref)
  if (!project) {
    return res.status(404).json({ data: null, error: { message: 'Project not found' } })
  }
  if (project.role === 'standby') {
    return res.status(400).json({ data: null, error: { message: 'Cannot trigger failover on a standby project' } })
  }

  try {
    await triggerFailover(ref)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return res.status(500).json({ data: null, error: { message } })
  }

  // Re-read to return updated state
  const updated = getStoredProjectByRef(ref)
  return res.status(200).json({
    ref,
    public_url: updated?.public_url,
    status: updated?.status,
    failover_count: updated?.failover_count,
    last_failover_at: updated?.last_failover_at,
    message: 'Failover complete. A new standby is being provisioned in the background.',
  })
}
