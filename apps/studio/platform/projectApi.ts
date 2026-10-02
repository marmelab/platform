import { createClient } from '@supabase/supabase-js'
import type { NextApiRequest } from 'next'

import { PLATFORM_MODE } from './identity'
import type { PlatformProject } from './projects'
import { getStoredProjectByRef } from '@/lib/api/self-hosted/projectsStore'

/** Auth/Storage endpoint and service key of the project in the request (`[ref]`), not the global default stack. */
export function projectApi(req: NextApiRequest): { url: string; serviceKey: string } {
  if (!PLATFORM_MODE) {
    return { url: process.env.SUPABASE_URL!, serviceKey: process.env.SUPABASE_SERVICE_KEY! }
  }
  const project = getStoredProjectByRef(String(req.query.ref)) as PlatformProject | undefined
  if (!project) throw new Error(`Project "${req.query.ref}" not found`)
  return { url: project.internal_url ?? project.public_url, serviceKey: project.service_key }
}

export function projectAdminClient(req: NextApiRequest) {
  const { url, serviceKey } = projectApi(req)
  return createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
}
