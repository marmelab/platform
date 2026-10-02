import crypto from 'node:crypto'
import { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import { STUDIO_AUTH_GOTRUE } from '@/lib/constants'
import { getGoTrueAuthMember } from '@/lib/api/self-hosted/studioGoTrue'
import type { StoredMember } from '@/lib/api/self-hosted/membersStore'
import {
  createStoredProject,
  createEmbeddedStoredProject,
  createPocketBaseStoredProject,
  createEmbeddedPocketBaseStoredProject,
  createPocketBaseCollectionStoredProject,
  getStoredProjects,
  getStoredProjectByRef,
  updateProjectFields,
  updateProjectStatus,
  updateStoredProjectField,
} from '@/lib/api/self-hosted/projectsStore'
import {
  allocateNextPorts,
  discoverDockerStackPorts,
  extractDockerHostname,
  generateProjectCredentials,
  launchProjectStack,
  waitForProjectHealth,
} from '@/lib/api/self-hosted/orchestrator'
import {
  createEmbeddedDatabase,
  createEmbeddedDatabaseInProject,
  embeddedConnectionInfo,
  embeddedConnectionInfoForProject,
  embeddedDbName,
} from '@/lib/api/self-hosted/embeddedOrchestrator'
import {
  allocatePocketBasePort,
  discoverPocketBasePorts,
  extractPocketBaseHostname,
  generatePocketBaseCredentials,
  launchPocketBaseStack,
  launchEmbeddedPocketBase,
  waitForPocketBaseHealth,
} from '@/lib/api/self-hosted/pocketbaseOrchestrator'
import { provisionReplica } from '@/lib/api/self-hosted/clusterManager'
import { requireTier } from '@/lib/api/self-hosted/licenseManager'

export default (req: NextApiRequest, res: NextApiResponse) => apiWrapper(req, res, handler)

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { method } = req

  let authMember: StoredMember | null = null
  if (STUDIO_AUTH_GOTRUE) {
    authMember = await getGoTrueAuthMember(req)
    if (!authMember) {
      return res.status(401).json({ data: null, error: { message: 'Unauthorized' } })
    }
  }

  switch (method) {
    case 'GET':
      return handleGetAll(req, res, authMember)
    case 'POST':
      return handleCreate(req, res)
    default:
      res.setHeader('Allow', ['GET', 'POST'])
      res.status(405).json({ data: null, error: { message: `Method ${method} Not Allowed` } })
  }
}

const handleGetAll = async (
  req: NextApiRequest,
  res: NextApiResponse,
  authMember: StoredMember | null = null
) => {
  const { limit = '100', offset = '0', search } = req.query

  // Standbys and replicas are internal implementation details — hide them from the project list
  let projects = getStoredProjects().filter((p) => p.role !== 'standby' && p.role !== 'replica')

  // Project-scoped members only see their allowed projects
  if (authMember?.project_refs && authMember.project_refs.length > 0) {
    projects = projects.filter((p) => authMember.project_refs!.includes(p.ref))
  }

  if (search && typeof search === 'string' && search.length > 0) {
    const q = search.toLowerCase()
    projects = projects.filter((p) => p.name.toLowerCase().includes(q))
  }

  const total = projects.length
  const pageLimit = Number(limit)
  const pageOffset = Number(offset)
  const paged = projects.slice(pageOffset, pageOffset + pageLimit)

  // Return paginated format expected by useProjectsInfiniteQuery (ListProjectsPaginatedResponse)
  return res.status(200).json({
    pagination: { count: total, limit: pageLimit, offset: pageOffset },
    projects: paged.map(({ db_password, anon_key, service_key, jwt_secret, ...rest }) => rest),
  })
}

const handleCreate = async (req: NextApiRequest, res: NextApiResponse) => {
  const { name, organization_slug, docker_host, cluster_mode, creation_mode, embedded_target_ref } = req.body

  if (!name?.trim()) {
    return res.status(400).json({ data: null, error: { message: 'Project name is required' } })
  }

  if (cluster_mode) {
    const license = requireTier('cluster')
    if (!license.ok) return res.status(402).json({ data: null, error: { message: license.message } })
  }

  // ── Embedded mode: create a database inside a Postgres instance ─────────────
  if (creation_mode === 'embedded') {
    if (!process.env.PG_META_CRYPTO_KEY) {
      return res.status(400).json({
        data: null,
        error: {
          message:
            'PG_META_CRYPTO_KEY is not configured. ' +
            'Embedded projects require it to route Studio requests to the new database.',
        },
      })
    }

    const ref = crypto.randomBytes(6).toString('hex')
    const targetRef = embedded_target_ref && typeof embedded_target_ref === 'string'
      ? embedded_target_ref
      : null

    // Resolve target project (if provided)
    let targetProject = targetRef ? getStoredProjectByRef(targetRef) : null
    if (targetRef && !targetProject) {
      return res.status(400).json({ data: null, error: { message: `Target project "${targetRef}" not found` } })
    }
    if (targetProject && !targetProject.docker_project) {
      return res.status(400).json({ data: null, error: { message: 'Target project must be a Docker-orchestrated Supabase project' } })
    }

    try {
      if (targetProject) {
        await createEmbeddedDatabaseInProject(ref, targetProject)
      } else {
        await createEmbeddedDatabase(ref)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return res.status(500).json({ data: null, error: { message: msg } })
    }

    const conn = targetProject
      ? embeddedConnectionInfoForProject(targetProject)
      : { ...embeddedConnectionInfo(),
          public_url: process.env.SUPABASE_PUBLIC_URL || 'http://localhost:8000',
          anon_key: process.env.SUPABASE_ANON_KEY || '',
          service_key: process.env.SUPABASE_SERVICE_KEY || '',
          jwt_secret: process.env.AUTH_JWT_SECRET || '',
        }

    const project = createEmbeddedStoredProject(ref, {
      name: name.trim(),
      organization_slug: organization_slug ?? 'default-org-slug',
      public_url: conn.public_url,
      db_host: conn.db_host,
      db_port: conn.db_port,
      db_user: conn.db_user,
      db_name: embeddedDbName(ref),
      db_password: conn.db_password,
      anon_key: conn.anon_key,
      service_key: conn.service_key,
      jwt_secret: conn.jwt_secret,
      ...(targetRef && { embedded_target_ref: targetRef }),
    })

    return res.status(201).json({
      id: project.id,
      ref: project.ref,
      name: project.name,
      organization_id: project.organization_id,
      organization_slug: project.organization_slug,
      cloud_provider: project.cloud_provider,
      status: 'ACTIVE_HEALTHY',
      region: project.region,
      inserted_at: project.inserted_at,
    })
  }

  // ── PocketBase mode: single-container PocketBase stack ──────────────────────
  if (creation_mode === 'pocketbase') {
    const ref = crypto.randomBytes(6).toString('hex')
    const credentials = generatePocketBaseCredentials()

    const storedPbPorts = getStoredProjects()
      .map((p) => p.pocketbase_port)
      .filter((p): p is number => p !== undefined)
    const livePbPorts = discoverPocketBasePorts()
    const usedPbPorts = [...new Set([...storedPbPorts, ...livePbPorts])]
    const pocketbasePort = allocatePocketBasePort(usedPbPorts)

    const dockerHostVal = docker_host && typeof docker_host === 'string' ? docker_host : undefined
    const hostname = extractPocketBaseHostname(dockerHostVal)
    const publicUrl = `http://${hostname}:${pocketbasePort}`
    const dockerProject = `pocketbase-${ref}`

    const project = createPocketBaseStoredProject(ref, {
      name: name.trim(),
      organization_slug: organization_slug ?? 'default-org-slug',
      public_url: publicUrl,
      pocketbase_port: pocketbasePort,
      docker_project: dockerProject,
      pocketbase_admin_email: credentials.adminEmail,
      pocketbase_admin_password: credentials.adminPassword,
      ...(dockerHostVal && { docker_host: dockerHostVal }),
    })

    launchPocketBaseStack({ ref, pocketbasePort, credentials, dockerHost: dockerHostVal })
      .then(() => waitForPocketBaseHealth(publicUrl))
      .then(() => updateProjectStatus(project.ref, 'ACTIVE_HEALTHY'))
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`[pocketbase] Stack launch failed for ${project.ref}: ${msg}`)
        updateProjectStatus(project.ref, 'INACTIVE')
      })

    return res.status(201).json({
      id: project.id,
      ref: project.ref,
      name: project.name,
      organization_id: project.organization_id,
      organization_slug: project.organization_slug,
      cloud_provider: project.cloud_provider,
      status: 'COMING_UP',
      region: project.region,
      inserted_at: project.inserted_at,
    })
  }

  // ── PocketBase embedded: collection namespace inside existing PB, or plain docker run ──
  if (creation_mode === 'pocketbase-embedded') {
    const ref = crypto.randomBytes(6).toString('hex')
    const targetRef = embedded_target_ref && typeof embedded_target_ref === 'string'
      ? embedded_target_ref
      : null

    // ── Targeted: no Docker — logical namespace inside an existing PocketBase ──
    if (targetRef) {
      const targetProject = getStoredProjectByRef(targetRef)
      if (!targetProject) {
        return res.status(400).json({ data: null, error: { message: `Target project "${targetRef}" not found` } })
      }
      if (targetProject.creation_mode !== 'pocketbase' && targetProject.creation_mode !== 'pocketbase-embedded') {
        return res.status(400).json({ data: null, error: { message: 'Target project must be a PocketBase project' } })
      }
      if (!targetProject.pocketbase_admin_email || !targetProject.pocketbase_admin_password) {
        return res.status(400).json({ data: null, error: { message: 'Target PocketBase project is missing credentials' } })
      }

      const collectionPrefix = `${ref}_`
      const project = createPocketBaseCollectionStoredProject(ref, {
        name: name.trim(),
        organization_slug: organization_slug ?? 'default-org-slug',
        public_url: targetProject.public_url,
        pocketbase_admin_email: targetProject.pocketbase_admin_email,
        pocketbase_admin_password: targetProject.pocketbase_admin_password,
        embedded_target_ref: targetRef,
        pocketbase_collection_prefix: collectionPrefix,
      })

      return res.status(201).json({
        id: project.id,
        ref: project.ref,
        name: project.name,
        organization_id: project.organization_id,
        organization_slug: project.organization_slug,
        cloud_provider: project.cloud_provider,
        status: 'ACTIVE_HEALTHY',
        region: project.region,
        inserted_at: project.inserted_at,
      })
    }

    // ── Standalone: plain docker run, no Compose stack ────────────────────────
    const credentials = generatePocketBaseCredentials()

    const storedPbPorts = getStoredProjects()
      .map((p) => p.pocketbase_port)
      .filter((p): p is number => p !== undefined)
    const livePbPorts = discoverPocketBasePorts()
    const usedPbPorts = [...new Set([...storedPbPorts, ...livePbPorts])]
    const pocketbasePort = allocatePocketBasePort(usedPbPorts)

    const dockerHostVal = docker_host && typeof docker_host === 'string' ? docker_host : undefined
    const hostname = extractPocketBaseHostname(dockerHostVal)
    const publicUrl = `http://${hostname}:${pocketbasePort}`

    const project = createEmbeddedPocketBaseStoredProject(ref, {
      name: name.trim(),
      organization_slug: organization_slug ?? 'default-org-slug',
      public_url: publicUrl,
      pocketbase_port: pocketbasePort,
      pocketbase_admin_email: credentials.adminEmail,
      pocketbase_admin_password: credentials.adminPassword,
      ...(dockerHostVal && { docker_host: dockerHostVal }),
    })

    launchEmbeddedPocketBase({ ref, pocketbasePort, credentials, dockerHost: dockerHostVal })
      .then(() => waitForPocketBaseHealth(publicUrl))
      .then(() => updateProjectStatus(project.ref, 'ACTIVE_HEALTHY'))
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`[pocketbase-embedded] Launch failed for ${project.ref}: ${msg}`)
        updateProjectStatus(project.ref, 'INACTIVE')
      })

    return res.status(201).json({
      id: project.id,
      ref: project.ref,
      name: project.name,
      organization_id: project.organization_id,
      organization_slug: project.organization_slug,
      cloud_provider: project.cloud_provider,
      status: 'COMING_UP',
      region: project.region,
      inserted_at: project.inserted_at,
    })
  }

  if (!process.env.PG_META_CRYPTO_KEY) {
    return res.status(400).json({
      data: null,
      error: {
        message:
          'PG_META_CRYPTO_KEY is not configured. ' +
          'Add it to your Studio .env file and ensure it matches the CRYPTO_KEY in your pg-meta service.',
      },
    })
  }

  // Collect ports already used by stored projects (skip legacy projects without kong_http_port)
  // plus any live Docker stacks discovered via the Docker daemon.
  const storedKongPorts = getStoredProjects()
    .map((p) => p.kong_http_port)
    .filter((p): p is number => p !== undefined)
  const dockerKongPorts = discoverDockerStackPorts()
  const usedPorts = [...new Set([...storedKongPorts, ...dockerKongPorts])]

  const ports = allocateNextPorts(usedPorts)
  const credentials = generateProjectCredentials()

  const hostname = extractDockerHostname(docker_host ?? undefined)
  const publicUrl = `http://${hostname}:${ports.kongHttpPort}`

  // Persist the record immediately with COMING_UP so the UI can show progress
  const project = createStoredProject({
    name: name.trim(),
    organization_slug: organization_slug ?? 'default-org-slug',
    public_url: publicUrl,
    postgres_port: ports.postgresPort,
    kong_http_port: ports.kongHttpPort,
    pooler_port: ports.poolerPort,
    pooler_tenant_id: credentials.poolerTenantId,
    docker_project: `supabase-placeholder`, // overwritten below
    db_password: credentials.postgresPassword,
    anon_key: credentials.anonKey,
    service_key: credentials.serviceKey,
    jwt_secret: credentials.jwtSecret,
    status: 'COMING_UP',
    ...(docker_host && typeof docker_host === 'string' && { docker_host }),
  })

  // Now we know the ref; set the real docker_project name
  const dockerProject = `supabase-${project.ref}`
  updateStoredProjectField(project.ref, 'docker_project', dockerProject)

  // Launch the Docker Compose stack in the background; the caller gets the
  // project record immediately (status=COMING_UP) and can poll for status.
  const dockerHostVal = docker_host && typeof docker_host === 'string' ? docker_host : undefined
  launchProjectStack({
    ref: project.ref,
    name: name.trim(),
    ports,
    credentials,
    ...(dockerHostVal && { docker_host: dockerHostVal }),
  })
    .then(() => waitForProjectHealth(publicUrl))
    .then(() => updateProjectStatus(project.ref, 'ACTIVE_HEALTHY'))
    .then(() => {
      if (cluster_mode) {
        // Mark master as cluster head and provision the first replica
        updateProjectFields(project.ref, { cluster_id: project.ref })
        provisionReplica(project.ref, dockerHostVal).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err)
          console.error(`[cluster] Initial replica provision failed for ${project.ref}: ${msg}`)
        })
      }
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[multi-head] Stack launch failed for ${project.ref}: ${msg}`)
      updateProjectStatus(project.ref, 'INACTIVE')
    })

  return res.status(201).json({
    id: project.id,
    ref: project.ref,
    name: project.name,
    organization_id: project.organization_id,
    organization_slug: project.organization_slug,
    cloud_provider: project.cloud_provider,
    status: 'COMING_UP',
    region: project.region,
    inserted_at: project.inserted_at,
  })
}
