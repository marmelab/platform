import type { NextRequest } from 'next/server'

import { canAccess, PLATFORM_MODE, verifyIdentity } from './identity'

const REF_PATH =
  /^\/(?:api\/platform\/(?:pg-meta|auth|storage|database|projects|props\/project)|api\/v1\/projects|project|_next\/data\/[^/]+\/project)\/([^/]+?)(?:\.json)?(?:\/|$)/

// Fork features that provision, import or reconfigure projects outside the control plane, or ignore the ref
const DENIED: Array<{ path: RegExp; methods?: string[] }> = [
  { path: /^\/api\/self-hosted(\/|$)/ },
  { path: /^\/api\/platform\/projects\/import$/ },
  { path: /^\/api\/platform\/license(\/|$)/ },
  { path: /^\/api\/(mcp|edge-functions)(\/|$)/ },
  { path: /^\/api\/platform\/projects$/, methods: ['POST'] },
  { path: /^\/api\/platform\/projects\/[^/]+$/, methods: ['PATCH', 'DELETE'] },
  {
    path: /^\/api\/platform\/projects\/[^/]+\/(failover|cluster-failover|replica|standby|migrate|pocketbase-migrate|db-password)(\/|$)/,
  },
  { path: /^\/api\/v1\/projects\/[^/]+\/functions(\/|$)/ },
  { path: /^\/api\/platform\/organizations(\/|$)/, methods: ['POST', 'PUT', 'PATCH', 'DELETE'] },
]

const json = (status: number, message: string) =>
  Response.json({ error: { message } }, { status })

const unsafePath = (path: string) =>
  /\\|\/\/|%2e|%2f|%5c|%00/i.test(path) || path.split('/').some((s) => s === '.' || s === '..')

/** Second barrier behind the control plane's forward auth: signed identity, project ref, denied features. */
export async function platformGuard(request: NextRequest): Promise<Response | undefined> {
  if (!PLATFORM_MODE) return undefined
  const identity = await verifyIdentity((name) => request.headers.get(name))
  if (!identity) return json(401, 'Unauthorized: missing or invalid platform identity')

  const path = request.nextUrl.pathname
  if (unsafePath(path)) return json(400, 'Malformed path')
  const method = request.method.toUpperCase()
  if (DENIED.some((d) => d.path.test(path) && (!d.methods || d.methods.includes(method)))) {
    return json(403, 'Not available on this platform')
  }
  const ref = REF_PATH.exec(path)?.[1]
  const placeholder = ref === '_' && path.startsWith('/project/')
  if (ref !== undefined && !placeholder && !canAccess(identity, ref)) {
    return json(403, `No access to project "${ref}"`)
  }
  return undefined
}
