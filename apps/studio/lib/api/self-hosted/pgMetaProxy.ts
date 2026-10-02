import { PG_META_URL } from '@/lib/constants'
import { getStoredProjectByRef } from './projectsStore'

export interface PgMetaProxyConfig {
  /** pg-meta base URL to call (e.g. "http://localhost:8020/pg") */
  pgMetaBase: string
  /**
   * Auth headers to send.
   * null  → use constructHeaders(req.headers) (default / legacy path)
   * object → send these directly; bypass constructHeaders to avoid injecting
   *           the wrong SUPABASE_SERVICE_KEY
   */
  projectHeaders: Record<string, string> | null
}

/**
 * Returns the pg-meta base URL and auth headers for a given project ref.
 *
 * Docker-orchestrated projects have their own pg-meta behind Kong —
 * route directly to it with the project's service key, bypassing the
 * default pg-meta and supavisor entirely.
 *
 * Default and legacy projects fall through to the shared PG_META_URL.
 */
export function getPgMetaProxyConfig(ref: string | undefined): PgMetaProxyConfig {
  if (ref && ref !== 'default') {
    const project = getStoredProjectByRef(ref)
    if (project?.kong_http_port && project?.service_key) {
      return {
        pgMetaBase: `http://${process.env.MULTI_HEAD_HOST || 'localhost'}:${project.kong_http_port}/pg`,
        projectHeaders: {
          apikey: project.service_key,
          Authorization: `Bearer ${project.service_key}`,
        },
      }
    }
  }
  return { pgMetaBase: PG_META_URL as string, projectHeaders: null }
}
