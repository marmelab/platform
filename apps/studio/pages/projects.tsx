import { ExternalLink, Plus, RefreshCw, Trash2 } from 'lucide-react'
import Head from 'next/head'
import Link from 'next/link'
import { useRouter } from 'next/router'
import { useEffect, useState } from 'react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Badge,
  Button,
  Select_Shadcn_,
  SelectContent_Shadcn_,
  SelectItem_Shadcn_,
  SelectTrigger_Shadcn_,
  SelectValue_Shadcn_,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs_Shadcn_,
  TabsContent_Shadcn_,
  TabsList_Shadcn_,
  TabsTrigger_Shadcn_,
} from 'ui'

import { MigrateFromCloudPanel } from '@/components/interfaces/SelfHosted/MigrateFromCloudPanel'
import { MigrationsPanel } from '@/components/interfaces/SelfHosted/MigrationsPanel'
import { OAuthSetupPanel } from '@/components/interfaces/SelfHosted/OAuthSetupPanel'
import { StoragePanel } from '@/components/interfaces/SelfHosted/StoragePanel'

import { AppLayout } from '@/components/layouts/AppLayout/AppLayout'
import { DefaultLayout } from '@/components/layouts/DefaultLayout'
import { PageLayout } from '@/components/layouts/PageLayout/PageLayout'
import { ScaffoldContainer, ScaffoldSection } from '@/components/layouts/Scaffold'
import { useOrganizationDeleteMutation } from '@/data/organizations/organization-delete-mutation'
import { useOrganizationsQuery } from '@/data/organizations/organizations-query'
import {
  type OrgProject,
  useOrgProjectsInfiniteQuery,
} from '@/data/projects/org-projects-infinite-query'
import { useProjectDeleteMutation } from '@/data/projects/project-delete-mutation'
import { withAuth } from '@/hooks/misc/withAuth'
import type { NextPageWithLayout } from '@/types'

// OrgProject from api-types doesn't include our custom fields — extend locally
type SelfHostedProject = OrgProject & {
  public_url?: string
  kong_http_port?: number
  docker_project?: string
  creation_mode?: string
}

function statusBadgeVariant(
  status: string | undefined
): 'default' | 'warning' | 'success' | 'destructive' | 'secondary' {
  switch (status) {
    case 'ACTIVE_HEALTHY':
      return 'success'
    case 'COMING_UP':
    case 'RESTORING':
      return 'warning'
    case 'INACTIVE':
    case 'REMOVED':
      return 'destructive'
    default:
      return 'default'
  }
}

type Tab = 'projects' | 'oauth' | 'storage' | 'migrations' | 'import'

const ProjectsPage: NextPageWithLayout = () => {
  const router = useRouter()
  const [activeTab, setActiveTab] = useState<Tab>('projects')
  const [confirmDeleteProject, setConfirmDeleteProject] = useState<SelfHostedProject | null>(null)
  const [confirmDeleteOrg, setConfirmDeleteOrg] = useState(false)

  const { data: orgsData, isPending: isLoadingOrgs } = useOrganizationsQuery()
  const [selectedOrgSlug, setSelectedOrgSlug] = useState<string>('')

  // Once orgs are loaded, default to the first org
  useEffect(() => {
    if (orgsData && orgsData.length > 0 && !selectedOrgSlug) {
      setSelectedOrgSlug(orgsData[0].slug)
    }
  }, [orgsData, selectedOrgSlug])

  const selectedOrg = orgsData?.find((o) => o.slug === selectedOrgSlug)

  const { data, isPending, isFetching, refetch } = useOrgProjectsInfiniteQuery(
    { slug: selectedOrgSlug },
    {
      enabled: !!selectedOrgSlug,
      // Poll while any project is still coming up
      refetchInterval: (query) => {
        const projects = query.state.data?.pages.flatMap((p) => p?.projects ?? []) ?? []
        const hasTransient = projects.some(
          (p) => p.status === 'COMING_UP' || p.status === 'RESTORING'
        )
        return hasTransient ? 4000 : false
      },
    }
  )

  // Track the slug whose data is currently rendered. isSwitchingOrg is true
  // from the moment the user picks a different org until the first fetch for
  // that slug settles — but NOT during subsequent background polls (which also
  // set isFetching but shouldn't hide rows or show skeletons).
  const [renderedSlug, setRenderedSlug] = useState('')
  useEffect(() => {
    if (!isFetching && selectedOrgSlug) {
      setRenderedSlug(selectedOrgSlug)
    }
  }, [isFetching, selectedOrgSlug])
  const isSwitchingOrg = !!selectedOrgSlug && selectedOrgSlug !== renderedSlug

  const projects = (data?.pages.flatMap((p) => p?.projects ?? []) ?? []) as SelfHostedProject[]

  const { mutate: deleteProject, isPending: isDeletingProject } = useProjectDeleteMutation({
    onSuccess: () => setConfirmDeleteProject(null),
  })

  const { mutate: deleteOrg, isPending: isDeletingOrg } = useOrganizationDeleteMutation({
    onSuccess: () => {
      setConfirmDeleteOrg(false)
      // After deletion, switch to the next available org
      if (orgsData) {
        const remaining = orgsData.filter((o) => o.slug !== selectedOrgSlug)
        setSelectedOrgSlug(remaining[0]?.slug ?? '')
      }
    },
  })

  const canDeleteOrg = !isSwitchingOrg && !isFetching && projects.length === 0

  return (
    <>
      <Head>
        <title>Projects — Supabase</title>
      </Head>

      <ScaffoldContainer>
        <ScaffoldSection isFullWidth className="flex flex-col gap-y-4">
          <Tabs_Shadcn_
            value={activeTab}
            onValueChange={(v) => setActiveTab(v as Tab)}
            className="w-full"
          >
            <TabsList_Shadcn_ className="mb-2">
              <TabsTrigger_Shadcn_ value="projects">Projects</TabsTrigger_Shadcn_>
              <TabsTrigger_Shadcn_ value="oauth">OAuth Setup</TabsTrigger_Shadcn_>
              <TabsTrigger_Shadcn_ value="storage">Storage</TabsTrigger_Shadcn_>
              <TabsTrigger_Shadcn_ value="migrations">Migrations</TabsTrigger_Shadcn_>
              <TabsTrigger_Shadcn_ value="import">Import from Cloud</TabsTrigger_Shadcn_>
            </TabsList_Shadcn_>

            {/* ── OAuth tab ──────────────────────────────────────────── */}
            <TabsContent_Shadcn_ value="oauth">
              <OAuthSetupPanel projects={projects} />
            </TabsContent_Shadcn_>

            {/* ── Storage tab ────────────────────────────────────────── */}
            <TabsContent_Shadcn_ value="storage">
              <StoragePanel projects={projects} />
            </TabsContent_Shadcn_>

            {/* ── Migrations tab ─────────────────────────────────────── */}
            <TabsContent_Shadcn_ value="migrations">
              <MigrationsPanel projects={projects} />
            </TabsContent_Shadcn_>

            {/* ── Import from Cloud tab ───────────────────────────────── */}
            <TabsContent_Shadcn_ value="import">
              <MigrateFromCloudPanel projects={projects} />
            </TabsContent_Shadcn_>

            {/* ── Projects tab ───────────────────────────────────────── */}
            <TabsContent_Shadcn_ value="projects">
          {/* Org selector + actions */}
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-2">
              {isLoadingOrgs ? (
                <Skeleton className="h-9 w-48" />
              ) : (
                <Select_Shadcn_
                  value={selectedOrgSlug}
                  onValueChange={setSelectedOrgSlug}
                  disabled={!orgsData || orgsData.length === 0}
                >
                  <SelectTrigger_Shadcn_ className="w-48">
                    <SelectValue_Shadcn_ placeholder="Select organization" />
                  </SelectTrigger_Shadcn_>
                  <SelectContent_Shadcn_>
                    {orgsData?.map((org) => (
                      <SelectItem_Shadcn_ key={org.slug} value={org.slug}>
                        {org.name}
                      </SelectItem_Shadcn_>
                    ))}
                  </SelectContent_Shadcn_>
                </Select_Shadcn_>
              )}

              {!isSwitchingOrg && !isLoadingOrgs && (
                <span className="text-foreground-muted text-sm">
                  {projects.length} project{projects.length !== 1 ? 's' : ''}
                </span>
              )}
            </div>

            <div className="flex items-center gap-2">
              {/* Delete org — only when org is empty */}
              {canDeleteOrg && selectedOrg && (
                <Button
                  type="danger"
                  icon={<Trash2 size={14} />}
                  onClick={() => setConfirmDeleteOrg(true)}
                >
                  Delete org
                </Button>
              )}

              <Button
                type="default"
                icon={<RefreshCw size={14} className={isFetching ? 'animate-spin' : ''} />}
                onClick={() => refetch()}
                disabled={isFetching || !selectedOrgSlug}
              >
                Refresh
              </Button>

              <Button
                asChild
                type="primary"
                icon={<Plus size={14} />}
                disabled={!selectedOrgSlug}
              >
                <Link href={selectedOrgSlug ? `/new/${selectedOrgSlug}` : '#'}>New project</Link>
              </Button>
            </div>
          </div>

          {/* Table */}
          <div className="rounded-md border border-strong overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>URL</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {(isSwitchingOrg || isLoadingOrgs) && (
                  <>
                    {Array.from({ length: 3 }).map((_, i) => (
                      <TableRow key={i}>
                        <TableCell colSpan={5}>
                          <Skeleton className="h-5 w-full" />
                        </TableCell>
                      </TableRow>
                    ))}
                  </>
                )}

                {!isSwitchingOrg && !isLoadingOrgs && projects.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center text-foreground-muted py-10">
                      No projects in{' '}
                      <span className="text-foreground font-medium">{selectedOrg?.name}</span> yet.{' '}
                      {selectedOrgSlug && (
                        <Link
                          href={`/new/${selectedOrgSlug}`}
                          className="text-foreground underline underline-offset-2"
                        >
                          Create one
                        </Link>
                      )}
                    </TableCell>
                  </TableRow>
                )}

                {!isSwitchingOrg && projects.map((project) => (
                  <TableRow
                    key={project.ref}
                    className="cursor-pointer"
                    onClick={() => router.push(`/project/${project.ref}`)}
                  >
                    <TableCell className="font-medium">
                      <span className="flex items-center gap-2">
                        {project.name}
                        {(project.creation_mode === 'pocketbase' ||
                          project.creation_mode === 'pocketbase-embedded') && (
                          <Badge variant="default" className="text-[10px] px-1.5 py-0.5 font-medium">
                            {project.creation_mode === 'pocketbase-embedded'
                              ? 'PocketBase (embedded)'
                              : 'PocketBase'}
                          </Badge>
                        )}
                      </span>
                    </TableCell>

                    <TableCell>
                      <Badge variant={statusBadgeVariant(project.status ?? undefined)}>
                        {project.status ?? '—'}
                      </Badge>
                    </TableCell>

                    <TableCell className="text-foreground-muted text-sm">
                      {project.public_url ? (
                        <a
                          href={project.public_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-1 hover:text-foreground hover:underline"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {project.public_url}
                          <ExternalLink size={11} />
                        </a>
                      ) : (
                        '—'
                      )}
                    </TableCell>

                    <TableCell className="text-foreground-muted text-sm">
                      {project.inserted_at
                        ? new Date(project.inserted_at).toLocaleDateString(undefined, {
                            year: 'numeric',
                            month: 'short',
                            day: 'numeric',
                          })
                        : '—'}
                    </TableCell>

                    <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                      <Button
                        type="danger"
                        icon={<Trash2 size={14} />}
                        onClick={() => setConfirmDeleteProject(project)}
                      >
                        Delete
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
            </TabsContent_Shadcn_>
          </Tabs_Shadcn_>
        </ScaffoldSection>
      </ScaffoldContainer>

      {/* Delete project confirmation */}
      <AlertDialog
        open={!!confirmDeleteProject}
        onOpenChange={(open) => {
          if (!open && !isDeletingProject) setConfirmDeleteProject(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete &ldquo;{confirmDeleteProject?.name}&rdquo;?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the project, stop its Docker stack, and remove all
              associated data. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeletingProject}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={isDeletingProject}
              onClick={() => {
                if (confirmDeleteProject) {
                  deleteProject({
                    projectRef: confirmDeleteProject.ref,
                    organizationSlug: selectedOrgSlug,
                  })
                }
              }}
            >
              {isDeletingProject ? 'Deleting…' : 'Delete project'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete org confirmation */}
      <AlertDialog
        open={confirmDeleteOrg}
        onOpenChange={(open) => {
          if (!open && !isDeletingOrg) setConfirmDeleteOrg(false)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete &ldquo;{selectedOrg?.name}&rdquo;?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the organization. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeletingOrg}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={isDeletingOrg}
              onClick={() => {
                if (selectedOrgSlug) {
                  deleteOrg({ slug: selectedOrgSlug })
                }
              }}
            >
              {isDeletingOrg ? 'Deleting…' : 'Delete organization'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

ProjectsPage.getLayout = (page) => (
  <AppLayout>
    <DefaultLayout hideMobileMenu headerTitle="Projects">
      <PageLayout title="Projects" className="max-w-[1200px] lg:px-6 mx-auto">
        {page}
      </PageLayout>
    </DefaultLayout>
  </AppLayout>
)

export default withAuth(ProjectsPage)
