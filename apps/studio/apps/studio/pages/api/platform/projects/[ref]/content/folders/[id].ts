import { paths } from 'api-types'
import { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import {
  getFolders,
  getSnippets,
  isSnippetStorageConfigured,
  renameFolder,
  warnSnippetsDirMissing,
} from '@/lib/api/snippets.utils'

const wrappedHandler = (req: NextApiRequest, res: NextApiResponse) => apiWrapper(req, res, handler)

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { method } = req

  switch (method) {
    case 'GET':
      return handleGetAll(req, res)
    case 'PATCH':
      return handlePatch(req, res)
    default:
      res.setHeader('Allow', ['GET', 'PATCH'])
      res.status(405).json({ data: null, error: { message: `Method ${method} Not Allowed` } })
  }
}

type GetRequestData =
  paths['/platform/projects/{ref}/content/folders/{id}']['get']['parameters']['query']
type GetResponseData =
  paths['/platform/projects/{ref}/content/folders/{id}']['get']['responses']['200']['content']['application/json']

const handleGetAll = async (req: NextApiRequest, res: NextApiResponse<GetResponseData>) => {
  const params = req.query as GetRequestData
  const folderId = (req.query.id as string) ?? null

  const folders = await getFolders(folderId)
  const { cursor, snippets } = await getSnippets({
    searchTerm: params?.name,
    cursor: params?.cursor,
    folderId: folderId,
    limit: params?.limit ? Number(params.limit) : undefined,
    sort: params?.sort_by,
    sortOrder: params?.sort_order,
  })

  return res.status(200).json({ data: { folders: folders, contents: snippets }, cursor })
}

type PatchResponseData =
  paths['/platform/projects/{ref}/content/folders/{id}']['patch']['responses']['200']['content']

const handlePatch = async (req: NextApiRequest, res: NextApiResponse<PatchResponseData>) => {
  if (!isSnippetStorageConfigured()) {
    warnSnippetsDirMissing()
    return res.status(503).json({ error: 'Snippet storage is not configured on this server.' } as never)
  }

  const id = req.query.id as string
  const { name } = req.body as { name: string; parentId?: string }

  if (!name || typeof name !== 'string') {
    return res.status(400).json({ error: 'Folder name is required' } as never)
  }

  try {
    const updated = await renameFolder(id, name)
    return res.status(200).json(updated as never)
  } catch (error: any) {
    if (error instanceof Error && error.message.includes('not found')) {
      return res.status(404).json({ error: error.message } as never)
    }
    return res.status(500).json({ error: error?.message ?? 'Failed to rename folder' } as never)
  }
}

export default wrappedHandler
