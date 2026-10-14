import { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import { authAdminProxy } from '@/platform/authAdmin'

export default (req: NextApiRequest, res: NextApiResponse) => apiWrapper(req, res, authAdminProxy)
