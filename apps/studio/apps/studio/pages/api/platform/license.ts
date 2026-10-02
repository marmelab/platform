import { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import {
  activateLicenseKey,
  deactivateLicense,
  getLicenseStatus,
} from '@/lib/api/self-hosted/licenseManager'

export default (req: NextApiRequest, res: NextApiResponse) => apiWrapper(req, res, handler)

async function handler(req: NextApiRequest, res: NextApiResponse) {
  switch (req.method) {
    case 'GET':
      return res.status(200).json(getLicenseStatus())

    case 'PATCH': {
      const { key } = req.body as { key?: string }
      if (!key || typeof key !== 'string' || key.trim() === '') {
        return res.status(400).json({ data: null, error: { message: 'key is required' } })
      }
      const error = await activateLicenseKey(key.trim())
      if (error) {
        return res.status(422).json({ data: null, error: { message: error } })
      }
      return res.status(200).json(getLicenseStatus())
    }

    case 'DELETE':
      deactivateLicense()
      return res.status(200).json(getLicenseStatus())

    default:
      res.setHeader('Allow', ['GET', 'PATCH', 'DELETE'])
      return res.status(405).json({ data: null, error: { message: `Method ${req.method} Not Allowed` } })
  }
}
