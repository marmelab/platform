import { createClient } from '@supabase/supabase-js'

/**
 * The browser's Supabase client of a project (OAuth Server apps, custom OAuth providers), pointed at Studio's
 * same-origin proxy of the app's GoTrue admin API (./authAdmin.ts). The fork used a "temporary" key, which its route
 * serves as the project's permanent service key; the proxy adds the key server side, so the client holds none.
 */
export function createPlatformProjectClient(projectRef: string) {
  return createClient(`${window.location.origin}/api/platform/auth/${projectRef}/gotrue`, 'platform', {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
      storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    },
  })
}
