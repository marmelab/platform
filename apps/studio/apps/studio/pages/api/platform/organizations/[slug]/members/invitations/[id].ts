import { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'

export default (req: NextApiRequest, res: NextApiResponse) => apiWrapper(req, res, handler)

async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Self-hosted: invitations are applied immediately as members so there are no pending
  // invitations to delete. Return 200 for compatibility with the UI flow.
  if (req.method === 'DELETE') {
    return res.status(200).json({ message: 'ok' })
  }

  res.setHeader('Allow', ['DELETE'])
  res.status(405).json({ data: null, error: { message: `Method ${req.method} Not Allowed` } })
}
