import fs from 'node:fs'
import type { NextApiRequest, NextApiResponse } from 'next'

import { getBackupFilePath } from '@/lib/api/self-hosted/backupManager'

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET'])
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const ref = String(req.query.ref ?? '')
  const filename = String(req.query.filename ?? '')

  if (!ref || !filename) return res.status(400).json({ error: 'ref and filename required' })

  const filepath = getBackupFilePath(ref, filename)
  if (!filepath) return res.status(404).json({ error: 'Backup not found' })

  res.setHeader('Content-Type', 'application/octet-stream')
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)

  const stream = fs.createReadStream(filepath)
  stream.on('error', () => res.status(500).end())
  stream.pipe(res)
}
