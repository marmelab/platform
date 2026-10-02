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
 * Provisions a warm standby stack for the given primary project.
 *
 * The standby gets fresh infra credentials (new Postgres password, pooler tenant, etc.)
 * but inherits the primary's JWT secret, anon key, and service key so that tokens issued
 * before a failover remain valid after one.
 *
 * Pass targetDockerHost to provision the standby on a different Docker host than the
 * primary (e.g. "ssh://user@standby-host"). When omitted the standby lands on the same
 * Docker daemon as the primary.
 *
 * Returns the standby's ref.
 */
export async function provisionStandby(primaryRef: string, targetDockerHost?: string): Promise<string> {
  const primary = getStoredProjectByRef(primaryRef)
  if (!primary) throw new Error(`Project ${primaryRef} not found`)
  if (primary.role === 'standby') throw new Error(`Cannot provision a standby for a standby project`)
  if (primary.standby_ref) throw new Error(`Project ${primaryRef} already has a standby (${primary.standby_ref})`)

  const allKongPorts = getStoredProjects()
    .map((p) => p.kong_http_port)
    .filter((p): p is number => p !== undefined)
  const usedPorts = [...new Set([...allKongPorts, ...discoverDockerStackPorts()])]
  const ports = allocateNextPorts(usedPorts)

  // Fresh infra creds; inherit API credentials so client tokens survive failover
  const credentials = {
    ...generateProjectCredentials(),
    jwtSecret: primary.jwt_secret,
    anonKey: primary.anon_key,
    serviceKey: primary.service_key,
  }

  // Standby runs on targetDockerHost if given; otherwise on the same host as the primary.
  const standbyDockerHost = targetDockerHost ?? primary.docker_host
  const standbyHostname = extractDockerHostname(standbyDockerHost)
  const publicUrl = `http://${standbyHostname}:${ports.kongHttpPort}`

  const standby = createStoredProject({
    name: `${primary.name} (standby)`,
    organization_slug: primary.organization_slug,
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
    ...(standbyDockerHost !== undefined && { docker_host: standbyDockerHost }),
  })

  const dockerProject = `supabase-${standby.ref}`
  updateProjectFields(standby.ref, {
    docker_project: dockerProject,
    role: 'standby',
    primary_ref: primaryRef,
  })
  updateProjectFields(primaryRef, { role: 'primary', standby_ref: standby.ref })

  launchProjectStack({ ref: standby.ref, name: primary.name, ports, credentials, docker_host: standbyDockerHost })
    .then(() => waitForProjectHealth(publicUrl))
    .then(() => updateProjectStatus(standby.ref, 'ACTIVE_HEALTHY'))
    .then(() => setupReplication(primaryRef, standby.ref))
    .catch((err: unknown) => {
      console.error(`[failover] Standby launch/replication failed for ${standby.ref}:`, err instanceof Error ? err.message : err)
      updateProjectStatus(standby.ref, 'INACTIVE')
    })

  return standby.ref
}

/**
 * Promotes the standby stack to replace a failed primary.
 *
 * Steps:
 *  1. Copies the standby's connection fields onto the primary's registry entry (same ref, new URL/ports).
 *  2. Renames the standby's stack directory to the primary's ref so teardown still works.
 *  3. Removes the standby registry entry.
 *  4. Tears down the old (failed) primary Docker stack in the background.
 *  5. Provisions a fresh standby for the promoted stack in the background.
 *
 * If there is no standby the primary is simply marked INACTIVE.
 */
export async function triggerFailover(primaryRef: string): Promise<void> {
  const primary = getStoredProjectByRef(primaryRef)
  if (!primary) throw new Error(`Project ${primaryRef} not found`)

  if (!primary.standby_ref) {
    updateProjectStatus(primaryRef, 'INACTIVE')
    console.warn(`[failover] ${primary.name} (${primaryRef}) has no standby — marking INACTIVE`)
    return
  }

  const standby = getStoredProjectByRef(primary.standby_ref)
  if (!standby) {
    updateProjectFields(primaryRef, { standby_ref: undefined, role: undefined })
    updateProjectStatus(primaryRef, 'INACTIVE')
    console.warn(`[failover] Standby ${primary.standby_ref} not found — marking ${primaryRef} INACTIVE`)
    return
  }

  const oldDockerProject = primary.docker_project

  // Promote the standby Postgres to writable primary before we redirect traffic to it
  await promoteStandby(standby.ref)

  // Swap standby connection details onto primary registry entry
  updateProjectFields(primaryRef, {
    public_url: standby.public_url,
    kong_http_port: standby.kong_http_port,
    postgres_port: standby.postgres_port,
    pooler_port: standby.pooler_port,
    pooler_tenant_id: standby.pooler_tenant_id,
    docker_project: standby.docker_project,
    status: standby.status,
    role: undefined,
    standby_ref: undefined,
    failure_streak: 0,
    failover_count: (primary.failover_count ?? 0) + 1,
    last_failover_at: new Date().toISOString(),
  })

  // Rename standby stack dir → primary ref so future teardown uses the right .env
  const primaryStackDir = path.join(STACKS_DIR, primaryRef)
  const standbyStackDir = path.join(STACKS_DIR, standby.ref)
  try {
    if (fs.existsSync(primaryStackDir)) fs.rmSync(primaryStackDir, { recursive: true, force: true })
    if (fs.existsSync(standbyStackDir)) fs.renameSync(standbyStackDir, primaryStackDir)
  } catch (err) {
    console.warn('[failover] Stack dir rename failed (non-fatal):', err)
  }

  // Remove standby entry — it has been absorbed into the primary
  deleteStoredProject(standby.ref)

  console.log(
    `[failover] ${primary.name} (${primaryRef}) failed over: ` +
      `${primary.public_url} → ${standby.public_url} ` +
      `(failover #${(primary.failover_count ?? 0) + 1})`
  )

  // Tear down the failed primary stack on its original Docker host
  if (oldDockerProject) {
    teardownProjectStack(primaryRef, oldDockerProject, primary.docker_host).catch((err) =>
      console.warn(`[failover] Teardown of ${oldDockerProject} failed (non-fatal):`, err)
    )
  }

  // Keep a standby always ready; provision it on the old primary's host (standby now runs
  // on the former standby's host — the new standby should mirror that arrangement).
  provisionStandby(primaryRef, standby.docker_host).catch((err) =>
    console.error(`[failover] Failed to provision replacement standby for ${primaryRef}:`, err)
  )
}
