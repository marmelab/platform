import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'

import { IS_PLATFORM } from '@/lib/constants'

// [Joshen] Return 404 for all next.js API endpoints EXCEPT the ones we use in hosted:
const HOSTED_SUPPORTED_API_URLS = [
  '/ai/sql/generate-v4',
  '/ai/sql/policy',
  '/ai/feedback/rate',
  '/ai/code/complete',
  '/ai/sql/cron-v2',
  '/ai/sql/title-v2',
  '/ai/sql/filter-v1',
  '/ai/onboarding/design',
  '/ai/feedback/classify',
  '/ai/docs',
  '/get-ip-address',
  '/get-utc-time',
  '/get-deployment-commit',
  '/check-cname',
  '/edge-functions/test',
  '/edge-functions/body',
  '/generate-attachment-url',
  '/incident-status',
  '/incident-banner',
  '/status-override',
  '/api/integrations/stripe-sync',
  '/content/graphql',
]

// Paths that bypass the self-hosted auth guard.
const AUTH_EXEMPT_PREFIXES = [
  '/sign-in',
  '/setup',
  '/api/self-hosted/session',
  '/api/self-hosted/bootstrap',
  '/_next',
  '/favicon',
  '/img/',
]

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

// Decode base64url to a plain string (edge-runtime compatible, no Node.js Buffer)
function b64urlToString(s: string): string {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/')
  const padded = b64 + '==='.slice((b64.length + 3) % 4 || 4)
  return atob(padded)
}

// Token format: {base64url(JSON payload)}.{HMAC-hex(base64url)}
async function verifySessionToken(token: string, secret: string): Promise<boolean> {
  try {
    const dot = token.indexOf('.')
    if (dot === -1) return false
    const b64 = token.slice(0, dot)
    const sig = token.slice(dot + 1)

    // Verify HMAC of the base64url payload
    const keyData = new TextEncoder().encode(secret)
    const key = await crypto.subtle.importKey(
      'raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
    )
    const sigBytes = hexToBytes(sig)
    const msgBytes = new TextEncoder().encode(b64)
    if (!(await crypto.subtle.verify('HMAC', key, sigBytes.buffer as ArrayBuffer, msgBytes))) {
      return false
    }

    // Decode payload and check timestamp
    const payload = JSON.parse(b64urlToString(b64))
    const age = Date.now() - payload.ts
    return !isNaN(age) && age <= 7 * 24 * 60 * 60 * 1000
  } catch {
    return false
  }
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon\\.ico).*)'],
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl

  // --- Hosted: block unsupported API routes ---
  if (
    IS_PLATFORM &&
    pathname.startsWith('/api/') &&
    !HOSTED_SUPPORTED_API_URLS.some((url) => pathname.endsWith(url))
  ) {
    return Response.json(
      { success: false, message: 'Endpoint not supported on hosted' },
      { status: 404 }
    )
  }

  // --- Self-hosted: GoTrue auth guard ---
  const studioAuthMode = process.env.NEXT_PUBLIC_STUDIO_AUTH
  if (!IS_PLATFORM && studioAuthMode === 'gotrue') {
    if (!AUTH_EXEMPT_PREFIXES.some((p) => pathname.startsWith(p))) {
      // GoTrue mode: the JWT in the Authorization header is checked by Next.js API routes
      // themselves. For page navigation we rely on the GoTrue client-side session in
      // localStorage — no cookie to check here. The AuthProvider on the client will
      // redirect to /sign-in if there is no session.
      // Nothing to do in the middleware for GoTrue page auth — handled client-side.
    }
    return
  }

  // --- Self-hosted: legacy HMAC session cookie auth guard ---
  const dashboardPassword = process.env.DASHBOARD_PASSWORD
  if (!IS_PLATFORM && dashboardPassword) {
    if (!AUTH_EXEMPT_PREFIXES.some((p) => pathname.startsWith(p))) {
      const secret = process.env.STUDIO_SESSION_SECRET || dashboardPassword
      const cookieValue = request.cookies.get('studio_session')?.value
      if (!cookieValue || !(await verifySessionToken(cookieValue, secret))) {
        const signInUrl = request.nextUrl.clone()
        signInUrl.pathname = '/sign-in'
        return NextResponse.redirect(signInUrl)
      }
    }
  }
}
