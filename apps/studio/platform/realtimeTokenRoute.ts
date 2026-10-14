import type { NextApiRequest, NextApiResponse } from 'next'

import { currentIdentity } from './projects'

/** Server: asks the control plane for a token for the request's signed identity and project. */
export async function realtimeTokenRoute(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST'])
    return res.status(405).json({ error: { message: `Method ${req.method} Not Allowed` } })
  }
  const identity = currentIdentity()
  if (!identity) return res.status(404).json({ error: { message: 'Not available without the platform' } })
  const response = await fetch(`${process.env.PLATFORM_CONTROL_PLANE_URL}/internal/studio/realtime-token`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${process.env.PLATFORM_STUDIO_CONFIG_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ user: identity.user, ref: req.query.ref }),
    signal: AbortSignal.timeout(5_000),
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) return res.status(response.status).json({ error: { message: body.error ?? 'refused' } })
  res.setHeader('cache-control', 'no-store')
  return res.status(200).json(body)
}
