import { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import { projectAdminClient } from '@/platform/projectApi'
import { FOLDER_PLACEHOLDER } from '@/platform/storageFolders'

// Platform route: the storage explorer's empty folders (placeholder object), created with the service key server side.
export default (req: NextApiRequest, res: NextApiResponse) => apiWrapper(req, res, handler)

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST'])
    return res.status(405).json({ data: null, error: { message: `Method ${req.method} Not Allowed` } })
  }
  const { folder } = req.body ?? {}
  if (typeof folder !== 'string' || !folder || folder.startsWith('/') || folder.endsWith('/')) {
    return res.status(400).json({ error: { message: 'folder must be a path without leading or trailing slash' } })
  }
  const { data, error } = await projectAdminClient(req)
    .storage.from(String(req.query.id))
    .upload(`${folder}/${FOLDER_PLACEHOLDER}`, new Blob([]))
  if (error) return res.status(400).json({ error: { message: error.message } })
  return res.status(200).json(data)
}
