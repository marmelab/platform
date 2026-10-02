import { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import { importStoredProject } from '@/lib/api/self-hosted/projectsStore'

export default (req: NextApiRequest, res: NextApiResponse) => apiWrapper(req, res, handler)

/**
 * POST /api/platform/projects/import
 *
 * Registers an EXISTING Supabase self-hosted deployment as a project in multi-head Studio
 * without spawning any Docker containers.
 *
 * Two connection modes:
 *
 * 1. Same-host stack (running on this Docker host, different ports):
 *    {
 *      name, public_url, db_password, anon_key, service_key, jwt_secret,
 *      kong_http_port, postgres_port, pooler_port, pooler_tenant_id
 *    }
 *
 * 2. Remote/external stack (different host):
 *    {
 *      name, public_url, db_password, anon_key, service_key, jwt_secret,
 *      db_host, db_port, db_user, db_name
 *    }
 */
async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST'])
    return res.status(405).json({ data: null, error: { message: `Method ${req.method} Not Allowed` } })
  }

  const {
    name,
    organization_slug,
    public_url,
    db_password,
    anon_key,
    service_key,
    jwt_secret,
    // Same-host fields
    kong_http_port,
    postgres_port,
    pooler_port,
    pooler_tenant_id,
    docker_project,
    // Remote fields
    db_host,
    db_port,
    db_user,
    db_name,
  } = req.body as Record<string, string | number | undefined>

  // ── Validation ───────────────────────────────────────────────────────────

  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ data: null, error: { message: 'name is required' } })
  }
  if (!public_url || typeof public_url !== 'string') {
    return res.status(400).json({ data: null, error: { message: 'public_url is required' } })
  }
  if (!anon_key || typeof anon_key !== 'string') {
    return res.status(400).json({ data: null, error: { message: 'anon_key is required' } })
  }
  if (!service_key || typeof service_key !== 'string') {
    return res.status(400).json({ data: null, error: { message: 'service_key is required' } })
  }
  if (!jwt_secret || typeof jwt_secret !== 'string') {
    return res.status(400).json({ data: null, error: { message: 'jwt_secret is required' } })
  }

  // Must provide at least one connection mode
  const hasSameHost = kong_http_port !== undefined
  const hasRemote = db_host !== undefined
  if (!hasSameHost && !hasRemote) {
    return res.status(400).json({
      data: null,
      error: {
        message:
          'Provide either kong_http_port (same-host stack) or db_host + db_port + db_user + db_name (remote stack)',
      },
    })
  }

  // ── Register ─────────────────────────────────────────────────────────────

  const project = importStoredProject({
    name: (name as string).trim(),
    ...(organization_slug !== undefined && { organization_slug: String(organization_slug) }),
    public_url: public_url as string,
    db_password: (db_password as string) ?? '',
    anon_key: anon_key as string,
    service_key: service_key as string,
    jwt_secret: jwt_secret as string,
    // Same-host
    ...(kong_http_port !== undefined && { kong_http_port: Number(kong_http_port) }),
    ...(postgres_port !== undefined && { postgres_port: Number(postgres_port) }),
    ...(pooler_port !== undefined && { pooler_port: Number(pooler_port) }),
    ...(pooler_tenant_id !== undefined && { pooler_tenant_id: String(pooler_tenant_id) }),
    ...(docker_project !== undefined && { docker_project: String(docker_project) }),
    // Remote
    ...(db_host !== undefined && { db_host: String(db_host) }),
    ...(db_port !== undefined && { db_port: Number(db_port) }),
    ...(db_user !== undefined && { db_user: String(db_user) }),
    ...(db_name !== undefined && { db_name: String(db_name) }),
  })

  return res.status(201).json({
    id: project.id,
    ref: project.ref,
    name: project.name,
    organization_id: project.organization_id,
    cloud_provider: project.cloud_provider,
    status: project.status,
    region: project.region,
    inserted_at: project.inserted_at,
    public_url: project.public_url,
  })
}
