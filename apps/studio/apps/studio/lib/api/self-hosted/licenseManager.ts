import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export type LicenseTier = 'free' | 'business' | 'enterprise'

// ── Tier hierarchy ────────────────────────────────────────────────────────────

const TIER_RANK: Record<LicenseTier, number> = { free: 0, business: 1, enterprise: 2 }

function meetsOrExceedsTier(required: LicenseTier): boolean {
  return TIER_RANK[state.tier] >= TIER_RANK[required]
}

// ── Feature → minimum tier registry ──────────────────────────────────────────

export type Feature =
  | 'multi-project'
  | 'standby'
  | 'failover'
  | 'replica'
  | 'auto-failover'
  | 'cluster'
  | 'cluster-failover'

const FEATURE_TIER: Record<Feature, LicenseTier> = {
  'multi-project':  'business',
  standby:          'business',
  failover:         'business',
  replica:          'business',
  'auto-failover':  'business',
  cluster:          'enterprise',
  'cluster-failover': 'enterprise',
}

// ── In-process state ──────────────────────────────────────────────────────────
// Stored on globalThis so the instrumentation context and API-route module
// context (which Next.js 15+ runs in separate module instances) share state.

declare global {
  // eslint-disable-next-line no-var
  var __licenseState:
    | {
        tier: LicenseTier
        graceDeadline: number
        inGrace: boolean
        activeLicenseKey: string | null
        pollingInterval: ReturnType<typeof setInterval> | null
      }
    | undefined
  // eslint-disable-next-line no-var
  var __licenseInitialized: boolean | undefined
}

if (!globalThis.__licenseState) {
  globalThis.__licenseState = {
    tier: 'free',
    graceDeadline: 0,
    inGrace: false,
    activeLicenseKey: null,
    pollingInterval: null,
  }
}

const state = globalThis.__licenseState

const GRACE_PERIOD_MS = 7 * 24 * 60 * 60 * 1000
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

// ── Persistence ───────────────────────────────────────────────────────────────

const DATA_DIR = process.env.STUDIO_DATA_DIR || path.join(/*turbopackIgnore: true*/ process.cwd(), '.studio-data')
const LICENSE_FILE = path.join(DATA_DIR, 'license.json')

function readPersistedKey(): string | null {
  try {
    if (!fs.existsSync(LICENSE_FILE)) return null
    const raw = fs.readFileSync(LICENSE_FILE, 'utf-8')
    const parsed = JSON.parse(raw) as { key?: string }
    return parsed.key || null
  } catch {
    return null
  }
}

function persistKey(key: string): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    fs.writeFileSync(LICENSE_FILE, JSON.stringify({ key }), 'utf-8')
  } catch (err) {
    console.warn('[license] Failed to persist license key:', err)
  }
}

function clearPersistedKey(): void {
  try {
    if (fs.existsSync(LICENSE_FILE)) fs.unlinkSync(LICENSE_FILE)
  } catch {
    // non-fatal
  }
}

// ── JWT helpers ───────────────────────────────────────────────────────────────

function base64urlDecode(s: string): string {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8')
}

interface LicensePayload {
  tier?: string
  email?: string
  issued_to?: string
  license_id?: string
  iat?: number
}

function verifyJwt(token: string, secret: string): LicensePayload | null {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const [header, payload, sig] = parts
    const expected = crypto
      .createHmac('sha256', secret)
      .update(`${header}.${payload}`)
      .digest('base64url')
    if (expected !== sig) return null
    return JSON.parse(base64urlDecode(payload)) as LicensePayload
  } catch {
    return null
  }
}

// Normalize JWT tier strings to LicenseTier — 'pro' is a legacy alias for 'business'.
function normalizeTier(raw: string | undefined): LicenseTier | null {
  if (raw === 'enterprise') return 'enterprise'
  if (raw === 'business' || raw === 'pro') return 'business'
  return null
}

// ── License server check ──────────────────────────────────────────────────────

async function checkLicenseServer(key: string): Promise<void> {
  const serverUrl = process.env.MULTI_HEAD_LICENSE_SERVER_URL
  if (!serverUrl) return

  try {
    const res = await fetch(
      `${serverUrl.replace(/\/$/, '')}/v1/validate?key=${encodeURIComponent(key)}`,
      { signal: AbortSignal.timeout(10_000) }
    )

    if (!res.ok) {
      console.warn(`[license] Server returned HTTP ${res.status} — treating as unreachable`)
      applyUnreachable()
      return
    }

    const body = (await res.json()) as { active?: boolean; tier?: string }

    if (body.active === true) {
      const serverTier = normalizeTier(body.tier)
      if (serverTier) state.tier = serverTier
      state.graceDeadline = Date.now() + GRACE_PERIOD_MS
      state.inGrace = false
      console.log(`[license] ${state.tier} license confirmed by server.`)
    } else {
      state.tier = 'free'
      state.graceDeadline = 0
      state.inGrace = false
      state.activeLicenseKey = null
      clearPersistedKey()
      console.warn('[license] License revoked by server — downgrading to Free tier.')
    }
  } catch {
    applyUnreachable()
  }
}

function applyUnreachable(): void {
  if (state.graceDeadline > 0 && Date.now() < state.graceDeadline) {
    state.inGrace = true
    const daysLeft = Math.ceil((state.graceDeadline - Date.now()) / (24 * 60 * 60 * 1000))
    console.warn(
      `[license] License server unreachable — grace period active (${daysLeft}d remaining). Keeping ${state.tier} tier.`
    )
  } else {
    state.inGrace = false
    if (state.tier !== 'free') {
      state.tier = 'free'
      console.warn(
        '[license] License server unreachable and grace period expired — downgrading to Free tier.'
      )
    }
  }
}

// ── Internal: start polling ───────────────────────────────────────────────────

function startPolling(key: string): void {
  if (state.pollingInterval) clearInterval(state.pollingInterval)
  checkLicenseServer(key).catch(console.error)
  state.pollingInterval = setInterval(
    () => checkLicenseServer(key).catch(console.error),
    CHECK_INTERVAL_MS
  )
}

// ── Public API ────────────────────────────────────────────────────────────────

export function getLicenseTier(): LicenseTier {
  return state.tier
}

export function getLicenseStatus(): { tier: LicenseTier; grace: boolean; email?: string } {
  let email: string | undefined
  if (state.activeLicenseKey) {
    const secret = process.env.MULTI_HEAD_LICENSE_SECRET
    if (secret) {
      const payload = verifyJwt(state.activeLicenseKey, secret)
      email = payload?.email ?? payload?.issued_to
    }
  }
  return { tier: state.tier, grace: state.inGrace, ...(email ? { email } : {}) }
}

/**
 * Returns ok:true if the current tier satisfies the required tier for a feature.
 * Use this at API route boundaries.
 */
export function requireTier(feature: Feature): { ok: boolean; message?: string } {
  const required = FEATURE_TIER[feature]
  if (meetsOrExceedsTier(required)) return { ok: true }
  const label = required === 'enterprise' ? 'Enterprise' : 'Business'
  return {
    ok: false,
    message: `This feature requires a ${label} license. Contact nautilux2@gmail.com to upgrade.`,
  }
}

/** @deprecated Use requireTier(feature) instead. */
export function requirePro(): { ok: boolean; message?: string } {
  return requireTier('failover')
}

/**
 * Activates a license key at runtime (called from the dashboard settings UI).
 * Returns an error string on failure, null on success.
 */
export async function activateLicenseKey(key: string): Promise<string | null> {
  const secret = process.env.MULTI_HEAD_LICENSE_SECRET
  if (!secret) {
    return 'MULTI_HEAD_LICENSE_SECRET is not configured on this server.'
  }

  const payload = verifyJwt(key, secret)
  if (!payload) return 'Invalid license key — signature verification failed.'

  const tier = normalizeTier(payload.tier)
  if (!tier || tier === 'free') {
    return `License tier "${payload.tier}" does not unlock paid features.`
  }

  state.activeLicenseKey = key
  state.tier = tier
  persistKey(key)

  console.log(
    `[license] ${tier} key activated via dashboard (issued to: ${payload.email ?? payload.issued_to ?? 'unknown'}).`
  )

  startPolling(key)
  return null
}

/**
 * Removes the active license key and downgrades to Free tier.
 */
export function deactivateLicense(): void {
  if (state.pollingInterval) {
    clearInterval(state.pollingInterval)
    state.pollingInterval = null
  }
  state.activeLicenseKey = null
  state.tier = 'free'
  state.graceDeadline = 0
  state.inGrace = false
  clearPersistedKey()
  console.log('[license] License deactivated — running as Free tier.')
}

/**
 * Called once from instrumentation.ts on server start.
 * Priority order: MULTI_HEAD_LICENSE_KEY env var > persisted license.json key.
 */
export function initLicense(): void {
  if (globalThis.__licenseInitialized) return
  globalThis.__licenseInitialized = true

  // No license server configured → self-hosted instance, grant Enterprise automatically.
  if (!process.env.MULTI_HEAD_LICENSE_SERVER_URL) {
    state.tier = 'enterprise'
    console.log('[license] No license server configured — running as Enterprise (self-hosted).')
    return
  }

  const secret = process.env.MULTI_HEAD_LICENSE_SECRET
  if (!secret) {
    console.warn('[license] MULTI_HEAD_LICENSE_SECRET not set — running as Free tier.')
    return
  }

  const key = process.env.MULTI_HEAD_LICENSE_KEY || readPersistedKey()
  if (!key) {
    console.log('[license] No license key found — running as Free tier.')
    return
  }

  const payload = verifyJwt(key, secret)
  if (!payload) {
    console.warn('[license] License key signature invalid — running as Free tier.')
    return
  }

  const tier = normalizeTier(payload.tier)
  if (!tier || tier === 'free') {
    console.log(`[license] License tier: ${payload.tier ?? 'unknown'}. Running as Free tier.`)
    return
  }

  state.activeLicenseKey = key
  state.tier = tier
  console.log(
    `[license] License key valid — ${tier} tier (issued to: ${payload.email ?? payload.issued_to ?? 'unknown'}). Confirming with server...`
  )
  startPolling(key)
}
