import { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import {
  getOrgMembers,
  getBaseRoleId,
  SELF_HOSTED_ROLES,
} from '@/lib/api/self-hosted/membersStore'
import { getStoredProjects } from '@/lib/api/self-hosted/projectsStore'

export default (req: NextApiRequest, res: NextApiResponse) => apiWrapper(req, res, handler)

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') {
    const { slug } = req.query as { slug: string }
    const members = getOrgMembers(slug)
    const allProjects = getStoredProjects()

    // Build project_scoped_roles from members who have project-scoped access.
    // Each entry gets a unique ID = 1000 + member.id * 10 + base_role_id.
    const projectScopedRoles = members
      .filter((m) => m.project_refs && m.project_refs.length > 0)
      .flatMap((m) =>
        m.role_ids
          .filter((id) => id >= 1000)
          .map((id) => {
            const baseRoleId = getBaseRoleId(id)
            const baseRole = SELF_HOSTED_ROLES.find((r) => r.id === baseRoleId)
            if (!baseRole) return null
            const projects = (m.project_refs ?? []).map((ref) => {
              const p = allProjects.find((proj) => proj.ref === ref)
              return { ref, name: p?.name ?? ref }
            })
            return {
              id,
              name: baseRole.name,
              base_role_id: baseRoleId,
              description: baseRole.description,
              projects,
            }
          })
          .filter(Boolean)
      )

    return res.status(200).json({
      org_scoped_roles: SELF_HOSTED_ROLES,
      project_scoped_roles: projectScopedRoles,
    })
  }
  res.setHeader('Allow', ['GET'])
  res.status(405).json({ data: null, error: { message: `Method ${req.method} Not Allowed` } })
}
