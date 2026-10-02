/**
 * Returns GoTrue's /settings response so the client can know which
 * OAuth providers are enabled without exposing the service key.
 */
import type { NextApiRequest, NextApiResponse } from 'next'

const GOTRUE_URL =
  process.env.STUDIO_GOTRUE_URL ||
  process.env.NEXT_PUBLIC_GOTRUE_URL ||
  'http://localhost:8000/auth/v1'

const SERVICE_KEY = process.env.STUDIO_GOTRUE_SERVICE_KEY || ''

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET'])
    return res.status(405).end()
  }

  try {
    const r = await fetch(`${GOTRUE_URL}/settings`, {
      headers: {
        Authorization: `Bearer ${SERVICE_KEY}`,
        apikey: SERVICE_KEY,
      },
    })
    const data = await r.json()
    res.setHeader('Cache-Control', 'public, max-age=60')
    return res.status(r.status).json(data)
  } catch {
    return res.status(502).json({ error: 'GoTrue unreachable' })
  }
}
