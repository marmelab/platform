import { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import { addOrgMember } from '@/lib/api/self-hosted/membersStore'
import { STUDIO_AUTH_GOTRUE } from '@/lib/constants'
import { gotrueAdminCreateUser } from '@/lib/api/self-hosted/studioGoTrue'

export default (req: NextApiRequest, res: NextApiResponse) => apiWrapper(req, res, handler)

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { slug } = req.query as { slug: string }

  if (req.method === 'GET') {
    // Self-hosted: invitations are applied immediately as members, no pending state
    return res.status(200).json({ invitations: [] })
  }

  if (req.method === 'POST') {
    const { email, role_id, password } = req.body as {
      email: string
      role_id: number
      password?: string
    }

    if (!email || typeof role_id !== 'number') {
      return res
        .status(400)
        .json({ data: null, error: { message: 'email and role_id are required' } })
    }

    if (STUDIO_AUTH_GOTRUE) {
      // GoTrue mode: create the user in GoTrue first, then link them in members.json
      if (!password) {
        return res
          .status(400)
          .json({ data: null, error: { message: 'password is required in GoTrue auth mode' } })
      }
      try {
        const gotrueUser = await gotrueAdminCreateUser(email, password)
        const member = addOrgMember(slug, {
          primary_email: email,
          role_id,
          gotrue_id_override: gotrueUser.id,
        })
        return res.status(200).json(member)
      } catch (err: any) {
        return res
          .status(400)
          .json({ data: null, error: { message: err.message || 'Failed to create user' } })
      }
    }

    // Legacy session mode: store password hash locally
    const member = addOrgMember(slug, { primary_email: email, role_id, password })
    return res.status(200).json(member)
  }

  res.setHeader('Allow', ['GET', 'POST'])
  res.status(405).json({ data: null, error: { message: `Method ${req.method} Not Allowed` } })
}
