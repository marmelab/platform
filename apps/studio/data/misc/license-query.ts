import { useQuery } from '@tanstack/react-query'

import { miscKeys } from './keys'
import { IS_PLATFORM } from '@/lib/constants'
import type { LicenseTier } from '@/lib/api/self-hosted/licenseManager'
import type { ResponseError, UseCustomQueryOptions } from '@/types'

export interface LicenseStatus {
  tier: LicenseTier
  grace: boolean
}

async function getLicenseStatus(): Promise<LicenseStatus> {
  const res = await fetch('/api/platform/license')
  if (!res.ok) throw new Error(`License check failed (HTTP ${res.status})`)
  return res.json()
}

export type LicenseData = Awaited<ReturnType<typeof getLicenseStatus>>
export type LicenseError = ResponseError

// Re-check every hour — server-side state already updates every 6 h
const REFETCH_INTERVAL = 60 * 60 * 1000

export const useLicenseQuery = <TData = LicenseData>(
  options: UseCustomQueryOptions<LicenseData, LicenseError, TData> = {}
) =>
  useQuery<LicenseData, LicenseError, TData>({
    queryKey: miscKeys.license(),
    queryFn: getLicenseStatus,
    // Only meaningful in self-hosted; skip on Supabase cloud
    enabled: !IS_PLATFORM,
    refetchInterval: REFETCH_INTERVAL,
    // Stale data is fine — tier changes propagate on next refetch
    staleTime: REFETCH_INTERVAL,
    ...options,
  })
