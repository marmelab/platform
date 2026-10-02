export const PLATFORM_MODE = Boolean(process.env.PLATFORM_CONTROL_PLANE_URL)

export interface PlatformIdentity {
  user: string
  role: 'admin' | 'developer'
  apps: string[]
}

const MAX_SKEW_SECONDS = 300
const encoder = new TextEncoder()

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(message)))
  return Array.from(signature, (b) => b.toString(16).padStart(2, '0')).join('')
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/**
 * Identity set by Caddy from the control plane's forward auth (X-Platform-User, X-Platform-Role, X-Platform-Apps),
 * signed with PLATFORM_STUDIO_HEADER_SECRET (X-Platform-Signature: t=<unix seconds>,s=<hex hmac>).
 */
export async function verifyIdentity(
  header: (name: string) => string | null | undefined
): Promise<PlatformIdentity | null> {
  const secret = process.env.PLATFORM_STUDIO_HEADER_SECRET
  const user = header('x-platform-user')
  const role = header('x-platform-role')
  const apps = header('x-platform-apps') ?? ''
  const match = /^t=(\d+),s=([0-9a-f]{64})$/.exec(header('x-platform-signature') ?? '')
  if (!secret || !user || !match || (role !== 'admin' && role !== 'developer')) return null
  const ts = Number(match[1])
  if (Math.abs(Date.now() / 1000 - ts) > MAX_SKEW_SECONDS) return null
  const expected = await hmacHex(secret, `${user}\n${role}\n${apps}\n${ts}`)
  if (!safeEqual(expected, match[2])) return null
  return { user, role, apps: apps.split(',').filter(Boolean) }
}

export const canAccess = (identity: PlatformIdentity, ref: string) =>
  identity.role === 'admin' || identity.apps.includes(ref)
