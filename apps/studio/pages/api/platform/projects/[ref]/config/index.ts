import { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import { getStoredProjectByRef } from '@/lib/api/self-hosted/projectsStore'

export default (req: NextApiRequest, res: NextApiResponse) => apiWrapper(req, res, handler)

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { method } = req

  switch (method) {
    case 'GET':
      return handleGetAll(req, res)
    case 'PATCH':
      return handlePatch(req, res)
    default:
      res.setHeader('Allow', ['GET', 'PATCH'])
      res.status(405).json({ data: null, error: { message: `Method ${method} Not Allowed` } })
  }
}

const handleGetAll = async (req: NextApiRequest, res: NextApiResponse) => {
  const ref = req.query.ref as string
  const project = getStoredProjectByRef(ref)

  return res.status(200).json({
    db_anon_role: 'anon',
    db_extra_search_path: 'public',
    db_schema: 'public, storage',
    jwt_secret:
      project?.jwt_secret ||
      process.env.AUTH_JWT_SECRET ||
      'super-secret-jwt-token-with-at-least-32-characters-long',
    max_rows: 100,
    role_claim_key: '.role',
  })
}

const handlePatch = async (req: NextApiRequest, res: NextApiResponse) => {
  // PostgREST config updates are managed via environment variables in self-hosted deployments
  return res.status(200).json({})
}
