import { useState } from 'react'
import { toast } from 'sonner'
import {
  Button,
  Select_Shadcn_,
  SelectContent_Shadcn_,
  SelectItem_Shadcn_,
  SelectTrigger_Shadcn_,
  SelectValue_Shadcn_,
} from 'ui'
import ConfirmationModal from 'ui-patterns/Dialogs/ConfirmationModal'
import {
  PageSection,
  PageSectionContent,
  PageSectionDescription,
  PageSectionMeta,
  PageSectionSummary,
  PageSectionTitle,
} from 'ui-patterns/PageSection'

import { useSelectedProjectQuery } from '@/hooks/misc/useSelectedProject'

interface BackupItem {
  id: string
  filename: string
  sizeBytes: number
  createdAt: string
}

type Schedule = 'daily' | 'weekly' | 'off'

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString()
}

export const BackupPanel = () => {
  const { data: project } = useSelectedProjectQuery()
  const ref = project?.ref

  const [backups, setBackups] = useState<BackupItem[]>([])
  const [schedule, setSchedule] = useState<Schedule>('off')
  const [lastRunAt, setLastRunAt] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [running, setRunning] = useState(false)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [restoring, setRestoring] = useState<string | null>(null)
  const [confirmRestore, setConfirmRestore] = useState<BackupItem | null>(null)

  const load = async () => {
    if (!ref) return
    try {
      const res = await fetch(`/api/self-hosted/backups?ref=${ref}`)
      if (!res.ok) throw new Error(await res.text())
      const data = await res.json()
      setBackups(data.backups)
      setSchedule(data.schedule)
      setLastRunAt(data.lastRunAt)
      setLoaded(true)
    } catch (err: any) {
      toast.error(err.message ?? 'Failed to load backups')
    }
  }

  if (!loaded && ref) {
    load()
  }

  const handleRunNow = async () => {
    if (!ref) return
    setRunning(true)
    try {
      const res = await fetch('/api/self-hosted/backups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ref, action: 'run' }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Backup failed')
      toast.success('Backup completed')
      await load()
    } catch (err: any) {
      toast.error(err.message ?? 'Backup failed')
    } finally {
      setRunning(false)
    }
  }

  const handleScheduleChange = async (value: Schedule) => {
    if (!ref) return
    setSchedule(value)
    setSaving(true)
    try {
      const res = await fetch('/api/self-hosted/backups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ref, action: 'schedule', schedule: value }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Failed to save schedule')
      toast.success('Backup schedule updated')
    } catch (err: any) {
      toast.error(err.message ?? 'Failed to save schedule')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (filename: string) => {
    if (!ref) return
    setDeleting(filename)
    try {
      const res = await fetch(
        `/api/self-hosted/backups?ref=${encodeURIComponent(ref)}&filename=${encodeURIComponent(filename)}`,
        { method: 'DELETE' }
      )
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error ?? 'Delete failed')
      }
      setBackups((prev) => prev.filter((b) => b.filename !== filename))
      toast.success('Backup deleted')
    } catch (err: any) {
      toast.error(err.message ?? 'Delete failed')
    } finally {
      setDeleting(null)
    }
  }

  const handleRestoreConfirm = async () => {
    if (!ref || !confirmRestore) return
    const { filename } = confirmRestore
    setRestoring(filename)
    setConfirmRestore(null)
    try {
      const res = await fetch('/api/self-hosted/backups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ref, action: 'restore', filename }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Restore failed')
      toast.success('Database restored successfully')
    } catch (err: any) {
      toast.error(err.message ?? 'Restore failed')
    } finally {
      setRestoring(null)
    }
  }

  const downloadUrl = (filename: string) =>
    `/api/self-hosted/backups/${encodeURIComponent(filename)}?ref=${encodeURIComponent(ref ?? '')}`

  return (
    <>
      <PageSection>
        <PageSectionMeta>
          <PageSectionSummary>
            <PageSectionTitle>Automatic backups</PageSectionTitle>
            <PageSectionDescription>
              Schedule pg_dump backups stored on the server
            </PageSectionDescription>
          </PageSectionSummary>
        </PageSectionMeta>

        <PageSectionContent className="flex flex-col gap-4">
          <div className="flex items-center gap-3">
            <Select_Shadcn_
              value={schedule}
              onValueChange={(v) => handleScheduleChange(v as Schedule)}
              disabled={saving}
            >
              <SelectTrigger_Shadcn_ className="w-40">
                <SelectValue_Shadcn_ />
              </SelectTrigger_Shadcn_>
              <SelectContent_Shadcn_>
                <SelectItem_Shadcn_ value="off">Off</SelectItem_Shadcn_>
                <SelectItem_Shadcn_ value="daily">Daily</SelectItem_Shadcn_>
                <SelectItem_Shadcn_ value="weekly">Weekly</SelectItem_Shadcn_>
              </SelectContent_Shadcn_>
            </Select_Shadcn_>
            <Button onClick={handleRunNow} loading={running} type="default">
              Run backup now
            </Button>
          </div>
          {lastRunAt && (
            <p className="text-sm text-foreground-light">Last backup: {formatDate(lastRunAt)}</p>
          )}
        </PageSectionContent>
      </PageSection>

      <PageSection>
        <PageSectionMeta>
          <PageSectionSummary>
            <PageSectionTitle>Backup history</PageSectionTitle>
            <PageSectionDescription>
              Download, restore, or delete existing backups
            </PageSectionDescription>
          </PageSectionSummary>
        </PageSectionMeta>

        <PageSectionContent>
          {backups.length === 0 ? (
            <p className="text-sm text-foreground-light">No backups yet.</p>
          ) : (
            <div className="flex flex-col divide-y divide-border border rounded-md">
              {backups.map((b) => (
                <div
                  key={b.filename}
                  className="flex items-center justify-between px-4 py-3 text-sm"
                >
                  <div className="flex flex-col gap-0.5">
                    <span className="font-mono text-xs text-foreground">{b.filename}</span>
                    <span className="text-foreground-light">
                      {formatDate(b.createdAt)} · {formatBytes(b.sizeBytes)}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button type="default" asChild>
                      <a href={downloadUrl(b.filename)} download={b.filename}>
                        Download
                      </a>
                    </Button>
                    <Button
                      type="warning"
                      loading={restoring === b.filename}
                      onClick={() => setConfirmRestore(b)}
                    >
                      Restore
                    </Button>
                    <Button
                      type="danger"
                      loading={deleting === b.filename}
                      onClick={() => handleDelete(b.filename)}
                    >
                      Delete
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </PageSectionContent>
      </PageSection>

      <ConfirmationModal
        visible={confirmRestore !== null}
        variant="destructive"
        title="Restore database from backup"
        alert={{
          title: 'This will overwrite your current database',
          description:
            'All existing data will be replaced with the contents of this backup. This action cannot be undone.',
        }}
        onCancel={() => setConfirmRestore(null)}
        onConfirm={handleRestoreConfirm}
      >
        {confirmRestore && (
          <p className="text-sm text-foreground-light">
            Restoring from <span className="font-mono text-foreground">{confirmRestore.filename}</span>
            {' '}({formatBytes(confirmRestore.sizeBytes)}, {formatDate(confirmRestore.createdAt)})
          </p>
        )}
      </ConfirmationModal>
    </>
  )
}
