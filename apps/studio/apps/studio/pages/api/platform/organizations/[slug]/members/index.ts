import { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import { addOrgMember, getOrgMembers } from '@/lib/api/self-hosted/membersStore'

export default (req: NextApiRequest, res: NextApiResponse) => apiWrapper(req, res, handler)

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { slug } = req.query as { slug: string }

  if (req.method === 'GET') {
    return res.status(200).json(getOrgMembers(slug))
  }

  res.setHeader('Allow', ['GET'])
  res.status(405).json({ data: null, error: { message: `Method ${req.method} Not Allowed` } })
}
