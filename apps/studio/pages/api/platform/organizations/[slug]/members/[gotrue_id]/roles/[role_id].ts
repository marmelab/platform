import { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import {
  unassignOrgMemberRole,
  updateOrgMemberRoleProjectRefs,
} from '@/lib/api/self-hosted/membersStore'

export default (req: NextApiRequest, res: NextApiResponse) => apiWrapper(req, res, handler)

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { slug, gotrue_id, role_id } = req.query as {
    slug: string
    gotrue_id: string
    role_id: string
  }
  const roleId = Number(role_id)

  if (req.method === 'DELETE') {
    const updated = unassignOrgMemberRole(slug, gotrue_id, roleId)
    if (!updated) return res.status(404).json({ data: null, error: { message: 'Member not found' } })
    return res.status(200).json(updated)
  }

  if (req.method === 'PUT') {
    const { role_scoped_projects } = req.body as { role_scoped_projects?: string[] }
    const updated = updateOrgMemberRoleProjectRefs(
      slug,
      gotrue_id,
      roleId,
      role_scoped_projects ?? []
    )
    if (!updated) return res.status(404).json({ data: null, error: { message: 'Member not found' } })
    return res.status(200).json(updated)
  }

  res.setHeader('Allow', ['DELETE', 'PUT'])
  res.status(405).json({ data: null, error: { message: `Method ${req.method} Not Allowed` } })
}
