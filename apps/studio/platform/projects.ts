import type { AsyncLocalStorage } from 'node:async_hooks'
import type { NextApiRequest, NextApiResponse } from 'next'

import { canAccess, type PlatformIdentity, verifyIdentity } from './identity'
import type { StoredProject } from '@/lib/api/self-hosted/projectsStore'

/**
 * StoredProject served by the control plane, plus the URL Studio's server uses to reach the app's API and the app's
 * status on the platform ("stopped": read-only, see ./stopped.ts).
 */
export type PlatformProject = StoredProject & { internal_url?: string; platform_status?: string }

const TTL_MS = 2_000
const STALE_MS = 30_000

interface PlatformState {
  context: AsyncLocalStorage<PlatformIdentity>
  projects: PlatformProject[]
  fetchedAt: number
  inflight?: Promise<void>
}

// Shared by every route bundle of the Next.js server. Lazy, and no static node: import: projectsStore also
// ends up in client bundles (never called there).
function platformState(): PlatformState {
  const global = globalThis as { __platform?: PlatformState }
  if (!global.__platform) {
    const hooks = process.getBuiltinModule('node:async_hooks') as typeof import('node:async_hooks')
    global.__platform = { context: new hooks.AsyncLocalStorage<PlatformIdentity>(), projects: [], fetchedAt: 0 }
  }
  return global.__platform
}

async function fetchProjects() {
  const state = platformState()
  const response = await fetch(`${process.env.PLATFORM_CONTROL_PLANE_URL}/internal/studio/projects`, {
    headers: { Authorization: `Bearer ${process.env.PLATFORM_STUDIO_CONFIG_TOKEN}` },
    signal: AbortSignal.timeout(5_000),
  })
  if (!response.ok) throw new Error(`control plane returned HTTP ${response.status}`)
  state.projects = (await response.json()) as PlatformProject[]
  state.fetchedAt = Date.now()
}

/** Project configs come from the control plane (source of truth), cached for TTL_MS. */
export async function refreshPlatformProjects() {
  const state = platformState()
  if (Date.now() - state.fetchedAt < TTL_MS) return
  state.inflight ??= fetchProjects().finally(() => (state.inflight = undefined))
  try {
    await state.inflight
  } catch (error) {
    if (Date.now() - state.fetchedAt > STALE_MS) state.projects = []
    console.error('[platform] cannot fetch projects:', error)
  }
}

/** Projects visible to the identity of the current API request; none outside a request. */
export function platformProjects(): PlatformProject[] {
  const state = platformState()
  const identity = state.context.getStore()
  return identity ? state.projects.filter((p) => canAccess(identity, p.ref)) : []
}

export const currentIdentity = () => platformState().context.getStore()

/** Runs an API handler with the request's verified identity: 401 without it, 403 on a foreign ref. */
export async function withPlatformRequest(
  req: NextApiRequest,
  res: NextApiResponse,
  handler: () => Promise<NextApiResponse | Response | void>
) {
  const identity = await verifyIdentity((name) => req.headers[name] as string | undefined)
  if (!identity) {
    return res.status(401).json({ error: { message: 'Unauthorized: missing or invalid platform identity' } })
  }
  const ref = req.query.ref
  if (ref !== undefined && (typeof ref !== 'string' || !canAccess(identity, ref))) {
    return res.status(403).json({ error: { message: 'No access to this project' } })
  }
  await refreshPlatformProjects()
  try {
    return await platformState().context.run(identity, handler)
  } catch (error) {
    console.error('[platform]', error)
    if (!res.headersSent) res.status(500).json({ error: { message: String(error) } })
  }
}
