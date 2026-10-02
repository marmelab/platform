import { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import {
  deleteStoredOrganization,
  getStoredOrganizationBySlug,
  updateStoredOrganization,
} from '@/lib/api/self-hosted/organizationsStore'
import { getStoredProjects } from '@/lib/api/self-hosted/projectsStore'

export default (req: NextApiRequest, res: NextApiResponse) => apiWrapper(req, res, handler)

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { method } = req

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
  const slug = req.query.slug as string
  const org = getStoredOrganizationBySlug(slug)

  if (!org) {
    return res.status(404).json({ data: null, error: { message: 'Organization not found' } })
  }

  return res.status(200).json(org)
}

const handlePatch = async (req: NextApiRequest, res: NextApiResponse) => {
  const slug = req.query.slug as string
  const { name, billing_email } = req.body

  if (name !== undefined && !String(name).trim()) {
    return res
      .status(400)
      .json({ data: null, error: { message: 'Organization name cannot be empty.' } })
  }

  const updated = updateStoredOrganization(slug, {
    ...(name !== undefined && { name: String(name).trim() }),
    ...(billing_email !== undefined && { billing_email: billing_email || null }),
  })

  if (!updated) {
    return res.status(404).json({ data: null, error: { message: 'Organization not found' } })
  }

  return res.status(200).json(updated)
}

const handleDelete = async (req: NextApiRequest, res: NextApiResponse) => {
  const slug = req.query.slug as string

  if (slug === 'default-org-slug') {
    return res
      .status(400)
      .json({ data: null, error: { message: 'The default organization cannot be deleted.' } })
  }

  const org = getStoredOrganizationBySlug(slug)
  if (!org) {
    return res.status(404).json({ data: null, error: { message: 'Organization not found' } })
  }

  // Refuse if the org still has any projects (including replicas/standbys that belong to it)
  const projects = getStoredProjects().filter(
    (p) => p.organization_slug === slug && p.ref !== 'default'
  )
  if (projects.length > 0) {
    return res.status(400).json({
      data: null,
      error: { message: 'Cannot delete an organization that still has projects.' },
    })
  }

  deleteStoredOrganization(slug)
  return res.status(200).json({ slug, name: org.name })
}
