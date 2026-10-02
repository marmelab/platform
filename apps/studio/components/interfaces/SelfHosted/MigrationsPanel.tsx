import { useQueries } from '@tanstack/react-query'
import { AlertTriangle, CheckCircle2, GitCompare, Loader2, RefreshCw } from 'lucide-react'
import {
  Alert_Shadcn_,
  AlertDescription_Shadcn_,
  AlertTitle_Shadcn_,
  Button,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  cn,
} from 'ui'

type Project = {
  ref: string
  name: string
}

type MigrationRow = {
  version: string
  name?: string
}

type ProjectMigrationsResult =
  | { ref: string; migrations: MigrationRow[]; error?: undefined }
  | { ref: string; error: string; migrations?: undefined }

async function fetchProjectMigrations(ref: string): Promise<ProjectMigrationsResult> {
  const res = await fetch(`/api/platform/projects/${ref}/migrations`)
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    return { ref, error: body?.error?.message ?? `HTTP ${res.status}` }
  }
  return res.json()
}

function StatusCell({ has, error }: { has: boolean; error?: string }) {
  if (error) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="flex justify-center">
              <AlertTriangle size={14} className="text-warning" />
            </span>
          </TooltipTrigger>
          <TooltipContent>{error}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    )
  }
  return has ? (
    <CheckCircle2 size={14} className="text-brand mx-auto" />
  ) : (
    <span className="block text-center text-foreground-muted">✗</span>
  )
}

export function MigrationsPanel({ projects }: { projects: Project[] }) {
  const results = useQueries({
    queries: projects.map((p) => ({
      queryKey: ['self-hosted', 'migrations', p.ref],
      queryFn: () => fetchProjectMigrations(p.ref),
      retry: false,
      staleTime: 30_000,
    })),
  })

  const isLoading = results.some((r) => r.isPending)
  const isRefreshing = results.some((r) => r.isFetching && !r.isPending)

  // Collect all migration versions across all projects (sorted)
  const allVersions = [
    ...new Set(
      results.flatMap((r) =>
        r.data && !r.data.error ? (r.data.migrations ?? []).map((m) => m.version) : []
      )
    ),
  ].sort()

  // Build a lookup: version → set of refs that have it
  const appliedByVersion = new Map<string, Set<string>>()
  const nameByVersion = new Map<string, string>()
  for (const r of results) {
    if (!r.data || r.data.error) continue
    for (const m of r.data.migrations ?? []) {
      if (!appliedByVersion.has(m.version)) appliedByVersion.set(m.version, new Set())
      appliedByVersion.get(m.version)!.add(r.data.ref)
      if (m.name && !nameByVersion.has(m.version)) nameByVersion.set(m.version, m.name)
    }
  }

  const reachableProjects = projects.filter((p) => {
    const r = results.find((res) => res.data?.ref === p.ref)
    return !r?.data?.error
  })

  const divergedVersions = allVersions.filter((v) => {
    const applied = appliedByVersion.get(v)
    return reachableProjects.some((p) => !applied?.has(p.ref))
  })

  const refetch = () => results.forEach((r) => r.refetch())

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-2">
        <Alert_Shadcn_ className={cn(divergedVersions.length > 0 && 'border-warning')}>
          <GitCompare className="h-4 w-4" />
          <AlertTitle_Shadcn_>Migration state across all projects</AlertTitle_Shadcn_>
          <AlertDescription_Shadcn_>
            {isLoading ? (
              'Fetching migration state…'
            ) : divergedVersions.length > 0 ? (
              <>
                <span className="text-warning font-medium">{divergedVersions.length}</span>{' '}
                migration{divergedVersions.length !== 1 ? 's' : ''} not applied on all projects.
                Run <code className="text-xs bg-surface-300 px-1 rounded">supabase db push</code>{' '}
                against the lagging projects to bring them in sync.
              </>
            ) : allVersions.length === 0 ? (
              'No migrations found in any project.'
            ) : (
              <>
                All {reachableProjects.length} reachable project{reachableProjects.length !== 1 ? 's' : ''} are in sync
                ({allVersions.length} migration{allVersions.length !== 1 ? 's' : ''}).
              </>
            )}
          </AlertDescription_Shadcn_>
        </Alert_Shadcn_>

        <Button
          type="default"
          icon={<RefreshCw size={14} className={isRefreshing ? 'animate-spin' : ''} />}
          onClick={refetch}
          disabled={isLoading || isRefreshing}
          className="shrink-0 mt-0.5"
        >
          Refresh
        </Button>
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 text-foreground-muted py-8 justify-center">
          <Loader2 size={16} className="animate-spin" />
          <span>Checking migration state…</span>
        </div>
      ) : (
        <div className="rounded-md border border-strong overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="min-w-[160px]">Version</TableHead>
                <TableHead className="min-w-[220px] text-foreground-muted">Name</TableHead>
                {projects.map((p) => (
                  <TableHead
                    key={p.ref}
                    className="text-center min-w-[120px] max-w-[160px]"
                    title={p.name}
                  >
                    <span className="block truncate">{p.name}</span>
                    <span className="block text-foreground-muted font-normal text-[10px] font-mono">
                      {p.ref}
                    </span>
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {allVersions.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={2 + projects.length}
                    className="text-center text-foreground-muted py-8"
                  >
                    No migrations applied on any project yet.
                  </TableCell>
                </TableRow>
              )}
              {allVersions.map((version) => {
                const appliedSet = appliedByVersion.get(version) ?? new Set()
                const isDiverged = reachableProjects.some((p) => !appliedSet.has(p.ref))
                return (
                  <TableRow key={version} className={isDiverged ? 'bg-warning/5' : undefined}>
                    <TableCell className="font-mono text-xs">{version}</TableCell>
                    <TableCell className="text-foreground-muted text-xs">
                      {nameByVersion.get(version) ?? '—'}
                    </TableCell>
                    {projects.map((p) => {
                      const result = results.find((r) => r.data?.ref === p.ref)
                      const err = result?.data?.error
                      return (
                        <TableCell key={p.ref} className="text-center">
                          <StatusCell has={appliedSet.has(p.ref)} error={err} />
                        </TableCell>
                      )
                    })}
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      )}

      <p className="text-foreground-muted text-xs">
        Data is read from{' '}
        <code className="text-xs bg-surface-300 px-1 py-0.5 rounded">
          supabase_migrations.schema_migrations
        </code>{' '}
        on each project&apos;s database. Projects that are stopped or unreachable show a warning icon.
      </p>
    </div>
  )
}
