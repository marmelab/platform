/**
 * GET /platform/profile/permissions
 *
 * Returns the caller's permission set based on their role in members.json.
 * Only active in GoTrue auth mode (NEXT_PUBLIC_STUDIO_AUTH=gotrue).
 * In legacy self-hosted mode this route is never called (usePermissionsQuery
 * is disabled when IS_PLATFORM=false and STUDIO_AUTH_GOTRUE=false).
 */
import type { NextApiRequest, NextApiResponse } from 'next'

import { STUDIO_AUTH_GOTRUE } from '@/lib/constants'
import { findMemberByGotrueId } from '@/lib/api/self-hosted/membersStore'
import { getStoredOrganizations } from '@/lib/api/self-hosted/organizationsStore'
import { gotrueVerifyJwt } from '@/lib/api/self-hosted/studioGoTrue'
import { permissionsForRole } from '@/lib/api/self-hosted/selfHostedPermissions'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET'])
    return res.status(405).json({ error: 'Method not allowed' })
  }

  if (!STUDIO_AUTH_GOTRUE) {
    // Legacy self-hosted: permission checking is bypassed client-side; return empty.
    return res.status(200).json([])
  }

  const token = req.headers.authorization?.replace(/bearer /i, '').trim()
  if (!token) return res.status(401).json({ error: 'No authorization token' })

  const gotrueUser = await gotrueVerifyJwt(token)
  if (!gotrueUser) return res.status(401).json({ error: 'Invalid token' })

  const found = findMemberByGotrueId(gotrueUser.sub)
  if (!found) return res.status(404).json({ error: "User's profile not found" })

  const { member, org_slug } = found
  // Project-scoped members have role IDs >= 1000 (encoded as 1000 + member.id*10 + base_role_id)
  const rawRoleId = member.role_ids[0] ?? 3
  const role_id = rawRoleId >= 1000 ? rawRoleId % 10 : rawRoleId

  // Resolve the org slug to get the actual stored slug (in case it differs)
  const orgs = getStoredOrganizations()
  const org = orgs.find((o) => o.slug === org_slug)
  const slug = org?.slug ?? org_slug

  return res.status(200).json(permissionsForRole(role_id, slug))
}
