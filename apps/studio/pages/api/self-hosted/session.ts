import crypto from 'node:crypto'
import type { NextApiRequest, NextApiResponse } from 'next'

import {
  findMemberByEmail,
  verifyMemberPassword,
} from '@/lib/api/self-hosted/membersStore'

const USERNAME = process.env.DASHBOARD_USERNAME || 'supabase'
const PASSWORD = process.env.DASHBOARD_PASSWORD || ''

export const COOKIE_NAME = 'studio_session'
const COOKIE_MAX_AGE = 7 * 24 * 60 * 60 // 7 days in seconds

export interface SessionPayload {
  ts: number
  gotrue_id?: string
  role_id?: number
  org_slug?: string
}

function secret(): string {
  return process.env.STUDIO_SESSION_SECRET || PASSWORD || 'studio-session-secret'
}

function sign(value: string): string {
  return crypto.createHmac('sha256', secret()).update(value).digest('hex')
}

// Token format: {base64url(JSON payload)}.{HMAC-hex(base64url)}
export function makeToken(identity?: Omit<SessionPayload, 'ts'>): string {
  const payload: SessionPayload = { ts: Date.now(), ...identity }
  const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${b64}.${sign(b64)}`
}

export function verifyToken(token: string): boolean {
  const dot = token.indexOf('.')
  if (dot === -1) return false
  const b64 = token.slice(0, dot)
  const sig = token.slice(dot + 1)
  if (sig !== sign(b64)) return false
  try {
    const payload: SessionPayload = JSON.parse(Buffer.from(b64, 'base64url').toString())
    const age = Date.now() - payload.ts
    return !isNaN(age) && age <= COOKIE_MAX_AGE * 1000
  } catch {
    return false
  }
}

export function decodeSessionPayload(token: string): SessionPayload | null {
  const dot = token.indexOf('.')
  if (dot === -1) return null
  try {
    return JSON.parse(Buffer.from(token.slice(0, dot), 'base64url').toString())
  } catch {
    return null
  }
}

function setCookie(res: NextApiResponse, token: string) {
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE}`
  )
}

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') {
    return res.status(200).json({ required: Boolean(PASSWORD) })
  }

  if (req.method === 'POST') {
    const { email, username, password } = req.body ?? {}
    const identifier = String(email ?? username ?? '')
    const pw = String(password ?? '')

    // Try member-based auth when an email-like identifier is provided
    if (identifier) {
      const found = findMemberByEmail(identifier)
      if (found?.member.password_hash) {
        if (!verifyMemberPassword(pw, found.member.password_hash)) {
          return res.status(401).json({ error: 'Invalid credentials' })
        }
        const { member, org_slug } = found
        const token = makeToken({
          gotrue_id: member.gotrue_id,
          role_id: member.role_ids[0],
          org_slug,
        })
        setCookie(res, token)
        return res.status(200).json({ ok: true, role_id: member.role_ids[0] })
      }
    }

    // Global admin fallback (backward compat)
    if (!PASSWORD) {
      setCookie(res, makeToken())
      return res.status(200).json({ ok: true })
    }

    if (identifier !== USERNAME || pw !== PASSWORD) {
      return res.status(401).json({ error: 'Invalid credentials' })
    }

    setCookie(res, makeToken())
    return res.status(200).json({ ok: true })
  }

  if (req.method === 'DELETE') {
    res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`)
    return res.status(200).json({ ok: true })
  }

  res.setHeader('Allow', ['GET', 'POST', 'DELETE'])
  return res.status(405).json({ error: `Method ${req.method} Not Allowed` })
}
