import type { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import { projectApi } from '@/platform/projectApi'

// Same-origin TUS endpoint for the storage explorer's uploads: the browser never holds a key of the app, Studio's
// server adds the project's service key and streams the request to the app's Storage (resumable uploads).
export const config = { api: { bodyParser: false, responseLimit: false } }

const REQUEST_HEADERS = [
  'tus-resumable',
  'upload-length',
  'upload-metadata',
  'upload-offset',
  'upload-defer-length',
  'upload-concat',
  'content-type',
  'content-length',
  'x-upsert',
  'x-source',
]
const RESPONSE_HEADERS = /^(tus-|upload-|content-type$|cache-control$)/i

export default (req: NextApiRequest, res: NextApiResponse) => apiWrapper(req, res, handler)

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const method = req.method ?? 'GET'
  if (!['POST', 'PATCH', 'HEAD', 'DELETE'].includes(method)) {
    res.setHeader('Allow', ['POST', 'PATCH', 'HEAD', 'DELETE'])
    return res.status(405).json({ error: { message: `Method ${method} Not Allowed` } })
  }
  const ref = String(req.query.ref)
  const id = ([] as string[]).concat(req.query.id ?? []).map(encodeURIComponent).join('/')
  const { url, serviceKey } = projectApi(req)

  const headers: Record<string, string> = { apikey: serviceKey, authorization: `Bearer ${serviceKey}` }
  for (const name of REQUEST_HEADERS) {
    const value = req.headers[name]
    if (typeof value === 'string') headers[name] = value
  }
  const hasBody = method === 'POST' || method === 'PATCH'
  const upstream = await fetch(`${url}/storage/v1/upload/resumable${id ? `/${id}` : ''}`, {
    method,
    headers,
    body: hasBody ? (req as unknown as ReadableStream) : undefined,
    // @ts-expect-error Node's fetch needs it to stream a request body
    duplex: hasBody ? 'half' : undefined,
  })

  upstream.headers.forEach((value, name) => {
    if (RESPONSE_HEADERS.test(name)) res.setHeader(name, value)
  })
  const location = upstream.headers.get('location')
  if (location) {
    const uploadId = location.split('/upload/resumable/')[1]
    if (uploadId) res.setHeader('location', `/api/platform/storage/${ref}/upload/resumable/${uploadId}`)
  }
  res.status(upstream.status)
  res.end(method === 'HEAD' ? undefined : Buffer.from(await upstream.arrayBuffer()))
}
