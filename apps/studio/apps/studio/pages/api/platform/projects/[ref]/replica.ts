import { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import { requireTier } from '@/lib/api/self-hosted/licenseManager'
import { provisionReplica, deprovisionReplica } from '@/lib/api/self-hosted/clusterManager'
import { getStoredProjectByRef } from '@/lib/api/self-hosted/projectsStore'

export default (req: NextApiRequest, res: NextApiResponse) => apiWrapper(req, res, handler)

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const ref = req.query.ref as string

  switch (req.method) {
    case 'POST':
      return handleProvision(ref, req, res)
    case 'DELETE':
      return handleDeprovision(ref, req, res)
    default:
      res.setHeader('Allow', ['POST', 'DELETE'])
      return res.status(405).json({ data: null, error: { message: `Method ${req.method} Not Allowed` } })
  }
}

/**
 * POST /api/platform/projects/{ref}/replica
 *
 * Provisions a new read replica for this cluster master.
 * Optional body: { docker_host?: string }
 */
async function handleProvision(masterRef: string, req: NextApiRequest, res: NextApiResponse) {
  const license = requireTier('replica')
  if (!license.ok) return res.status(402).json({ data: null, error: { message: license.message } })

  const project = getStoredProjectByRef(masterRef)
  if (!project) {
    return res.status(404).json({ data: null, error: { message: 'Project not found' } })
  }
  if (project.role === 'replica') {
    return res.status(400).json({ data: null, error: { message: 'Cannot provision a replica for a replica project' } })
  }
  if (project.role === 'standby') {
    return res.status(400).json({ data: null, error: { message: 'Cannot provision a replica for a standby project' } })
  }

  const docker_host = typeof req.body?.docker_host === 'string' ? req.body.docker_host : undefined

  let replicaRef: string
  try {
    replicaRef = await provisionReplica(masterRef, docker_host)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return res.status(500).json({ data: null, error: { message } })
  }

  return res.status(202).json({
    replica_ref: replicaRef,
    status: 'COMING_UP',
    message: 'Replica stack is being provisioned. Poll the replica project status to track progress.',
  })
}

/**
 * DELETE /api/platform/projects/{ref}/replica?replica_ref={replicaRef}
 *
 * Tears down a specific replica and removes it from the cluster.
 */
async function handleDeprovision(masterRef: string, req: NextApiRequest, res: NextApiResponse) {
  const replicaRef = req.query.replica_ref as string | undefined
  if (!replicaRef) {
    return res.status(400).json({ data: null, error: { message: 'replica_ref query parameter is required' } })
  }

  const project = getStoredProjectByRef(masterRef)
  if (!project) {
    return res.status(404).json({ data: null, error: { message: 'Project not found' } })
  }

  try {
    await deprovisionReplica(masterRef, replicaRef)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return res.status(500).json({ data: null, error: { message } })
  }

  return res.status(200).json({ message: 'Replica deprovisioned' })
}
