'use client'

import { useEffect, useRef, useState } from 'react'

import { useMutation, useQuery } from '@tanstack/react-query'
import { AlertTriangle, CheckCircle2, CloudDownload, Loader2, RefreshCw, Terminal } from 'lucide-react'
import {
  Alert_Shadcn_,
  AlertDescription_Shadcn_,
  AlertTitle_Shadcn_,
  Badge,
  Button,
  Checkbox_Shadcn_,
  Input_Shadcn_,
  Label_Shadcn_,
  Select_Shadcn_,
  SelectContent_Shadcn_,
  SelectItem_Shadcn_,
  SelectTrigger_Shadcn_,
  SelectValue_Shadcn_,
} from 'ui'

type Project = {
  ref: string
  name: string
  docker_project?: string
  creation_mode?: string
}

type JobStatus = 'pending' | 'running' | 'done' | 'done-with-warnings' | 'error' | 'interrupted'

interface MigrationJob {
  id: string
  status: JobStatus
  phase: 'dump' | 'restore' | null
  restoreErrors: number
  logs: string[]
  startedAt: string
  finishedAt?: string
}

interface InterruptedJobSummary {
  id: string
  startedAt: string
  finishedAt?: string
  schemas: string[]
  schemaOnly: boolean
  maskedSourceUrl: string
  dumpAvailable: boolean
}

type Step = 'configure' | 'confirm' | 'progress'

function jobStatusVariant(status: JobStatus): 'default' | 'warning' | 'success' | 'destructive' {
  switch (status) {
    case 'done': return 'success'
    case 'done-with-warnings': return 'warning'
    case 'error': return 'destructive'
    default: return 'warning'
  }
}

function jobStatusLabel(status: JobStatus): string {
  switch (status) {
    case 'done': return 'complete'
    case 'done-with-warnings': return 'done with warnings'
    case 'error': return 'failed'
    case 'interrupted': return 'interrupted'
    case 'running': return 'running'
    default: return status
  }
}

export function MigrateFromCloudPanel({ projects }: { projects: Project[] }) {
  const [step, setStep] = useState<Step>('configure')
  const [sourceUrl, setSourceUrl] = useState('')
  const [targetRef, setTargetRef] = useState('')
  const [schemas, setSchemas] = useState('public')
  const [schemaOnly, setSchemaOnly] = useState(false)
  const [jobId, setJobId] = useState<string | null>(null)
  const logsRef = useRef<HTMLPreElement>(null)

  useEffect(() => {
    if (logsRef.current) {
      logsRef.current.scrollTop = logsRef.current.scrollHeight
    }
  })

  const eligibleProjects = projects.filter(
    (p) => p.docker_project && p.creation_mode !== 'embedded'
  )
  const targetProject = eligibleProjects.find((p) => p.ref === targetRef)

  // Fetch interrupted jobs whenever the target project changes
  const { data: interruptedData, refetch: refetchInterrupted } = useQuery<{
    interrupted: InterruptedJobSummary[]
  }>({
    queryKey: ['migrate-interrupted', targetRef],
    queryFn: async () => {
      const res = await fetch(`/api/platform/projects/${targetRef}/migrate?interrupted=true`)
      if (!res.ok) throw new Error('Failed to fetch interrupted jobs')
      return res.json()
    },
    enabled: !!targetRef && step === 'configure',
    staleTime: 30_000,
  })

  const interruptedJobs = interruptedData?.interrupted ?? []
  const resumableJob = interruptedJobs.find((j) => j.dumpAvailable)

  const {
    mutate: startJob,
    isPending: isStarting,
    error: startError,
    reset: resetMutation,
  } = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/platform/projects/${targetRef}/migrate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source_db_url: sourceUrl,
          schemas: schemas.split(',').map((s) => s.trim()).filter(Boolean),
          schema_only: schemaOnly,
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

  const {
    mutate: resumeJob,
    isPending: isResuming,
    error: resumeError,
    reset: resetResumeMutation,
  } = useMutation({
    mutationFn: async (resumeJobId: string) => {
      const res = await fetch(`/api/platform/projects/${targetRef}/migrate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'resume', job_id: resumeJobId }),
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

  const { data: job } = useQuery<MigrationJob>({
    queryKey: ['migrate-job', targetRef, jobId],
    queryFn: async () => {
      const res = await fetch(`/api/platform/projects/${targetRef}/migrate?job=${jobId}`)
      if (!res.ok) throw new Error('Failed to fetch job status')
      return res.json()
    },
    enabled: !!jobId && step === 'progress',
    refetchInterval: (q) => {
      const s = q.state.data?.status
      return s === 'pending' || s === 'running' ? 2000 : false
    },
  })

  const reset = () => {
    setStep('configure')
    setJobId(null)
    resetMutation()
    resetResumeMutation()
    void refetchInterrupted()
  }

  const maskedSourceUrl = (() => {
    try {
      const parsed = new URL(sourceUrl)
      parsed.password = '****'
      return parsed.toString()
    } catch {
      return sourceUrl.replace(/:[^:@]+@/, ':****@')
    }
  })()

  // ── Configure ──────────────────────────────────────────────────────────────

  if (step === 'configure') {
    const canProceed = sourceUrl.trim().length > 0 && targetRef.length > 0

    return (
      <div className="flex flex-col gap-6 max-w-2xl">
        <Alert_Shadcn_>
          <CloudDownload className="h-4 w-4" />
          <AlertTitle_Shadcn_>Migrate from Supabase Cloud</AlertTitle_Shadcn_>
          <AlertDescription_Shadcn_ className="flex flex-col gap-1">
            <p>
              Runs in two phases: <strong>dump</strong> (cloud → compressed temp file inside the
              target container) then <strong>restore</strong> (temp file → target database).
              Verbose per-table progress is shown in the log. The temp file is automatically
              deleted after a successful migration.
            </p>
            <p className="text-foreground-muted">
              Disk used during migration: ~30–50% of the source database size (zlib-compressed).
              On failure the dump file is kept in the container's{' '}
              <code className="text-xs bg-surface-300 px-1 rounded">/tmp</code> for resume.
            </p>
          </AlertDescription_Shadcn_>
        </Alert_Shadcn_>

        {/* Interrupted job banner */}
        {resumableJob && (
          <Alert_Shadcn_ className="border-warning">
            <RefreshCw className="h-4 w-4 text-warning" />
            <AlertTitle_Shadcn_>Interrupted migration found</AlertTitle_Shadcn_>
            <AlertDescription_Shadcn_ className="flex flex-col gap-3">
              <p>
                A previous migration was interrupted while the dump file is still available inside
                the container. You can resume directly from the restore phase — no re-dump needed.
              </p>
              <div className="text-xs font-mono text-foreground-muted flex flex-col gap-0.5">
                <span>Started: {new Date(resumableJob.startedAt).toLocaleString()}</span>
                <span>Schemas: {resumableJob.schemas.join(', ')}{resumableJob.schemaOnly ? ' (schema only)' : ''}</span>
                <span>Source: {resumableJob.maskedSourceUrl}</span>
              </div>
              {resumeError && (
                <p className="text-xs text-destructive">
                  {resumeError instanceof Error ? resumeError.message : String(resumeError)}
                </p>
              )}
              <div className="flex gap-2">
                <Button
                  type="warning"
                  loading={isResuming}
                  onClick={() => resumeJob(resumableJob.id)}
                >
                  Resume restore
                </Button>
                <Button
                  type="default"
                  disabled={isResuming}
                  onClick={() => {
                    // Dismiss banner and let user start fresh
                    void refetchInterrupted()
                  }}
                >
                  Dismiss
                </Button>
              </div>
            </AlertDescription_Shadcn_>
          </Alert_Shadcn_>
        )}

        <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-1.5">
            <Label_Shadcn_ htmlFor="source-url">Source database URL</Label_Shadcn_>
            <Input_Shadcn_
              id="source-url"
              placeholder="postgresql://postgres:[password]@db.[ref].supabase.co:5432/postgres"
              value={sourceUrl}
              onChange={(e) => setSourceUrl(e.target.value)}
              className="font-mono text-xs"
            />
            <p className="text-foreground-muted text-xs">
              Use the <strong>direct</strong> connection string — not the pooler URL.
              Find it under{' '}
              <span className="font-mono text-xs">Project Settings → Database → Connection string → URI</span>.
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label_Shadcn_ htmlFor="target-project">Target self-hosted project</Label_Shadcn_>
            <Select_Shadcn_ value={targetRef} onValueChange={setTargetRef}>
              <SelectTrigger_Shadcn_ id="target-project">
                <SelectValue_Shadcn_ placeholder="Select a project…" />
              </SelectTrigger_Shadcn_>
              <SelectContent_Shadcn_>
                {eligibleProjects.map((p) => (
                  <SelectItem_Shadcn_ key={p.ref} value={p.ref}>
                    {p.name} ({p.ref})
                  </SelectItem_Shadcn_>
                ))}
              </SelectContent_Shadcn_>
            </Select_Shadcn_>
            {eligibleProjects.length === 0 && (
              <p className="text-foreground-muted text-xs">
                No eligible projects found. Create a Docker-orchestrated project first.
              </p>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label_Shadcn_ htmlFor="schemas">Schemas to migrate</Label_Shadcn_>
            <Input_Shadcn_
              id="schemas"
              placeholder="public"
              value={schemas}
              onChange={(e) => setSchemas(e.target.value)}
              className="font-mono text-xs"
            />
            <p className="text-foreground-muted text-xs">
              Comma-separated schema names.{' '}
              <code className="text-xs bg-surface-300 px-1 rounded">public</code> covers
              all user tables. Adding{' '}
              <code className="text-xs bg-surface-300 px-1 rounded">auth</code> also migrates
              user accounts (advanced).
            </p>
          </div>

          <div className="flex items-center gap-2">
            <Checkbox_Shadcn_
              id="schema-only"
              checked={schemaOnly}
              onCheckedChange={(v) => setSchemaOnly(!!v)}
            />
            <Label_Shadcn_ htmlFor="schema-only" className="cursor-pointer font-normal">
              Schema only — skip row data
            </Label_Shadcn_>
          </div>
        </div>

        <div className="flex justify-end">
          <Button type="primary" disabled={!canProceed} onClick={() => setStep('confirm')}>
            Next
          </Button>
        </div>
      </div>
    )
  }

  // ── Confirm ────────────────────────────────────────────────────────────────

  if (step === 'confirm') {
    return (
      <div className="flex flex-col gap-6 max-w-2xl">
        <Alert_Shadcn_ className="border-warning">
          <AlertTriangle className="h-4 w-4 text-warning" />
          <AlertTitle_Shadcn_>Destructive operation</AlertTitle_Shadcn_>
          <AlertDescription_Shadcn_ className="flex flex-col gap-2">
            <p>
              All objects in schema(s){' '}
              <code className="text-xs bg-surface-300 px-1 rounded">{schemas}</code> on project{' '}
              <strong>{targetProject?.name ?? targetRef}</strong> will be dropped and
              replaced with data from the source database. This cannot be undone.
            </p>
            <p>Make sure the target project is not serving live traffic.</p>
          </AlertDescription_Shadcn_>
        </Alert_Shadcn_>

        <div className="rounded-md border border-strong p-4 flex flex-col gap-2 text-sm">
          <Row label="Source">{maskedSourceUrl}</Row>
          <Row label="Target">{targetProject?.name ?? targetRef}</Row>
          <Row label="Schemas">{schemas}</Row>
          <Row label="Mode">{schemaOnly ? 'Schema only' : 'Schema + data'}</Row>
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

        <div className="flex justify-between">
          <Button type="default" onClick={() => setStep('configure')}>
            Back
          </Button>
          <Button type="danger" loading={isStarting} onClick={() => startJob()}>
            Run migration
          </Button>
        </div>
      </div>
    )
  }

  // ── Progress ───────────────────────────────────────────────────────────────

  const isRunning = !job || job.status === 'pending' || job.status === 'running'

  return (
    <div className="flex flex-col gap-4 max-w-2xl">
      <div className="flex items-center gap-3">
        {!job || isRunning ? (
          <Loader2 size={16} className="animate-spin text-foreground-muted shrink-0" />
        ) : job.status === 'done' ? (
          <CheckCircle2 size={16} className="text-brand shrink-0" />
        ) : (
          <AlertTriangle size={16} className="text-destructive shrink-0" />
        )}
        <span className="font-medium">
          {!job
            ? 'Starting…'
            : job.status === 'done'
              ? 'Migration complete'
              : job.status === 'done-with-warnings'
                ? 'Migration complete with warnings'
                : job.status === 'error'
                  ? 'Migration failed'
                  : job.phase === 'dump'
                    ? 'Dumping source database…'
                    : job.phase === 'restore'
                      ? 'Restoring into target…'
                      : 'Migration in progress…'}
        </span>
        {job && (
          <Badge variant={jobStatusVariant(job.status)} className="ml-auto">
            {jobStatusLabel(job.status)}
          </Badge>
        )}
      </div>

      <div className="rounded-md border border-strong bg-surface-100 overflow-hidden">
        <div className="flex items-center gap-2 px-3 py-2 border-b border-strong bg-surface-200">
          <Terminal size={12} className="text-foreground-muted" />
          <span className="text-foreground-muted text-xs">Migration log</span>
          {job?.phase && (
            <Badge variant="default" className="ml-auto text-xs">
              {job.phase === 'dump' ? 'Phase 1/2: dump' : 'Phase 2/2: restore'}
            </Badge>
          )}
        </div>
        <pre
          ref={logsRef}
          className="text-xs font-mono p-3 overflow-auto max-h-72 text-foreground-light whitespace-pre-wrap break-words"
        >
          {job?.logs.join('\n') || 'Waiting for output…'}
        </pre>
      </div>

      {job?.status === 'done' && (
        <Alert_Shadcn_>
          <CheckCircle2 className="h-4 w-4" />
          <AlertTitle_Shadcn_>Migration complete</AlertTitle_Shadcn_>
          <AlertDescription_Shadcn_>
            Your database has been migrated to{' '}
            <strong>{targetProject?.name ?? targetRef}</strong>. Refresh the project in Studio to
            see the imported schema.
          </AlertDescription_Shadcn_>
        </Alert_Shadcn_>
      )}

      {job?.status === 'done-with-warnings' && (
        <Alert_Shadcn_ className="border-warning">
          <AlertTriangle className="h-4 w-4 text-warning" />
          <AlertTitle_Shadcn_>Migration complete with warnings</AlertTitle_Shadcn_>
          <AlertDescription_Shadcn_>
            <p>
              Restore finished with {job.restoreErrors} error{job.restoreErrors !== 1 ? 's' : ''}.
              These are usually harmless drop-errors on a pre-populated target (e.g. objects that
              didn't exist when <code className="text-xs bg-surface-300 px-1 rounded">--clean</code>{' '}
              ran). Search the log for <code className="text-xs bg-surface-300 px-1 rounded">pg_restore: error:</code>{' '}
              to review them.
            </p>
          </AlertDescription_Shadcn_>
        </Alert_Shadcn_>
      )}

      {job?.status === 'error' && (
        <Alert_Shadcn_ className="border-destructive">
          <AlertTriangle className="h-4 w-4 text-destructive" />
          <AlertTitle_Shadcn_>Migration failed</AlertTitle_Shadcn_>
          <AlertDescription_Shadcn_ className="flex flex-col gap-1">
            <p>
              Check the log above for details. Common causes: wrong source URL or credentials,
              network cannot reach the cloud database, or the target project is not running.
            </p>
            <p>
              If the dump phase completed, click <strong>Run another migration</strong> — the
              interrupted job banner will let you resume from the restore phase directly.
            </p>
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

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <span className="text-foreground-muted w-24 shrink-0">{label}</span>
      <span className="font-mono text-xs break-all">{children}</span>
    </div>
  )
}
