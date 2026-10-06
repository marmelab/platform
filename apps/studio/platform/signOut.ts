/**
 * Ends the platform session (the control plane's `/_platform/logout`, which clears the session cookie), then goes to
 * the platform's login page. Studio's own sign-out only clears its GoTrue client, which the platform does not use.
 * Returns false without the platform (no such route), so the caller keeps Studio's own flow.
 */
export async function platformSignOut() {
  const response = await fetch('/_platform/logout', { method: 'POST', credentials: 'same-origin' })
  if (!response.ok) return false
  window.location.assign('/_platform/login')
  return true
}
