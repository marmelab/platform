import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'

import { projectKeys } from './keys'
import type { ResponseError, UseCustomMutationOptions } from '@/types'

async function callReplica(
  ref: string,
  method: 'POST' | 'DELETE',
  body?: { docker_host?: string },
  replicaRef?: string
) {
  const url =
    method === 'DELETE' && replicaRef
      ? `/api/platform/projects/${ref}/replica?replica_ref=${encodeURIComponent(replicaRef)}`
      : `/api/platform/projects/${ref}/replica`

  const res = await fetch(url, {
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

async function callClusterFailover(ref: string) {
  const res = await fetch(`/api/platform/projects/${ref}/cluster-failover`, { method: 'POST' })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body?.error?.message ?? `Request failed (HTTP ${res.status})`)
  }
  return res.json()
}

// ── Provision replica ────────────────────────────────────────────────────────

type ReplicaVariables = { ref: string; docker_host?: string }
type DeprovisionReplicaVariables = { ref: string; replicaRef: string }

export const useProvisionReplicaMutation = (
  options: UseCustomMutationOptions<unknown, ResponseError, ReplicaVariables> = {}
) => {
  const queryClient = useQueryClient()
  return useMutation<unknown, ResponseError, ReplicaVariables>({
    mutationFn: ({ ref, docker_host }) =>
      callReplica(ref, 'POST', docker_host !== undefined ? { docker_host } : undefined),
    async onSuccess(data, variables, context) {
      await queryClient.invalidateQueries({ queryKey: projectKeys.detail(variables.ref) })
      await options.onSuccess?.(data, variables, context)
    },
    async onError(error, variables, context) {
      if (options.onError === undefined) {
        toast.error(`Failed to provision replica: ${error.message}`)
      } else {
        options.onError(error, variables, context)
      }
    },
    ...options,
  })
}

// ── Deprovision replica ──────────────────────────────────────────────────────

export const useDeprovisionReplicaMutation = (
  options: UseCustomMutationOptions<unknown, ResponseError, DeprovisionReplicaVariables> = {}
) => {
  const queryClient = useQueryClient()
  return useMutation<unknown, ResponseError, DeprovisionReplicaVariables>({
    mutationFn: ({ ref, replicaRef }) => callReplica(ref, 'DELETE', undefined, replicaRef),
    async onSuccess(data, variables, context) {
      await queryClient.invalidateQueries({ queryKey: projectKeys.detail(variables.ref) })
      await options.onSuccess?.(data, variables, context)
    },
    async onError(error, variables, context) {
      if (options.onError === undefined) {
        toast.error(`Failed to deprovision replica: ${error.message}`)
      } else {
        options.onError(error, variables, context)
      }
    },
    ...options,
  })
}

// ── Cluster failover ─────────────────────────────────────────────────────────

export const useClusterFailoverMutation = (
  options: UseCustomMutationOptions<unknown, ResponseError, ReplicaVariables> = {}
) => {
  const queryClient = useQueryClient()
  return useMutation<unknown, ResponseError, ReplicaVariables>({
    mutationFn: ({ ref }) => callClusterFailover(ref),
    async onSuccess(data, variables, context) {
      await queryClient.invalidateQueries({ queryKey: projectKeys.detail(variables.ref) })
      await options.onSuccess?.(data, variables, context)
    },
    async onError(error, variables, context) {
      if (options.onError === undefined) {
        toast.error(`Cluster failover failed: ${error.message}`)
      } else {
        options.onError(error, variables, context)
      }
    },
    ...options,
  })
}
