import { toast } from 'sonner'

/**
 * Realtime Inspector token (browser): a JWT valid 10 minutes for this project only, minted by the control plane,
 * which holds the app's JWT secret. Replaces the fork's "temporary" key (the project's permanent service key).
 */
export async function getRealtimeInspectorToken(projectRef: string): Promise<{ api_key: string }> {
  const response = await fetch(`/api/platform/auth/${projectRef}/realtime-token`, {
    method: 'POST',
    credentials: 'same-origin',
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    const message = `Realtime Inspector unavailable: ${body?.error?.message ?? `HTTP ${response.status}`}`
    toast.error(message)
    throw new Error(message)
  }
  return { api_key: body.token }
}
