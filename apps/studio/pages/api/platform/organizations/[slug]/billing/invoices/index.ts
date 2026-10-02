import { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'

export default (req: NextApiRequest, res: NextApiResponse) => apiWrapper(req, res, handler)

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { method } = req

  switch (method) {
    case 'GET':
      return handleGet(req, res)
    case 'HEAD':
      return handleHead(req, res)
    default:
      res.setHeader('Allow', ['GET', 'HEAD'])
      res.status(405).json({ data: null, error: { message: `Method ${method} Not Allowed` } })
  }
}

const handleGet = async (_req: NextApiRequest, res: NextApiResponse) => {
  return res.status(200).json({ data: [], total: 0 })
}

const handleHead = async (_req: NextApiRequest, res: NextApiResponse) => {
  res.setHeader('X-Total-Count', '0')
  return res.status(200).end()
}
