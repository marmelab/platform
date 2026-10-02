import { paths } from 'api-types'
import { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import { getStoredProjectByRef } from '@/lib/api/self-hosted/projectsStore'

export default (req: NextApiRequest, res: NextApiResponse) => apiWrapper(req, res, handler)

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { method } = req

  switch (method) {
    case 'GET':
      return handleGet(req, res)
    default:
      res.setHeader('Allow', ['GET'])
      res.status(405).json({ data: null, error: { message: `Method ${method} Not Allowed` } })
  }
}

type ResponseData =
  paths['/platform/projects/{ref}/databases']['get']['responses']['200']['content']['application/json']

const handleGet = async (req: NextApiRequest, res: NextApiResponse<ResponseData>) => {
  const ref = req.query.ref as string
  const project = getStoredProjectByRef(ref)

  if (!project) {
    return res.status(200).json([])
  }

  const multiHeadHost = process.env.MULTI_HEAD_HOST || 'localhost'
  const dbHost = project.db_host || multiHeadHost
  const dbPort = project.postgres_port ?? project.db_port ?? 5432
  const dbUser = project.db_user || 'postgres'
  const dbName = project.db_name || 'postgres'

  return res.status(200).json([
    {
      cloud_provider: 'localhost' as any,
      connectionString: '',
      connection_string_read_only: '',
      db_host: dbHost,
      db_name: dbName,
      db_port: dbPort,
      db_user: dbUser,
      identifier: project.ref,
      inserted_at: project.inserted_at,
      region: project.region,
      restUrl: project.public_url,
      size: '',
      status: project.status as any,
    },
  ])
}
