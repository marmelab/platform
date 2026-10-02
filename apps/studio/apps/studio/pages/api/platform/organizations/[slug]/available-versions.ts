import { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'

export default (req: NextApiRequest, res: NextApiResponse) => apiWrapper(req, res, handler)

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === 'POST') return res.status(200).json([])
  res.setHeader('Allow', ['POST'])
  res.status(405).json({ data: null, error: { message: `Method ${req.method} Not Allowed` } })
}
