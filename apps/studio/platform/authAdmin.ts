import type { NextApiRequest, NextApiResponse } from 'next'

import { projectApi } from './projectApi'

/** The provider the platform manages for company SSO (control plane, configure_auth). */
const COMPANY_PROVIDER = 'custom:company'

const ROUTES: Array<{ path: RegExp; methods: string[] }> = [
  { path: /^oauth\/clients$/, methods: ['GET', 'POST'] },
  { path: /^oauth\/clients\/[\w-]+$/, methods: ['GET', 'PUT', 'DELETE'] },
  { path: /^oauth\/clients\/[\w-]+\/regenerate_secret$/, methods: ['POST'] },
  { path: /^custom-providers$/, methods: ['GET', 'POST'] },
  { path: /^custom-providers\/custom:[\w.-]+$/, methods: ['GET', 'PUT', 'DELETE'] },
]

const reply = (res: NextApiResponse, status: number, code: string, msg: string) =>
  res.status(status).json({ code: status, error_code: code, msg })

/**
 * Same-origin proxy to the app's GoTrue admin API for Studio's OAuth Server apps and custom OAuth providers
 * (./projectClient.ts): forwards an allowed call to the request's project with its service key. The company SSO
 * provider is read-only.
 */
export async function authAdminProxy(req: NextApiRequest, res: NextApiResponse) {
  const method = req.method ?? 'GET'
  const path = ([] as string[]).concat(req.query.path ?? []).join('/')
  const route = ROUTES.find((r) => r.path.test(path))
  if (!route) return reply(res, 404, 'not_found', 'Not available on this platform')
  if (!route.methods.includes(method)) return reply(res, 405, 'method_not_allowed', `Method ${method} Not Allowed`)

  const target =
    method === 'POST' && path === 'custom-providers'
      ? String(req.body?.identifier ?? '')
      : path.split('/')[1] ?? ''
  if (method !== 'GET' && target.toLowerCase() === COMPANY_PROVIDER) {
    return reply(
      res,
      403,
      'platform_managed',
      `${COMPANY_PROVIDER} is the company SSO, managed by the platform: use configure_auth (sso) to change it`
    )
  }

  const { url, serviceKey } = projectApi(req)
  const query = req.url?.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''
  const hasBody = method === 'POST' || method === 'PUT'
  const upstream = await fetch(`${url}/auth/v1/admin/${path}${query}`, {
    method,
    headers: {
      apikey: serviceKey,
      authorization: `Bearer ${serviceKey}`,
      ...(hasBody ? { 'content-type': 'application/json' } : {}),
    },
    body: hasBody ? JSON.stringify(req.body ?? {}) : undefined,
  })
  const text = await upstream.text()
  if (upstream.status === 404 && text.includes('feature_disabled')) {
    return reply(res, 404, 'feature_disabled', 'OAuth Server is not available on this platform')
  }
  res.status(upstream.status)
  const type = upstream.headers.get('content-type')
  if (type) res.setHeader('content-type', type)
  res.end(text)
}
