import { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import { DEFAULT_PROJECT } from '@/lib/constants/api'
import { STUDIO_AUTH_GOTRUE } from '@/lib/constants'
import { findMemberByGotrueId, addOrgMember, getOrgMembers } from '@/lib/api/self-hosted/membersStore'
import { gotrueVerifyJwt } from '@/lib/api/self-hosted/studioGoTrue'
import { getStoredOrganizations } from '@/lib/api/self-hosted/organizationsStore'

export default (req: NextApiRequest, res: NextApiResponse) => apiWrapper(req, res, handler)

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { method } = req

  switch (method) {
    case 'GET':
      return handleGet(req, res)
    case 'POST':
      return handlePost(req, res)
    default:
      res.setHeader('Allow', ['GET', 'POST'])
      res.status(405).json({ data: null, error: { message: `Method ${method} Not Allowed` } })
  }
}

async function handleGet(req: NextApiRequest, res: NextApiResponse) {
  if (!STUDIO_AUTH_GOTRUE) {
    // Legacy self-hosted: return static mock (no real user identity needed)
    return res.status(200).json({
      id: 1,
      primary_email: 'admin@localhost',
      username: 'admin',
      first_name: '',
      last_name: '',
      organizations: [
        {
          id: 1,
          name: process.env.DEFAULT_ORGANIZATION_NAME || 'Default Organization',
          slug: 'default-org-slug',
          billing_email: '',
          projects: [{ ...DEFAULT_PROJECT, connectionString: '' }],
        },
      ],
    })
  }

  // GoTrue mode: decode JWT → find member → return real profile
  const token = req.headers.authorization?.replace(/bearer /i, '').trim()
  if (!token) {
    return res.status(401).json({ error: { message: 'No authorization token' } })
  }

  const gotrueUser = await gotrueVerifyJwt(token)
  if (!gotrueUser) {
    return res.status(401).json({ error: { message: "User's profile not found" } })
  }

  const found = findMemberByGotrueId(gotrueUser.sub)
  if (!found) {
    // Trigger profile creation flow on the client side
    return res.status(404).json({ error: { message: "User's profile not found" } })
  }

  const { member, org_slug } = found
  const orgs = getStoredOrganizations()
  const org = orgs.find((o) => o.slug === org_slug)

  return res.status(200).json({
    id: member.id,
    primary_email: member.primary_email,
    username: member.username,
    first_name: '',
    last_name: '',
    gotrue_id: member.gotrue_id,
    organizations: org
      ? [
          {
            id: org.id,
            name: org.name,
            slug: org.slug,
            billing_email: org.billing_email ?? '',
            projects: [{ ...DEFAULT_PROJECT, connectionString: '' }],
          },
        ]
      : [],
  })
}

async function handlePost(req: NextApiRequest, res: NextApiResponse) {
  if (!STUDIO_AUTH_GOTRUE) {
    return res.status(200).json({ id: 1, primary_email: 'admin@localhost', username: 'admin' })
  }

  // Called by ProfileProvider on first login — create the member record from GoTrue identity
  const token = req.headers.authorization?.replace(/bearer /i, '').trim()
  if (!token) {
    return res.status(401).json({ error: { message: 'No authorization token' } })
  }

  const gotrueUser = await gotrueVerifyJwt(token)
  if (!gotrueUser) {
    return res.status(401).json({ error: { message: 'Invalid token' } })
  }

  // Idempotent: if member already exists, return it
  const existing = findMemberByGotrueId(gotrueUser.sub)
  if (existing) {
    return res.status(409).json({ error: { message: 'Profile already exists' } })
  }

  // Do NOT auto-create members for unknown GoTrue users — the admin must invite them
  // explicitly via the organization members UI. Only the very first user (bootstrap) is
  // auto-enrolled, and that happens through /api/self-hosted/bootstrap, not here.
  return res.status(404).json({ error: { message: "User's profile not found" } })
}
