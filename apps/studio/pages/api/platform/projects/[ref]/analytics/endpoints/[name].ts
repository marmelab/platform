import { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import { retrieveAnalyticsData } from '@/lib/api/self-hosted/logs'
import { PROJECT_ANALYTICS_URL } from '@/lib/constants/api'

export default (req: NextApiRequest, res: NextApiResponse) => apiWrapper(req, res, handler)

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { method } = req

  switch (method) {
    case 'GET':
    case 'POST':
      const { name, ref, ...queryToForward } = req.query
      const params = req.method === 'GET' ? queryToForward : req.body

      if (typeof ref !== 'string' || typeof name !== 'string') {
        return res.status(400).json({ error: { message: 'Invalid or missing ref or name parameter' } })
      }

      if (!PROJECT_ANALYTICS_URL || !process.env.LOGFLARE_PRIVATE_ACCESS_TOKEN) {
        // Analytics env vars not configured — return empty result set
        return res.status(200).json({ result: [] })
      }

      const { data, error } = await retrieveAnalyticsData({
        name,
        params,
        projectRef: ref,
      })

      if (data) {
        return res.status(200).json(data)
      } else {
        return res.status(500).json({ error: { message: error.message } })
      }
    default:
      res.setHeader('Allow', ['GET', 'POST'])
      res.status(405).json({ data: null, error: { message: `Method ${method} Not Allowed` } })
  }
}
