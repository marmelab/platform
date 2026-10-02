import { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import { getStoredProjects } from '@/lib/api/self-hosted/projectsStore'
import { STUDIO_AUTH_GOTRUE } from '@/lib/constants'
import { getGoTrueAuthMember } from '@/lib/api/self-hosted/studioGoTrue'

export default (req: NextApiRequest, res: NextApiResponse) => apiWrapper(req, res, handler)

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { method } = req

  switch (method) {
    case 'GET':
      return handleGetAll(req, res)
    default:
      res.setHeader('Allow', ['GET'])
      res.status(405).json({ data: null, error: { message: `Method ${method} Not Allowed` } })
  }
}

const handleGetAll = async (req: NextApiRequest, res: NextApiResponse) => {
  const { slug, search, limit = '96', offset = '0', include_standby } = req.query
  const showStandby = include_standby === 'true'

  // Build a ref→name map across ALL projects so standbys can resolve their primary's name
  const allProjects = getStoredProjects()
  const nameByRef = Object.fromEntries(allProjects.map((p) => [p.ref, p.name]))

  let projects = allProjects
    .filter((p) => !slug || p.organization_slug === slug)
    .filter((p) => showStandby || (p.role !== 'standby' && p.role !== 'replica'))

  // In GoTrue mode, project-scoped members only see their allowed projects
  if (STUDIO_AUTH_GOTRUE) {
    const authMember = await getGoTrueAuthMember(req)
    if (authMember?.project_refs && authMember.project_refs.length > 0) {
      projects = projects.filter((p) => authMember.project_refs!.includes(p.ref))
    }
  }

  if (search && typeof search === 'string' && search.length > 0) {
    const q = search.toLowerCase()
    projects = projects.filter((p) => p.name.toLowerCase().includes(q))
  }

  const total = projects.length
  const pageLimit = Number(limit)
  const pageOffset = Number(offset)
  const paged = projects.slice(pageOffset, pageOffset + pageLimit)

  return res.status(200).json({
    pagination: {
      count: total,
      limit: pageLimit,
      offset: pageOffset,
    },
    projects: paged.map((p) => ({
      ref: p.ref,
      name: p.name,
      cloud_provider: p.cloud_provider,
      region: p.region,
      status: p.status,
      inserted_at: p.inserted_at,
      public_url: p.public_url,
      kong_http_port: p.kong_http_port,
      is_branch: false,
      // Self-hosted extension fields — undefined on cloud, stripped by JSON.stringify
      creation_mode: p.creation_mode,
      role: p.role,
      primary_ref: p.primary_ref,
      primary_name: p.primary_ref ? nameByRef[p.primary_ref] : undefined,
      standby_ref: p.standby_ref,
      cluster_id: p.cluster_id,
      replica_rank: p.replica_rank,
      databases: [
        {
          identifier: p.ref,
          cloud_provider: p.cloud_provider,
          region: p.region,
          status: p.status,
          type: 'PRIMARY',
        },
      ],
    })),
  })
}
