import type { NextApiRequest, NextApiResponse } from 'next'

import { STUDIO_AUTH_GOTRUE } from '@/lib/constants'
import { findMemberByGotrueId } from '@/lib/api/self-hosted/membersStore'
import { gotrueVerifyJwt } from '@/lib/api/self-hosted/studioGoTrue'
import { COOKIE_NAME, verifyToken, decodeSessionPayload } from './session'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET'])
    return res.status(405).json({ error: 'Method not allowed' })
  }

  // GoTrue mode: authenticate via the Bearer token set by the client fetcher
  if (STUDIO_AUTH_GOTRUE) {
    const bearerToken = req.headers.authorization?.replace(/bearer /i, '').trim()
    if (!bearerToken) {
      return res.status(401).json({ error: 'Not authenticated' })
    }
    const gotrueUser = await gotrueVerifyJwt(bearerToken)
    if (!gotrueUser) {
      return res.status(401).json({ error: 'Invalid or expired token' })
    }
    const found = findMemberByGotrueId(gotrueUser.sub)
    if (!found) {
      return res.status(401).json({ error: 'Member not found' })
    }
    const { member, org_slug } = found
    return res.status(200).json({
      gotrue_id: member.gotrue_id,
      email: member.primary_email,
      username: member.username,
      role_id: member.role_ids[0] ?? 1,
      org_slug,
    })
  }

  // Legacy session-cookie mode
  const token = req.cookies[COOKIE_NAME]
  if (!token || !verifyToken(token)) {
    return res.status(401).json({ error: 'Not authenticated' })
  }

  const payload = decodeSessionPayload(token)

  // No member identity in token → global admin session
  if (!payload?.gotrue_id) {
    return res.status(200).json({ role_id: 1, is_admin_session: true })
  }

  const found = findMemberByGotrueId(payload.gotrue_id)
  if (!found) {
    return res.status(401).json({ error: 'Member not found' })
  }

  const { member, org_slug } = found
  return res.status(200).json({
    gotrue_id: member.gotrue_id,
    email: member.primary_email,
    username: member.username,
    role_id: member.role_ids[0] ?? 1,
    org_slug,
  })
}
