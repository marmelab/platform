import { zodResolver } from '@hookform/resolvers/zod'
import { ChevronDown, ChevronUp, Database, Layers, Package, Server, ShieldCheck } from 'lucide-react'
import { useRouter } from 'next/router'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { toast } from 'sonner'
import {
  Button,
  Form_Shadcn_,
  FormControl_Shadcn_,
  FormField_Shadcn_,
  Select_Shadcn_,
  SelectContent_Shadcn_,
  SelectItem_Shadcn_,
  SelectTrigger_Shadcn_,
  SelectValue_Shadcn_,
} from 'ui'
import { Input } from 'ui-patterns/DataInputs/Input'
import { FormItemLayout } from 'ui-patterns/form/FormItemLayout/FormItemLayout'
import { z } from 'zod'

import Panel from '@/components/ui/Panel'
import { useProjectCreateMutation } from '@/data/projects/project-create-mutation'
import { useLicenseQuery } from '@/data/misc/license-query'
import { useOrgProjectsInfiniteQuery } from '@/data/projects/org-projects-infinite-query'
import { useSelectedOrganizationQuery } from '@/hooks/misc/useSelectedOrganization'

type DeployMode = 'standalone' | 'standby' | 'cluster' | 'embedded' | 'pocketbase' | 'pocketbase-embedded'
type LicenseTier = 'free' | 'business' | 'enterprise'

const TIER_RANK: Record<LicenseTier, number> = { free: 0, business: 1, enterprise: 2 }

function meetsTier(current: LicenseTier | undefined, required: LicenseTier): boolean {
  return TIER_RANK[current ?? 'free'] >= TIER_RANK[required]
}

const schema = z.object({
  projectName: z
    .string()
    .trim()
    .min(3, 'Project name must be at least 3 characters')
    .max(64, 'Project name must be no longer than 64 characters'),
  dockerHost: z
    .string()
    .trim()
    .refine(
      (v) => {
        if (!v) return true
        try {
          const url = new URL(v)
          return url.protocol === 'ssh:' || url.protocol === 'tcp:'
        } catch {
          return false
        }
      },
      { message: 'Must be a valid Docker host URL (e.g. ssh://user@host or tcp://host:2376)' }
    )
    .optional(),
})

type FormValues = z.infer<typeof schema>

const DEPLOY_MODES: {
  value: DeployMode
  label: string
  description: string
  icon: React.ReactNode
  requiredTier?: LicenseTier
}[] = [
  {
    value: 'standalone',
    label: 'Standalone',
    description: 'Single Supabase stack. Simple and fast.',
    icon: <Server size={16} />,
  },
  {
    value: 'embedded',
    label: 'Embedded (shared infrastructure)',
    description: 'New database inside the existing Postgres instance. No new containers needed.',
    icon: <Layers size={16} />,
  },
  {
    value: 'standby',
    label: 'With failover standby',
    description: 'A warm standby promoted automatically in ~90 s if the primary fails.',
    icon: <ShieldCheck size={16} />,
    requiredTier: 'business',
  },
  {
    value: 'cluster',
    label: 'Cluster mode',
    description: 'One master + read replicas. Auto-promotes the next replica on master failure.',
    icon: <Database size={16} />,
    requiredTier: 'enterprise',
  },
  {
    value: 'pocketbase',
    label: 'PocketBase',
    description: 'Single-container PocketBase backend. SQLite-backed REST API, auth, file storage, and realtime.',
    icon: <Package size={16} />,
  },
  {
    value: 'pocketbase-embedded',
    label: 'PocketBase (embedded)',
    description: 'PocketBase via plain docker run — no Compose stack. Lighter than standalone; shares the existing Docker daemon.',
    icon: <Layers size={16} />,
  },
]

type SelfHostedProject = {
  ref: string
  name: string
  status?: string
  creation_mode?: string
}

export function SelfHostedProjectCreation() {
  const router = useRouter()
  const { data: currentOrg } = useSelectedOrganizationQuery()
  const { data: license } = useLicenseQuery()
  const currentTier = license?.tier
  const [deployMode, setDeployMode] = useState<DeployMode>('standalone')
  const [isPostCreate, setIsPostCreate] = useState(false)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [embeddedTargetRef, setEmbeddedTargetRef] = useState<string>('')

  const { data: projectsData } = useOrgProjectsInfiniteQuery(
    { slug: currentOrg?.slug ?? '' },
    { enabled: !!currentOrg?.slug && (deployMode === 'embedded' || deployMode === 'pocketbase-embedded') }
  )
  const allProjects = (projectsData?.pages.flatMap((p) => p?.projects ?? []) ?? []) as SelfHostedProject[]

  const supabaseTargets = allProjects.filter(
    (p) => p.status === 'ACTIVE_HEALTHY' && (!p.creation_mode || p.creation_mode === 'stack')
  )
  const pocketbaseTargets = allProjects.filter(
    (p) => p.status === 'ACTIVE_HEALTHY' && p.creation_mode === 'pocketbase'
  )

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    mode: 'onChange',
    defaultValues: { projectName: '', dockerHost: '' },
  })

  const { mutateAsync: createProjectAsync, isPending: isCreating } = useProjectCreateMutation()
  const isPending = isCreating || isPostCreate

  const onSubmit = async ({ projectName, dockerHost }: FormValues) => {
    if (!currentOrg) return toast.error('No organization selected')

    const docker_host = dockerHost?.trim() || undefined

    let project: { ref: string } | undefined
    try {
      project = await createProjectAsync({
        name: projectName,
        organizationSlug: currentOrg.slug,
        dbPass: '',
        selfHosted: {
          ...(deployMode === 'embedded'
            ? {
                creation_mode: 'embedded',
                ...(embeddedTargetRef && { embedded_target_ref: embeddedTargetRef }),
              }
            : deployMode === 'pocketbase'
              ? { creation_mode: 'pocketbase', docker_host }
              : deployMode === 'pocketbase-embedded'
                ? {
                    creation_mode: 'pocketbase-embedded',
                    docker_host: embeddedTargetRef ? undefined : docker_host,
                    ...(embeddedTargetRef && { embedded_target_ref: embeddedTargetRef }),
                  }
                : {
                    docker_host,
                    ...(deployMode === 'cluster' && { cluster_mode: true }),
                  }),
        },
      })
    } catch (err) {
      toast.error(`Failed to create project: ${err instanceof Error ? err.message : String(err)}`)
      return
    }

    if (!project) return

    if (deployMode === 'standby') {
      setIsPostCreate(true)
      try {
        const res = await fetch(`/api/platform/projects/${project.ref}/standby`, {
          method: 'POST',
          ...(docker_host && {
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ docker_host }),
          }),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
      } catch {
        toast.warning('Project created — standby could not be provisioned. Add it from Settings › General.')
      } finally {
        setIsPostCreate(false)
      }
    }

    router.push(`/project/${project.ref}`)
  }

  const submitLabel = () => {
    if (isPostCreate) return 'Provisioning standby...'
    if (isCreating) {
      if (deployMode === 'embedded') return 'Creating database...'
      if (deployMode === 'pocketbase') return 'Launching PocketBase...'
      if (deployMode === 'pocketbase-embedded') return 'Starting PocketBase container...'
      return 'Launching stack...'
    }
    return 'Create project'
  }

  return (
    <Form_Shadcn_ {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)}>
        <Panel
          title={
            <div>
              <h3>Create a new project</h3>
              <p className="text-sm text-foreground-lighter">
                A new isolated Supabase stack will be launched automatically. Ports and credentials
                are generated for you.
              </p>
            </div>
          }
          footer={
            <div className="flex items-center justify-end gap-2 p-4">
              <Button type="default" onClick={() => router.back()} disabled={isPending}>
                Cancel
              </Button>
              <Button htmlType="submit" loading={isPending} disabled={isPending}>
                {submitLabel()}
              </Button>
            </div>
          }
        >
          <Panel.Content className="space-y-4">
            <FormField_Shadcn_
              control={form.control}
              name="projectName"
              render={({ field }) => (
                <FormItemLayout
                  label="Project name"
                  layout="horizontal"
                  description="A short, memorable name for this Supabase project."
                >
                  <FormControl_Shadcn_>
                    <Input placeholder="My Project" {...field} />
                  </FormControl_Shadcn_>
                </FormItemLayout>
              )}
            />

            <FormItemLayout
              label="Deployment mode"
              layout="horizontal"
              description="Choose how this project is deployed."
            >
              <div className="flex flex-col gap-2 w-full">
                {DEPLOY_MODES.map((mode) => {
                  const isLocked = mode.requiredTier ? !meetsTier(currentTier, mode.requiredTier) : false
                  const tierLabel = mode.requiredTier === 'enterprise' ? 'Enterprise' : 'Business'
                  return (
                    <button
                      key={mode.value}
                      type="button"
                      disabled={isPending || isLocked}
                      onClick={() => {
                        if (!isLocked) {
                          setDeployMode(mode.value)
                          setEmbeddedTargetRef('')
                        }
                      }}
                      title={isLocked ? `Requires ${tierLabel} license` : undefined}
                      className={[
                        'flex items-start gap-3 rounded-md border px-3 py-2.5 text-left transition-colors',
                        isLocked
                          ? 'border-border-muted bg-surface-75 text-foreground-muted cursor-not-allowed opacity-60'
                          : deployMode === mode.value
                            ? 'border-brand bg-brand-200 text-foreground'
                            : 'border-border-strong bg-surface-100 text-foreground-light hover:border-foreground-muted',
                      ].join(' ')}
                    >
                      <span className="mt-0.5 shrink-0">{mode.icon}</span>
                      <span className="flex-1">
                        <span className="flex items-center gap-2 text-sm font-medium">
                          {mode.label}
                          {isLocked && (
                            <span className="inline-flex items-center rounded-sm bg-surface-300 px-1.5 py-0.5 text-[10px] font-medium text-foreground-muted">
                              {tierLabel}
                            </span>
                          )}
                        </span>
                        <span className="block text-xs text-foreground-light">{mode.description}</span>
                      </span>
                    </button>
                  )
                })}
              </div>
            </FormItemLayout>

            {(deployMode === 'embedded' || deployMode === 'pocketbase-embedded') && (
              <FormItemLayout
                label="Target project"
                layout="horizontal"
                description={
                  deployMode === 'embedded'
                    ? 'Create the new database inside this existing Supabase project\'s Postgres. Leave blank to use the default instance.'
                    : 'Share this existing PocketBase project\'s instance. Leave blank to launch a new container.'
                }
              >
                <Select_Shadcn_
                  value={embeddedTargetRef}
                  onValueChange={setEmbeddedTargetRef}
                  disabled={isPending}
                >
                  <SelectTrigger_Shadcn_ className="w-full">
                    <SelectValue_Shadcn_ placeholder="Default / no target" />
                  </SelectTrigger_Shadcn_>
                  <SelectContent_Shadcn_>
                    <SelectItem_Shadcn_ value="">Default / no target</SelectItem_Shadcn_>
                    {(deployMode === 'embedded' ? supabaseTargets : pocketbaseTargets).map((p) => (
                      <SelectItem_Shadcn_ key={p.ref} value={p.ref}>
                        {p.name}
                      </SelectItem_Shadcn_>
                    ))}
                  </SelectContent_Shadcn_>
                </Select_Shadcn_>
              </FormItemLayout>
            )}

            {deployMode !== 'embedded' && deployMode !== 'pocketbase-embedded' && (
              <button
                type="button"
                onClick={() => setShowAdvanced((v) => !v)}
                className="flex items-center gap-1 text-xs text-foreground-lighter hover:text-foreground transition-colors"
              >
                {showAdvanced ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                Advanced options
              </button>
            )}

            {deployMode !== 'embedded' && deployMode !== 'pocketbase-embedded' && showAdvanced && (
              <FormField_Shadcn_
                control={form.control}
                name="dockerHost"
                render={({ field }) => (
                  <FormItemLayout
                    label="External Docker host"
                    layout="horizontal"
                    description={
                      <>
                        Target a remote Docker daemon (e.g.{' '}
                        <code className="text-xs">ssh://user@192.168.1.10</code> or{' '}
                        <code className="text-xs">tcp://host:2376</code>). Leave blank to use
                        the local Docker daemon.
                      </>
                    }
                  >
                    <FormControl_Shadcn_>
                      <Input
                        placeholder="ssh://user@host"
                        disabled={isPending}
                        {...field}
                      />
                    </FormControl_Shadcn_>
                  </FormItemLayout>
                )}
              />
            )}
          </Panel.Content>
        </Panel>
      </form>
    </Form_Shadcn_>
  )
}
