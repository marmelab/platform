import type { components } from 'api-types'
import { type NextApiRequest, type NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import { getFunctionsArtifactStore } from '@/lib/api/self-hosted/functions'
import { uuidv4 } from '@/lib/helpers'

export default function handlerWithErrorCatching(req: NextApiRequest, res: NextApiResponse) {
  return apiWrapper(req, res, handler, { withAuth: true })
}

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

type EdgeFunctionsResponse = components['schemas']['FunctionResponse']

let _warnedNoFunctionsStore = false
const handleGetAll = async (_req: NextApiRequest, res: NextApiResponse) => {
  const store = getFunctionsArtifactStore()

  if (!store) {
    if (!_warnedNoFunctionsStore) {
      _warnedNoFunctionsStore = true
      console.warn(
        '[edge-functions] EDGE_FUNCTIONS_MANAGEMENT_FOLDER is not set — edge function management is disabled. ' +
          'Set this env var to a directory path containing function bundles to enable it.'
      )
    }
    return res.status(200).json([])
  }

  const functionsArtifacts = await store.getFunctions()
  if (functionsArtifacts.length === 0) return res.status(200).json([])

  const functions = functionsArtifacts.map(
    (func) =>
      ({
        id: uuidv4(),
        slug: func.slug,
        version: 1,
        name: func.slug,
        status: 'ACTIVE',
        entrypoint_path: func.entrypoint_path,
        created_at: func.created_at,
        updated_at: func.updated_at,
      }) satisfies EdgeFunctionsResponse
  )

  return res.status(200).json(functions)
}
