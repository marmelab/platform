import type { NextApiRequest, NextApiResponse } from 'next'

import {
  listBackups,
  deleteBackup,
  getSchedule,
  getLastRunAt,
  setSchedule,
  runBackup,
  runRestore,
  type BackupSchedule,
} from '@/lib/api/self-hosted/backupManager'
import { initBackupScheduler } from '@/lib/api/self-hosted/backupScheduler'
import { getStoredProjectByRef } from '@/lib/api/self-hosted/projectsStore'

initBackupScheduler()

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') {
    const ref = String(req.query.ref ?? '')
    if (!ref) return res.status(400).json({ error: 'ref required' })
    return res.status(200).json({
      backups: listBackups(ref),
      schedule: getSchedule(ref),
      lastRunAt: getLastRunAt(ref) ?? null,
    })
  }

  if (req.method === 'POST') {
    const { ref, action, schedule } = req.body ?? {}
    if (!ref) return res.status(400).json({ error: 'ref required' })

    const project = getStoredProjectByRef(String(ref))
    if (!project) return res.status(404).json({ error: 'Project not found' })

    if (action === 'schedule') {
      const valid: BackupSchedule[] = ['daily', 'weekly', 'off']
      if (!valid.includes(schedule)) {
        return res.status(400).json({ error: 'schedule must be daily, weekly, or off' })
      }
      setSchedule(String(ref), schedule as BackupSchedule)
      return res.status(200).json({ ok: true, schedule })
    }

    if (action === 'run') {
      if (!project.docker_project) {
        return res.status(400).json({ error: 'Backup only supported for Docker-managed projects' })
      }
      try {
        const meta = await runBackup(String(ref), project.docker_project, project.docker_host)
        return res.status(200).json({ ok: true, backup: meta })
      } catch (err: any) {
        return res.status(500).json({ error: err.message ?? 'Backup failed' })
      }
    }

    if (action === 'restore') {
      const { filename } = req.body ?? {}
      if (!filename) return res.status(400).json({ error: 'filename required' })
      if (!project.docker_project) {
        return res.status(400).json({ error: 'Restore only supported for Docker-managed projects' })
      }
      try {
        await runRestore(String(ref), String(filename), project.docker_project, project.docker_host)
        return res.status(200).json({ ok: true })
      } catch (err: any) {
        return res.status(500).json({ error: err.message ?? 'Restore failed' })
      }
    }

    return res.status(400).json({ error: 'action must be run, restore, or schedule' })
  }

  if (req.method === 'DELETE') {
    const ref = String(req.query.ref ?? '')
    const filename = String(req.query.filename ?? '')
    if (!ref || !filename) return res.status(400).json({ error: 'ref and filename required' })
    deleteBackup(ref, filename)
    return res.status(200).json({ ok: true })
  }

  res.setHeader('Allow', ['GET', 'POST', 'DELETE'])
  return res.status(405).json({ error: 'Method not allowed' })
}
