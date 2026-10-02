/**
 * Server-side helper for calling the GoTrue admin API on behalf of the Studio.
 *
 * Used only when NEXT_PUBLIC_STUDIO_AUTH=gotrue.
 * Requires:
 *   NEXT_PUBLIC_GOTRUE_URL   — e.g. http://localhost:8000/auth/v1
 *   STUDIO_GOTRUE_SERVICE_KEY — service_role JWT for the default project
 */

// STUDIO_GOTRUE_URL is a runtime-only (non-NEXT_PUBLIC) var so it isn't baked at build
// time and can be set to the internal Docker hostname (e.g. http://auth:9999).
// Falls back to NEXT_PUBLIC_GOTRUE_URL for local dev where both are the same host.
const GOTRUE_URL =
  process.env.STUDIO_GOTRUE_URL ||
  process.env.NEXT_PUBLIC_GOTRUE_URL ||
  'http://localhost:8000/auth/v1'
const SERVICE_KEY = process.env.STUDIO_GOTRUE_SERVICE_KEY || ''

function adminHeaders() {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${SERVICE_KEY}`,
    apikey: SERVICE_KEY,
  }
}

export interface GoTrueAdminUser {
  id: string
  email: string
  email_confirmed_at?: string
  user_metadata?: Record<string, unknown>
  app_metadata?: Record<string, unknown>
}

/** Create a user via the GoTrue admin API. Returns the new user's id (gotrue_id). */
export async function gotrueAdminCreateUser(
  email: string,
  password: string,
  metadata: Record<string, unknown> = {}
): Promise<GoTrueAdminUser> {
  const res = await fetch(`${GOTRUE_URL}/admin/users`, {
    method: 'POST',
    headers: adminHeaders(),
    body: JSON.stringify({
      email,
      password,
      email_confirm: true,
      user_metadata: metadata,
    }),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.msg || body.message || `GoTrue error ${res.status}`)
  }
  return res.json()
}

/** Delete a user via the GoTrue admin API. */
export async function gotrueAdminDeleteUser(gotrue_id: string): Promise<void> {
  const res = await fetch(`${GOTRUE_URL}/admin/users/${gotrue_id}`, {
    method: 'DELETE',
    headers: adminHeaders(),
  })
  if (!res.ok && res.status !== 404) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.msg || body.message || `GoTrue error ${res.status}`)
  }
}

/** Update a user's password or metadata. */
export async function gotrueAdminUpdateUser(
  gotrue_id: string,
  updates: { password?: string; user_metadata?: Record<string, unknown> }
): Promise<GoTrueAdminUser> {
  const res = await fetch(`${GOTRUE_URL}/admin/users/${gotrue_id}`, {
    method: 'PUT',
    headers: adminHeaders(),
    body: JSON.stringify(updates),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.msg || body.message || `GoTrue error ${res.status}`)
  }
  return res.json()
}

/** Verify a GoTrue JWT and return the decoded sub (gotrue_id) + email. */
export async function gotrueVerifyJwt(
  token: string
): Promise<{ sub: string; email: string } | null> {
  const res = await fetch(`${GOTRUE_URL}/user`, {
    headers: {
      Authorization: `Bearer ${token}`,
      apikey: SERVICE_KEY,
    },
  })
  if (!res.ok) return null
  const data = await res.json()
  return { sub: data.id, email: data.email }
}

/**
 * Extract + verify the GoTrue Bearer token from a Next.js API request.
 * Returns the verified StoredMember, or null if the token is missing/invalid/not a member.
 * Call this at the top of any API route that should require Studio login.
 */
export async function getGoTrueAuthMember(
  req: import('next').NextApiRequest
): Promise<import('./membersStore').StoredMember | null> {
  const { findMemberByGotrueId } = await import('./membersStore')
  const token = req.headers.authorization?.replace(/bearer /i, '').trim()
  if (!token) return null
  const gotrueUser = await gotrueVerifyJwt(token)
  if (!gotrueUser) return null
  const found = findMemberByGotrueId(gotrueUser.sub)
  return found?.member ?? null
}
