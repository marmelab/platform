import fs from 'node:fs'
import path from 'node:path'

import {
  createStoredProject,
  deleteStoredProject,
  getStoredProjectByRef,
  getStoredProjects,
  updateProjectFields,
  updateProjectStatus,
} from './projectsStore'
import {
  allocateNextPorts,
  discoverDockerStackPorts,
  extractDockerHostname,
  generateProjectCredentials,
  launchProjectStack,
  teardownProjectStack,
  waitForProjectHealth,
} from './orchestrator'
import { dropReplicationSlot, promoteStandby, setupReplication } from './replicationManager'

const DATA_DIR = process.env.STUDIO_DATA_DIR || path.join(/*turbopackIgnore: true*/ process.cwd(), '.studio-data')
const STACKS_DIR = path.join(DATA_DIR, 'stacks')

/**
 * Provisions a new read replica for the given master project.
 *
 * Inherits the master's JWT credentials so tokens issued before a failover
 * remain valid after promotion. Each replica gets a unique replica_rank
 * (max existing rank + 1) which determines promotion priority.
 *
 * Returns the replica's ref.
 */
export async function provisionReplica(masterRef: string, targetDockerHost?: string): Promise<string> {
  const master = getStoredProjectByRef(masterRef)
  if (!master) throw new Error(`Project ${masterRef} not found`)
  if (master.role === 'replica') throw new Error('Cannot provision a replica for a replica project')
  if (master.role === 'standby') throw new Error('Cannot provision a replica for a standby project')

  const allProjects = getStoredProjects()
  const allKongPorts = allProjects
    .map((p) => p.kong_http_port)
    .filter((p): p is number => p !== undefined)
  const usedPorts = [...new Set([...allKongPorts, ...discoverDockerStackPorts()])]
  const ports = allocateNextPorts(usedPorts)

  // Fresh infra creds; inherit API credentials so client tokens survive failover
  const credentials = {
    ...generateProjectCredentials(),
    jwtSecret: master.jwt_secret,
    anonKey: master.anon_key,
    serviceKey: master.service_key,
  }

  const clusterId = master.cluster_id ?? masterRef

  // Promotion priority: one higher than the current maximum replica rank in this cluster
  const clusterReplicas = allProjects.filter(
    (p) => p.cluster_id === clusterId && p.role === 'replica'
  )
  const nextRank =
    clusterReplicas.length > 0
      ? Math.max(...clusterReplicas.map((p) => p.replica_rank ?? 0)) + 1
      : 1

  const replicaDockerHost = targetDockerHost ?? master.docker_host
  const replicaHostname = extractDockerHostname(replicaDockerHost)
  const publicUrl = `http://${replicaHostname}:${ports.kongHttpPort}`

  const replica = createStoredProject({
    name: `${master.name} (replica ${nextRank})`,
    organization_slug: master.organization_slug,
    public_url: publicUrl,
    postgres_port: ports.postgresPort,
    kong_http_port: ports.kongHttpPort,
    pooler_port: ports.poolerPort,
    pooler_tenant_id: credentials.poolerTenantId,
    docker_project: 'placeholder',
    db_password: credentials.postgresPassword,
    anon_key: credentials.anonKey,
    service_key: credentials.serviceKey,
    jwt_secret: credentials.jwtSecret,
    status: 'COMING_UP',
    ...(replicaDockerHost !== undefined && { docker_host: replicaDockerHost }),
  })

  const dockerProject = `supabase-${replica.ref}`
  updateProjectFields(replica.ref, {
    docker_project: dockerProject,
    role: 'replica',
    cluster_id: clusterId,
    replica_rank: nextRank,
  })

  // Mark master as cluster master if not already
  if (!master.cluster_id) {
    updateProjectFields(masterRef, { cluster_id: clusterId })
  }

  launchProjectStack({ ref: replica.ref, name: master.name, ports, credentials, docker_host: replicaDockerHost })
    .then(() => waitForProjectHealth(publicUrl))
    .then(() => updateProjectStatus(replica.ref, 'ACTIVE_HEALTHY'))
    .then(() => setupReplication(masterRef, replica.ref))
    .catch((err: unknown) => {
      console.error(
        `[cluster] Replica launch/replication failed for ${replica.ref}:`,
        err instanceof Error ? err.message : err
      )
      updateProjectStatus(replica.ref, 'INACTIVE')
    })

  return replica.ref
}

/**
 * Drops the replication slot, tears down the replica stack, and removes it from the registry.
 */
export async function deprovisionReplica(masterRef: string, replicaRef: string): Promise<void> {
  const replica = getStoredProjectByRef(replicaRef)
  if (!replica) throw new Error(`Replica ${replicaRef} not found`)
  if (replica.cluster_id !== (getStoredProjectByRef(masterRef)?.cluster_id ?? masterRef)) {
    throw new Error(`Replica ${replicaRef} does not belong to cluster of ${masterRef}`)
  }

  dropReplicationSlot(masterRef, replicaRef)
  deleteStoredProject(replicaRef)

  if (replica.docker_project) {
    teardownProjectStack(replicaRef, replica.docker_project, replica.docker_host).catch((err) =>
      console.warn(`[cluster] Replica teardown failed for ${replicaRef}:`, err)
    )
  }
}

/**
 * Promotes the highest-priority healthy replica to replace a failed master.
 *
 * Steps:
 *  1. Find all healthy replicas in the cluster, ordered by replica_rank ascending.
 *  2. Promote the top candidate's Postgres to writable.
 *  3. Swap its connection details onto the master's registry entry (master ref unchanged).
 *  4. Rename the replica's stack dir to the master's ref.
 *  5. Remove the promoted replica's registry entry.
 *  6. Tear down the failed master stack in the background.
 *  7. Provision a fresh replica on the old master's docker_host.
 *
 * If no healthy replicas exist, the master is marked INACTIVE.
 */
export async function triggerClusterFailover(masterRef: string): Promise<void> {
  const master = getStoredProjectByRef(masterRef)
  if (!master) throw new Error(`Project ${masterRef} not found`)

  const clusterId = master.cluster_id ?? masterRef
  const allProjects = getStoredProjects()

  const candidates = allProjects
    .filter(
      (p) =>
        p.cluster_id === clusterId &&
        p.role === 'replica' &&
        p.status === 'ACTIVE_HEALTHY'
    )
    .sort((a, b) => (a.replica_rank ?? 0) - (b.replica_rank ?? 0))

  if (candidates.length === 0) {
    updateProjectStatus(masterRef, 'INACTIVE')
    console.warn(`[cluster] ${master.name} (${masterRef}) has no healthy replicas — marking INACTIVE`)
    return
  }

  const promoted = candidates[0]
  const oldDockerProject = master.docker_project

  // Promote the replica Postgres to writable primary
  await promoteStandby(promoted.ref)

  // Swap replica connection details onto the master registry entry
  updateProjectFields(masterRef, {
    public_url: promoted.public_url,
    kong_http_port: promoted.kong_http_port,
    postgres_port: promoted.postgres_port,
    pooler_port: promoted.pooler_port,
    pooler_tenant_id: promoted.pooler_tenant_id,
    docker_project: promoted.docker_project,
    status: 'ACTIVE_HEALTHY',
    failure_streak: 0,
    failover_count: (master.failover_count ?? 0) + 1,
    last_failover_at: new Date().toISOString(),
  })

  // Rename replica stack dir → master ref so teardown still works
  const masterStackDir = path.join(STACKS_DIR, masterRef)
  const replicaStackDir = path.join(STACKS_DIR, promoted.ref)
  try {
    if (fs.existsSync(masterStackDir)) fs.rmSync(masterStackDir, { recursive: true, force: true })
    if (fs.existsSync(replicaStackDir)) fs.renameSync(replicaStackDir, masterStackDir)
  } catch (err) {
    console.warn('[cluster] Stack dir rename failed (non-fatal):', err)
  }

  // Remove the promoted replica — it's been absorbed into the master
  deleteStoredProject(promoted.ref)

  // Re-rank remaining replicas (fill the gap left by the promoted one)
  const remaining = getStoredProjects()
    .filter((p) => p.cluster_id === clusterId && p.role === 'replica')
    .sort((a, b) => (a.replica_rank ?? 0) - (b.replica_rank ?? 0))
  remaining.forEach((p, i) => {
    if ((p.replica_rank ?? 0) !== i + 1) {
      updateProjectFields(p.ref, { replica_rank: i + 1 })
    }
  })

  console.log(
    `[cluster] ${master.name} (${masterRef}) failed over: ` +
      `${master.public_url} → ${promoted.public_url} ` +
      `(failover #${(master.failover_count ?? 0) + 1})`
  )

  // Tear down the failed master stack
  if (oldDockerProject) {
    teardownProjectStack(masterRef, oldDockerProject, master.docker_host).catch((err) =>
      console.warn(`[cluster] Teardown of ${oldDockerProject} failed (non-fatal):`, err)
    )
  }

  // Provision a replacement replica on the old master's host
  provisionReplica(masterRef, master.docker_host).catch((err) =>
    console.error(`[cluster] Failed to provision replacement replica for ${masterRef}:`, err)
  )
}
