import * as Sentry from '@sentry/nextjs'

import { constructHeaders } from '../apiHelpers'
import { databaseErrorSchema, PgMetaDatabaseError, WrappedResult } from './types'
import { assertSelfHosted, encryptString } from './util'
import { getStoredProjectByRef } from './projectsStore'
import { PG_META_URL } from '@/lib/constants/index'
import { getPgMetaProxyConfig } from './pgMetaProxy'

export type QueryOptions = {
  query: string
  parameters?: unknown[]
  readOnly?: boolean
  headers?: HeadersInit
  /** Project ref — when provided, uses that project's stored connection details */
  ref?: string
}

/**
 * Executes a SQL query against a Postgres instance via the pg-meta service.
 *
 * Routing strategy
 * ─────────────────
 * Default project (ref === 'default' or no ref):
 *   Calls PG_META_URL directly. pg-meta uses its own PG_META_DB_* env vars to connect.
 *
 * Docker-orchestrated projects (kong_http_port set):
 *   Calls the project's own pg-meta via its Kong: http://{MULTI_HEAD_HOST}:{kongPort}/pg
 *   Authenticates with the project's service key (apikey + Authorization headers).
 *   This avoids routing through supavisor, which fails SCRAM-SHA-256 auth on external connections.
 *
 * Legacy manual-connection projects (db_host set, no kong_http_port):
 *   Calls the default PG_META_URL with an x-connection-encrypted header containing
 *   an AES-encrypted connection string for the user-supplied host/port.
 *   Requires PG_META_CRYPTO_KEY to match CRYPTO_KEY in the default pg-meta container.
 *
 * _Only call this from server-side self-hosted code._
 */
export async function executeQuery<T = unknown>({
  query,
  parameters,
  readOnly = false,
  headers,
  ref,
}: QueryOptions): Promise<WrappedResult<T[]>> {
  assertSelfHosted()

  if (!PG_META_URL) {
    return {
      data: undefined,
      error: new Error(
        'pg-meta URL is not configured. Set STUDIO_PG_META_URL in your .env file.'
      ),
    }
  }

  // pgMetaBase: which pg-meta URL to call for this request
  // connectionHeaders: additional headers (x-connection-encrypted or Kong auth)
  let pgMetaBase = PG_META_URL
  let connectionHeaders: Record<string, string> = {}

  if (ref && ref !== 'default') {
    const project = getStoredProjectByRef(ref)
    if (project) {
      if (project.kong_http_port) {
        // Docker-orchestrated project: each stack has its own pg-meta exposed behind
        // Kong on {MULTI_HEAD_HOST}:{kongPort}/pg. Route directly — no x-connection-encrypted
        // needed (avoids supavisor SCRAM-SHA-256 auth issues on external connections).
        const config = getPgMetaProxyConfig(ref)
        if (config.projectHeaders) {
          pgMetaBase = config.pgMetaBase
          connectionHeaders = config.projectHeaders
        }
      } else if (project.db_host) {
        // Legacy manual-connection project: use default pg-meta with an encrypted
        // connection string header pointing at the user-supplied host/port.
        const connStr = `postgresql://${project.db_user || 'postgres'}:${project.db_password}@${project.db_host}:${project.db_port ?? 5432}/${project.db_name || 'postgres'}`
        connectionHeaders = { 'x-connection-encrypted': encryptString(connStr) }
      }
    }
    // If project not found, fall through — pgMetaBase stays as PG_META_URL (default DB)
  }

  const requestBody: { query: string; parameters?: unknown[] } = { query }
  if (parameters !== undefined) {
    requestBody.parameters = parameters
  }

  return await Sentry.startSpan({ name: 'pg-meta.query', op: 'db.query' }, async (span) => {
    let response: Response
    try {
      // For Docker-orchestrated projects we call the project's own Kong directly.
      // Bypass constructHeaders (which injects the default SUPABASE_SERVICE_KEY and
      // strips our apikey header), and send a clean auth-only set instead.
      const requestHeaders =
        pgMetaBase !== PG_META_URL
          ? { 'Content-Type': 'application/json', ...connectionHeaders }
          : constructHeaders({
              ...headers,
              'Content-Type': 'application/json',
              ...connectionHeaders,
            })

      response = await fetch(`${pgMetaBase}/query`, {
        method: 'POST',
        headers: requestHeaders,
        body: JSON.stringify(requestBody),
      })
    } catch (fetchError) {
      span.setAttribute('db.error', 1)
      const message =
        fetchError instanceof Error
          ? `Cannot reach pg-meta at ${pgMetaBase}: ${fetchError.message}`
          : `Cannot reach pg-meta at ${pgMetaBase}`
      return { data: undefined, error: new Error(message) }
    }

    let result: unknown
    try {
      result = await response.json()
    } catch {
      span.setAttribute('db.error', 1)
      return {
        data: undefined,
        error: new Error(`pg-meta returned non-JSON response (HTTP ${response.status})`),
      }
    }

    if (!response.ok) {
      span.setAttribute('db.error', 1)
      span.setAttribute('db.status_code', response.status)

      // pg-meta returns two different error shapes depending on the failure type:
      //   SQL/DB errors:        { message, code, formattedError }
      //   Connection errors:    { error: "failed to get upstream connection details" }
      const parsed = databaseErrorSchema.safeParse(result)
      if (parsed.success) {
        const { message, code, formattedError } = parsed.data
        return { data: undefined, error: new PgMetaDatabaseError(message, code, response.status, formattedError) }
      }

      // Non-standard error shape — extract whatever message we can
      const raw = result as Record<string, unknown>
      const message =
        typeof raw?.error === 'string'
          ? raw.error
          : typeof raw?.message === 'string'
            ? raw.message
            : `pg-meta error (HTTP ${response.status})`
      return {
        data: undefined,
        error: new PgMetaDatabaseError(message, String(response.status), response.status, message),
      }
    }

    span.setAttribute('db.status_code', response.status)
    return { data: result as T[], error: undefined }
  })
}
