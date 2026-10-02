import { useQuery } from '@tanstack/react-query'

import type { ResponseError, UseCustomQueryOptions } from '@/types'

export interface LicenseStatus {
  tier: 'free' | 'pro'
  grace: boolean
  email?: string
}

export async function getLicenseStatus(): Promise<LicenseStatus> {
  const res = await fetch('/api/platform/license')
  if (!res.ok) throw new Error(`Failed to fetch license status (HTTP ${res.status})`)
  return res.json() as Promise<LicenseStatus>
}

export const licenseKeys = {
  status: () => ['license', 'status'] as const,
}

export function useLicenseStatusQuery(
  options: UseCustomQueryOptions<LicenseStatus, ResponseError> = {}
) {
  return useQuery<LicenseStatus, ResponseError>({
    queryKey: licenseKeys.status(),
    queryFn: getLicenseStatus,
    staleTime: 5 * 60 * 1000,
    ...options,
  })
}
