import { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import { realtimeTokenRoute } from '@/platform/realtimeTokenRoute'

export default (req: NextApiRequest, res: NextApiResponse) => apiWrapper(req, res, realtimeTokenRoute)
