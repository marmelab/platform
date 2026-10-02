/**
 * One-time bootstrap endpoint for GoTrue auth mode.
 * Creates the initial Owner account in both GoTrue and members.json.
 *
 * Only works when:
 *   - NEXT_PUBLIC_STUDIO_AUTH=gotrue
 *   - No members exist yet in members.json
 *
 * POST /api/self-hosted/bootstrap  { email, password }
 */
import type { NextApiRequest, NextApiResponse } from 'next'

import { STUDIO_AUTH_GOTRUE } from '@/lib/constants'
import { getOrgMembers, addOrgMember } from '@/lib/api/self-hosted/membersStore'
import { getStoredOrganizations } from '@/lib/api/self-hosted/organizationsStore'
import { gotrueAdminCreateUser, gotrueAdminUpdateUser } from '@/lib/api/self-hosted/studioGoTrue'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') {
    // Lightweight status check — used by sign-in and setup pages to decide which flow to show.
    if (!STUDIO_AUTH_GOTRUE) {
      return res.status(400).json({ error: 'Not in GoTrue auth mode' })
    }
    const orgs = getStoredOrganizations()
    const defaultOrg = orgs[0]
    if (!defaultOrg) return res.status(200).json({ bootstrapped: false })
    const existing = getOrgMembers(defaultOrg.slug)
    return res.status(200).json({ bootstrapped: existing.length > 0 })
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', ['GET', 'POST'])
    return res.status(405).json({ error: 'Method not allowed' })
  }

  if (!STUDIO_AUTH_GOTRUE) {
    return res.status(400).json({ error: 'Not in GoTrue auth mode' })
  }

  const orgs = getStoredOrganizations()
  const defaultOrg = orgs[0]
  if (!defaultOrg) {
    return res.status(500).json({ error: 'No organization found' })
  }

  const existing = getOrgMembers(defaultOrg.slug)
  const { email, password } = req.body ?? {}

  if (existing.length > 0) {
    // Allow credential reset: if email matches an existing admin and a new password is supplied,
    // update the GoTrue password so a locked-out admin can recover access.
    if (email && password && String(password).length >= 8) {
      const match = existing.find((m) => m.primary_email === String(email))
      if (match) {
        try {
          await gotrueAdminUpdateUser(match.gotrue_id, { password: String(password) })
          return res.status(200).json({ ok: true, reset: true, email: match.primary_email })
        } catch (err: any) {
          return res.status(400).json({ error: err.message || 'Failed to reset password' })
        }
      }
    }
    return res.status(409).json({ error: 'Admin already exists. Use the sign-in page.' })
  }

  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required' })
  }
  if (String(password).length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' })
  }

  try {
    const gotrueUser = await gotrueAdminCreateUser(String(email), String(password))
    const member = addOrgMember(defaultOrg.slug, {
      primary_email: gotrueUser.email,
      role_id: 1, // Owner
      gotrue_id_override: gotrueUser.id,
    })
    return res.status(200).json({
      ok: true,
      gotrue_id: member.gotrue_id,
      email: member.primary_email,
    })
  } catch (err: any) {
    return res.status(400).json({ error: err.message || 'Failed to create admin' })
  }
}
