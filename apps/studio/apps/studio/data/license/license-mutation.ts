import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'

import { licenseKeys, LicenseStatus } from './license-query'
import type { ResponseError, UseCustomMutationOptions } from '@/types'

async function patchLicense(key: string): Promise<LicenseStatus> {
  const res = await fetch('/api/platform/license', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key }),
  })
  const body = await res.json()
  if (!res.ok) throw new Error(body?.error?.message ?? `Request failed (HTTP ${res.status})`)
  return body as LicenseStatus
}

async function deleteLicense(): Promise<LicenseStatus> {
  const res = await fetch('/api/platform/license', { method: 'DELETE' })
  const body = await res.json()
  if (!res.ok) throw new Error(body?.error?.message ?? `Request failed (HTTP ${res.status})`)
  return body as LicenseStatus
}

export function useLicenseActivateMutation(
  options: UseCustomMutationOptions<LicenseStatus, ResponseError, { key: string }> = {}
) {
  const queryClient = useQueryClient()
  return useMutation<LicenseStatus, ResponseError, { key: string }>({
    mutationFn: ({ key }) => patchLicense(key),
    async onSuccess(data, variables, context) {
      queryClient.setQueryData(licenseKeys.status(), data)
      await options.onSuccess?.(data, variables, context)
    },
    async onError(error, variables, context) {
      if (options.onError === undefined) {
        toast.error(`Failed to activate license: ${error.message}`)
      } else {
        options.onError(error, variables, context)
      }
    },
    ...options,
  })
}

export function useLicenseDeactivateMutation(
  options: UseCustomMutationOptions<LicenseStatus, ResponseError, void> = {}
) {
  const queryClient = useQueryClient()
  return useMutation<LicenseStatus, ResponseError, void>({
    mutationFn: () => deleteLicense(),
    async onSuccess(data, variables, context) {
      queryClient.setQueryData(licenseKeys.status(), data)
      await options.onSuccess?.(data, variables, context)
    },
    async onError(error, variables, context) {
      if (options.onError === undefined) {
        toast.error(`Failed to deactivate license: ${error.message}`)
      } else {
        options.onError(error, variables, context)
      }
    },
    ...options,
  })
}
