import { NextApiRequest, NextApiResponse } from 'next'

import { getPgMetaRedirectUrl } from './tables'
import { fetchGet } from '@/data/fetchers'
import { constructHeaders } from '@/lib/api/apiHelpers'
import apiWrapper from '@/lib/api/apiWrapper'
import { getPgMetaProxyConfig } from '@/lib/api/self-hosted/pgMetaProxy'

export default (req: NextApiRequest, res: NextApiResponse) =>
  apiWrapper(req, res, handler, { withAuth: true })

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { method } = req

  switch (method) {
    case 'GET':
      return handleGetAll(req, res)
    default:
      res.setHeader('Allow', ['GET'])
      res.status(405).json({ error: { message: `Method ${method} Not Allowed` } })
  }
}

const handleGetAll = async (req: NextApiRequest, res: NextApiResponse) => {
  const ref = req.query.ref as string
  const { pgMetaBase, projectHeaders } = getPgMetaProxyConfig(ref)
  const headers = projectHeaders ?? constructHeaders(req.headers)
  const response = await fetchGet(getPgMetaRedirectUrl(req, 'foreign-tables', pgMetaBase), { headers })

  if (response.error) {
    const { code, message } = response.error
    return res.status(code).json({ message })
  } else {
    return res.status(200).json(response)
  }
}
