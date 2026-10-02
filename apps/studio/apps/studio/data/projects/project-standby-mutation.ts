import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'

import { projectKeys } from './keys'
import type { ResponseError, UseCustomMutationOptions } from '@/types'

// ── API helpers ──────────────────────────────────────────────────────────────
// These call self-hosted-only routes that are not in the OpenAPI spec,
// so we use fetch directly rather than the typed openapi-fetch wrappers.

async function callStandby(ref: string, method: 'POST' | 'DELETE', body?: { docker_host?: string }) {
  const res = await fetch(`/api/platform/projects/${ref}/standby`, {
    method,
    ...(body !== undefined && {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  })
  if (!res.ok) {
    const responseBody = await res.json().catch(() => ({}))
    throw new Error(responseBody?.error?.message ?? `Request failed (HTTP ${res.status})`)
  }
  return res.json()
}

async function callFailover(ref: string) {
  const res = await fetch(`/api/platform/projects/${ref}/failover`, { method: 'POST' })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body?.error?.message ?? `Request failed (HTTP ${res.status})`)
  }
  return res.json()
}

// ── Provision standby ────────────────────────────────────────────────────────

type StandbyVariables = { ref: string; docker_host?: string }

export const useProvisionStandbyMutation = (
  options: UseCustomMutationOptions<unknown, ResponseError, StandbyVariables> = {}
) => {
  const queryClient = useQueryClient()
  return useMutation<unknown, ResponseError, StandbyVariables>({
    mutationFn: ({ ref, docker_host }) =>
      callStandby(ref, 'POST', docker_host !== undefined ? { docker_host } : undefined),
    async onSuccess(data, variables, context) {
      await queryClient.invalidateQueries({ queryKey: projectKeys.detail(variables.ref) })
      await options.onSuccess?.(data, variables, context)
    },
    async onError(error, variables, context) {
      if (options.onError === undefined) {
        toast.error(`Failed to provision standby: ${error.message}`)
      } else {
        options.onError(error, variables, context)
      }
    },
    ...options,
  })
}

// ── Deprovision standby ──────────────────────────────────────────────────────

export const useDeprovisionStandbyMutation = (
  options: UseCustomMutationOptions<unknown, ResponseError, StandbyVariables> = {}
) => {
  const queryClient = useQueryClient()
  return useMutation<unknown, ResponseError, StandbyVariables>({
    mutationFn: ({ ref }) => callStandby(ref, 'DELETE'),
    async onSuccess(data, variables, context) {
      await queryClient.invalidateQueries({ queryKey: projectKeys.detail(variables.ref) })
      await options.onSuccess?.(data, variables, context)
    },
    async onError(error, variables, context) {
      if (options.onError === undefined) {
        toast.error(`Failed to deprovision standby: ${error.message}`)
      } else {
        options.onError(error, variables, context)
      }
    },
    ...options,
  })
}

// ── Manual failover ──────────────────────────────────────────────────────────

export const useFailoverMutation = (
  options: UseCustomMutationOptions<unknown, ResponseError, StandbyVariables> = {}
) => {
  const queryClient = useQueryClient()
  return useMutation<unknown, ResponseError, StandbyVariables>({
    mutationFn: ({ ref }) => callFailover(ref),
    async onSuccess(data, variables, context) {
      await queryClient.invalidateQueries({ queryKey: projectKeys.detail(variables.ref) })
      await options.onSuccess?.(data, variables, context)
    },
    async onError(error, variables, context) {
      if (options.onError === undefined) {
        toast.error(`Failover failed: ${error.message}`)
      } else {
        options.onError(error, variables, context)
      }
    },
    ...options,
  })
}
