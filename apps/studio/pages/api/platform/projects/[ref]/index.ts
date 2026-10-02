import { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import { STUDIO_AUTH_GOTRUE } from '@/lib/constants'
import { getGoTrueAuthMember } from '@/lib/api/self-hosted/studioGoTrue'
import { teardownProjectStack } from '@/lib/api/self-hosted/orchestrator'
import {
  dropEmbeddedDatabase,
  dropEmbeddedDatabaseInProject,
} from '@/lib/api/self-hosted/embeddedOrchestrator'
import {
  teardownPocketBaseStack,
  teardownEmbeddedPocketBase,
} from '@/lib/api/self-hosted/pocketbaseOrchestrator'
import { dropReplicationSlot } from '@/lib/api/self-hosted/replicationManager'
import { deleteStoredProject, getStoredProjectByRef, getStoredProjects, updateProjectFields } from '@/lib/api/self-hosted/projectsStore'
import { PROJECT_REST_URL } from '@/lib/constants/api'

export default (req: NextApiRequest, res: NextApiResponse) => apiWrapper(req, res, handler)

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { method } = req

  if (STUDIO_AUTH_GOTRUE) {
    const member = await getGoTrueAuthMember(req)
    if (!member) {
      return res.status(401).json({ data: null, error: { message: 'Unauthorized' } })
    }
  }

  switch (method) {
    case 'GET':
      return handleGet(req, res)
    case 'PATCH':
      return handlePatch(req, res)
    case 'DELETE':
      return handleDelete(req, res)
    default:
      res.setHeader('Allow', ['GET', 'PATCH', 'DELETE'])
      res.status(405).json({ data: null, error: { message: `Method ${method} Not Allowed` } })
  }
}

const handleGet = async (req: NextApiRequest, res: NextApiResponse) => {
  const ref = req.query.ref as string
  const project = getStoredProjectByRef(ref)

  if (!project) {
    return res.status(404).json({ data: null, error: { message: 'Project not found' } })
  }

  // Strip sensitive fields before returning
  const { db_password, anon_key, service_key, jwt_secret, ...safeProject } = project

  // Embed replica list when this project is a cluster master
  const clusterId = project.cluster_id
  const replicas =
    clusterId
      ? getStoredProjects()
          .filter((p) => p.cluster_id === clusterId && p.role === 'replica')
          .map(({ db_password: _pw, anon_key: _ak, service_key: _sk, jwt_secret: _js, ...r }) => r)
      : undefined

  return res.status(200).json({
    ...safeProject,
    ...(replicas !== undefined && { replicas }),
    connectionString: '',
    restUrl: PROJECT_REST_URL,
  })
}

const handlePatch = async (req: NextApiRequest, res: NextApiResponse) => {
  const ref = req.query.ref as string
  const { name } = req.body

  if (!name?.trim()) {
    return res.status(400).json({ data: null, error: { message: 'Project name cannot be empty.' } })
  }

  const project = getStoredProjectByRef(ref)
  if (!project) {
    return res.status(404).json({ data: null, error: { message: 'Project not found' } })
  }

  updateProjectFields(ref, { name: String(name).trim() })
  return res.status(200).json({ ...project, name: String(name).trim() })
}

const handleDelete = async (req: NextApiRequest, res: NextApiResponse) => {
  const ref = req.query.ref as string
  const project = getStoredProjectByRef(ref)

  if (!project) {
    return res.status(404).json({ data: null, error: { message: 'Project not found' } })
  }

  if (ref === 'default') {
    return res
      .status(400)
      .json({ data: null, error: { message: 'The default project cannot be deleted.' } })
  }

  // Cascade: tear down standby and all replicas that belong to this project's cluster
  const allProjects = getStoredProjects()

  // Standby
  if (project.standby_ref) {
    const standby = allProjects.find((p) => p.ref === project.standby_ref)
    if (standby) {
      dropReplicationSlot(ref, standby.ref)
      deleteStoredProject(standby.ref)
      if (standby.docker_project) {
        teardownProjectStack(standby.ref, standby.docker_project, standby.docker_host).catch(() => {})
      }
    }
  }

  // Cluster replicas (cluster_id === ref of the master being deleted)
  const clusterId = project.cluster_id
  if (clusterId) {
    const replicas = allProjects.filter((p) => p.cluster_id === clusterId && p.role === 'replica')
    for (const replica of replicas) {
      dropReplicationSlot(ref, replica.ref)
      deleteStoredProject(replica.ref)
      if (replica.docker_project) {
        teardownProjectStack(replica.ref, replica.docker_project, replica.docker_host).catch(() => {})
      }
    }
  }

  // Remove the project itself
  deleteStoredProject(ref)

  // Tear down: Docker Compose stack or embedded Postgres database
  if (project.creation_mode === 'embedded') {
    if (project.embedded_target_ref) {
      // DB lives inside another project's Postgres — drop it there
      const targetProject = allProjects.find((p) => p.ref === project.embedded_target_ref)
      if (targetProject) {
        dropEmbeddedDatabaseInProject(ref, targetProject).catch((err: unknown) => {
          console.error(
            `[embedded] DB drop in target ${project.embedded_target_ref} failed for ${ref}: ${err instanceof Error ? err.message : err}`
          )
        })
      }
    } else {
      dropEmbeddedDatabase(ref).catch((err: unknown) => {
        console.error(
          `[embedded] DB drop failed for ${ref}: ${err instanceof Error ? err.message : err}`
        )
      })
    }
  } else if (project.creation_mode === 'pocketbase') {
    try {
      teardownPocketBaseStack(ref, project.docker_host)
    } catch (err) {
      console.error(
        `[pocketbase] Stack teardown failed for ${ref}: ${err instanceof Error ? err.message : err}`
      )
    }
  } else if (project.creation_mode === 'pocketbase-embedded') {
    if (!project.embedded_target_ref) {
      // Has its own Docker container — tear it down
      try {
        teardownEmbeddedPocketBase(ref, project.docker_host)
      } catch (err) {
        console.error(
          `[pocketbase-embedded] Teardown failed for ${ref}: ${err instanceof Error ? err.message : err}`
        )
      }
    }
    // If embedded_target_ref is set, this is a collection namespace — no Docker to clean up
  } else if (project.docker_project) {
    teardownProjectStack(ref, project.docker_project, project.docker_host).catch((err: unknown) => {
      console.error(
        `[multi-head] Stack teardown failed for ${ref}: ${err instanceof Error ? err.message : err}`
      )
    })
  }

  return res.status(200).json({ ref, name: project.name })
}
