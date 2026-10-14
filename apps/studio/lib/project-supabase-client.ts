import { createPlatformProjectClient } from '@/platform/projectClient'

/**
 * Creates a Supabase client bound to a specific project.
 * Platform: through Studio's same-origin admin proxy, no temporary API key in the browser.
 */
export async function createProjectSupabaseClient(projectRef: string, _clientEndpoint: string) {
  return createPlatformProjectClient(projectRef)
}
