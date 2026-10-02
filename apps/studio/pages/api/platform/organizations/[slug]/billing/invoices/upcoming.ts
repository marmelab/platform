import { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'

export default (req: NextApiRequest, res: NextApiResponse) => apiWrapper(req, res, handler)

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { method } = req

  switch (method) {
    case 'GET':
      return handleGet(req, res)
    default:
      res.setHeader('Allow', ['GET'])
      res.status(405).json({ data: null, error: { message: `Method ${method} Not Allowed` } })
  }
}

const handleGet = async (_req: NextApiRequest, res: NextApiResponse) => {
  return res.status(200).json({
    amount_projected: 0,
    amount_total: 0,
    currency: 'usd',
    customer_balance: 0,
    subscription_id: '',
    billing_cycle_end: new Date().toISOString(),
    billing_cycle_start: new Date().toISOString(),
    lines: [],
  })
}
