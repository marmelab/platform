'use client'

import { useRef, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { AlertTriangle, ArrowLeftRight, CheckCircle2, Loader2, Terminal } from 'lucide-react'
import {
  Alert_Shadcn_,
  AlertDescription_Shadcn_,
  AlertTitle_Shadcn_,
  Badge,
  Button,
  Input_Shadcn_,
  Label_Shadcn_,
} from 'ui'

type Direction = 'pb-to-supa' | 'supa-to-pb'
type JobStatus = 'pending' | 'running' | 'done' | 'error'

interface MigJob {
  id: string
  direction: Direction
  status: JobStatus
  logs: string[]
  startedAt: string
  finishedAt?: string
}

function statusVariant(s: JobStatus): 'default' | 'success' | 'destructive' {
  if (s === 'done') return 'success'
  if (s === 'error') return 'destructive'
  return 'default'
}

function statusLabel(s: JobStatus): string {
  if (s === 'done') return 'complete'
  if (s === 'error') return 'failed'
  if (s === 'running') return 'running'
  return s
}

export function PocketBaseMigratePanel({ supaRef }: { supaRef: string }) {
  const [direction, setDirection] = useState<Direction>('pb-to-supa')
  const [pbUrl, setPbUrl] = useState('')
  const [pbEmail, setPbEmail] = useState('')
  const [pbPassword, setPbPassword] = useState('')
  const [jobId, setJobId] = useState<string | null>(null)
  const [step, setStep] = useState<'configure' | 'progress'>('configure')
  const logsRef = useRef<HTMLPreElement>(null)

  const { data: job } = useQuery<MigJob>({
    queryKey: ['pb-migrate-job', supaRef, jobId],
    queryFn: async () => {
      const res = await fetch(`/api/platform/projects/${supaRef}/pocketbase-migrate?job=${jobId}`)
      if (!res.ok) throw new Error('Failed to poll job')
      return res.json()
    },
    enabled: !!jobId && step === 'progress',
    refetchInterval: (q) => {
      const s = q.state.data?.status
      return s === 'pending' || s === 'running' ? 2000 : false
    },
  })

  // Auto-scroll logs
  if (logsRef.current) {
    logsRef.current.scrollTop = logsRef.current.scrollHeight
  }

  const { mutate: start, isPending: isStarting, error: startError } = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/platform/projects/${supaRef}/pocketbase-migrate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          direction,
          pb_url: pbUrl.trim(),
          pb_admin_email: pbEmail.trim(),
          pb_admin_password: pbPassword,
        }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`)
      return body as { job_id: string }
    },
    onSuccess: (data) => {
      setJobId(data.job_id)
      setStep('progress')
    },
  })

  const reset = () => {
    setStep('configure')
    setJobId(null)
  }

  const canStart = pbUrl.trim().length > 0 && pbEmail.trim().length > 0 && pbPassword.length > 0

  if (step === 'configure') {
    return (
      <div className="flex flex-col gap-6 max-w-2xl">
        <Alert_Shadcn_>
          <ArrowLeftRight className="h-4 w-4" />
          <AlertTitle_Shadcn_>PocketBase ↔ Supabase Migration</AlertTitle_Shadcn_>
          <AlertDescription_Shadcn_ className="flex flex-col gap-1">
            <p>
              Migrate collections and records between a PocketBase instance and this Supabase project.
              Choose the direction, enter the PocketBase URL and admin credentials, then start.
            </p>
            <p className="text-foreground-muted">
              <strong>PocketBase → Supabase</strong>: creates tables in Postgres and bulk-inserts records.
              <br />
              <strong>Supabase → PocketBase</strong>: creates PocketBase collections from Postgres tables and writes records.
            </p>
          </AlertDescription_Shadcn_>
        </Alert_Shadcn_>

        {/* Direction toggle */}
        <div className="flex flex-col gap-1.5">
          <Label_Shadcn_>Migration direction</Label_Shadcn_>
          <div className="flex gap-2">
            {(['pb-to-supa', 'supa-to-pb'] as Direction[]).map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => setDirection(d)}
                className={[
                  'flex-1 rounded-md border px-3 py-2.5 text-sm text-left transition-colors',
                  direction === d
                    ? 'border-brand bg-brand-200 text-foreground'
                    : 'border-border-strong bg-surface-100 text-foreground-light hover:border-foreground-muted',
                ].join(' ')}
              >
                <span className="font-medium block">
                  {d === 'pb-to-supa' ? 'PocketBase → Supabase' : 'Supabase → PocketBase'}
                </span>
                <span className="block text-xs text-foreground-light mt-0.5">
                  {d === 'pb-to-supa'
                    ? 'Import PocketBase collections into this Supabase project'
                    : 'Export Supabase tables into PocketBase collections'}
                </span>
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label_Shadcn_ htmlFor="pb-url">PocketBase URL</Label_Shadcn_>
          <Input_Shadcn_
            id="pb-url"
            placeholder="http://localhost:8090"
            value={pbUrl}
            onChange={(e) => setPbUrl(e.target.value)}
            className="font-mono text-xs"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label_Shadcn_ htmlFor="pb-email">Admin email</Label_Shadcn_>
          <Input_Shadcn_
            id="pb-email"
            type="email"
            placeholder="admin@example.com"
            value={pbEmail}
            onChange={(e) => setPbEmail(e.target.value)}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label_Shadcn_ htmlFor="pb-password">Admin password</Label_Shadcn_>
          <Input_Shadcn_
            id="pb-password"
            type="password"
            placeholder="••••••••"
            value={pbPassword}
            onChange={(e) => setPbPassword(e.target.value)}
          />
        </div>

        {startError && (
          <Alert_Shadcn_ className="border-destructive">
            <AlertTriangle className="h-4 w-4 text-destructive" />
            <AlertTitle_Shadcn_>Failed to start</AlertTitle_Shadcn_>
            <AlertDescription_Shadcn_>
              {startError instanceof Error ? startError.message : String(startError)}
            </AlertDescription_Shadcn_>
          </Alert_Shadcn_>
        )}

        <div className="flex justify-end">
          <Button
            type="primary"
            disabled={!canStart}
            loading={isStarting}
            onClick={() => start()}
          >
            {direction === 'pb-to-supa' ? 'Import from PocketBase' : 'Export to PocketBase'}
          </Button>
        </div>
      </div>
    )
  }

  // Progress view
  const isRunning = !job || job.status === 'pending' || job.status === 'running'

  return (
    <div className="flex flex-col gap-4 max-w-2xl">
      <div className="flex items-center gap-3">
        {isRunning ? (
          <Loader2 size={16} className="animate-spin text-foreground-muted shrink-0" />
        ) : job?.status === 'done' ? (
          <CheckCircle2 size={16} className="text-brand shrink-0" />
        ) : (
          <AlertTriangle size={16} className="text-destructive shrink-0" />
        )}
        <span className="font-medium">
          {!job
            ? 'Starting…'
            : job.status === 'done'
              ? 'Migration complete'
              : job.status === 'error'
                ? 'Migration failed'
                : direction === 'pb-to-supa'
                  ? 'Importing from PocketBase…'
                  : 'Exporting to PocketBase…'}
        </span>
        {job && (
          <Badge variant={statusVariant(job.status)} className="ml-auto">
            {statusLabel(job.status)}
          </Badge>
        )}
      </div>

      <div className="rounded-md border border-strong bg-surface-100 overflow-hidden">
        <div className="flex items-center gap-2 px-3 py-2 border-b border-strong bg-surface-200">
          <Terminal size={12} className="text-foreground-muted" />
          <span className="text-foreground-muted text-xs">Migration log</span>
        </div>
        <pre
          ref={logsRef}
          className="text-xs font-mono p-3 overflow-auto max-h-80 text-foreground-light whitespace-pre-wrap break-words"
        >
          {job?.logs.join('\n') || 'Waiting for output…'}
        </pre>
      </div>

      {job?.status === 'done' && (
        <Alert_Shadcn_>
          <CheckCircle2 className="h-4 w-4" />
          <AlertTitle_Shadcn_>Migration complete</AlertTitle_Shadcn_>
          <AlertDescription_Shadcn_>
            {direction === 'pb-to-supa'
              ? 'PocketBase collections have been imported into this Supabase project.'
              : 'Supabase tables have been exported to PocketBase.'}
          </AlertDescription_Shadcn_>
        </Alert_Shadcn_>
      )}

      {job?.status === 'error' && (
        <Alert_Shadcn_ className="border-destructive">
          <AlertTriangle className="h-4 w-4 text-destructive" />
          <AlertTitle_Shadcn_>Migration failed</AlertTitle_Shadcn_>
          <AlertDescription_Shadcn_>
            Check the log above for details. Common causes: unreachable PocketBase URL, wrong
            admin credentials, or the Supabase project is not running.
          </AlertDescription_Shadcn_>
        </Alert_Shadcn_>
      )}

      <div className="flex justify-end">
        <Button type="default" disabled={isRunning} onClick={reset}>
          {isRunning ? 'Please wait…' : 'Run another migration'}
        </Button>
      </div>
    </div>
  )
}
