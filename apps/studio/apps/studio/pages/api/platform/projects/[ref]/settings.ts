import { components } from 'api-types'
import { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import { getStoredProjectByRef } from '@/lib/api/self-hosted/projectsStore'
import { getProjectSettings } from '@/lib/api/self-hosted/settings'
import { PROJECT_ENDPOINT, PROJECT_ENDPOINT_PROTOCOL } from '@/lib/constants/api'

type ProjectAppConfig = components['schemas']['ProjectSettingsResponse']['app_config'] & {
  protocol?: string
}
export type ProjectSettings = components['schemas']['ProjectSettingsResponse'] & {
  app_config?: ProjectAppConfig
}

export default (req: NextApiRequest, res: NextApiResponse) => apiWrapper(req, res, handler)

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { method } = req

  switch (method) {
    case 'GET':
      return handleGetAll(req, res)
    default:
      res.setHeader('Allow', ['GET'])
      res.status(405).json({ data: null, error: { message: `Method ${method} Not Allowed` } })
  }
}

const handleGetAll = async (req: NextApiRequest, res: NextApiResponse) => {
  const ref = req.query.ref as string
  const project = getStoredProjectByRef(ref)

  // Default project uses env-based settings
  if (!project || ref === 'default') {
    return res.status(200).json(getProjectSettings())
  }

  // Derive endpoint parts from the stored public_url
  let endpoint = PROJECT_ENDPOINT
  let endpointProtocol = PROJECT_ENDPOINT_PROTOCOL
  try {
    const url = new URL(project.public_url)
    endpoint = url.host
    endpointProtocol = url.protocol.replace(':', '')
  } catch {
    // fall back to defaults
  }

  // Support both old schema (db_host/db_port/db_user/db_name) and new schema (postgres_port)
  const multiHeadHost = process.env.MULTI_HEAD_HOST || 'localhost'
  const dbHost = project.db_host || multiHeadHost
  const dbPort = project.postgres_port ?? project.db_port ?? 5432
  const dbUser = project.db_user || 'postgres'
  const dbName = project.db_name || 'postgres'

  const response = {
    app_config: {
      db_schema: 'public',
      endpoint,
      storage_endpoint: endpoint,
      protocol: endpointProtocol,
    },
    cloud_provider: 'AWS',
    db_dns_name: '-',
    db_host: dbHost,
    db_ip_addr_config: 'legacy' as const,
    db_name: dbName,
    db_port: dbPort,
    db_user: dbUser,
    inserted_at: project.inserted_at,
    jwt_secret: project.jwt_secret,
    name: project.name,
    ref: project.ref,
    region: project.region,
    service_api_keys: [
      {
        api_key: project.service_key,
        name: 'service_role key',
        tags: 'service_role',
      },
      {
        api_key: project.anon_key,
        name: 'anon key',
        tags: 'anon',
      },
    ],
    ssl_enforced: false,
    status: project.status,
  } satisfies ProjectSettings

  return res.status(200).json(response)
}
