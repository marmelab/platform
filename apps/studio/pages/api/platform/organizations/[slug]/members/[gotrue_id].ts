import { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import { assignOrgMemberRole, deleteOrgMember } from '@/lib/api/self-hosted/membersStore'
import { STUDIO_AUTH_GOTRUE } from '@/lib/constants'
import { gotrueAdminDeleteUser } from '@/lib/api/self-hosted/studioGoTrue'


export default (req: NextApiRequest, res: NextApiResponse) => apiWrapper(req, res, handler)

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { slug, gotrue_id } = req.query as { slug: string; gotrue_id: string }

  if (req.method === 'DELETE') {
    const removed = deleteOrgMember(slug, gotrue_id)
    if (!removed) return res.status(404).json({ data: null, error: { message: 'Member not found' } })

    // In GoTrue mode also remove the user from GoTrue (best-effort, don't fail the request)
    if (STUDIO_AUTH_GOTRUE) {
      gotrueAdminDeleteUser(gotrue_id).catch((err) =>
        console.warn(`Failed to delete GoTrue user ${gotrue_id}:`, err.message)
      )
    }

    return res.status(200).json({ message: 'Member removed' })
  }

  if (req.method === 'PATCH') {
    const { role_id, role_scoped_projects } = req.body as {
      role_id: number
      role_scoped_projects?: string[]
    }
    if (typeof role_id !== 'number') {
      return res.status(400).json({ data: null, error: { message: 'role_id is required' } })
    }
    const updated = assignOrgMemberRole(slug, gotrue_id, role_id, role_scoped_projects)
    if (!updated) return res.status(404).json({ data: null, error: { message: 'Member not found' } })
    return res.status(200).json(updated)
  }

  res.setHeader('Allow', ['DELETE', 'PATCH'])
  res.status(405).json({ data: null, error: { message: `Method ${req.method} Not Allowed` } })
}
