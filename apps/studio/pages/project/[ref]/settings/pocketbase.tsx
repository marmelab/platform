import { useParams } from 'common'
import { useQuery } from '@tanstack/react-query'
import {
  PageHeader,
  PageHeaderDescription,
  PageHeaderMeta,
  PageHeaderSummary,
  PageHeaderTitle,
} from 'ui-patterns/PageHeader'
import { PageContainer } from 'ui-patterns/PageContainer'
import {
  PageSection,
  PageSectionContent,
  PageSectionDescription,
  PageSectionMeta,
  PageSectionSummary,
  PageSectionTitle,
} from 'ui-patterns/PageSection'
import { GenericSkeletonLoader } from 'ui-patterns'

import { PocketBaseProjectPanel } from '@/components/interfaces/SelfHosted/PocketBaseProjectPanel'
import { PocketBaseMigratePanel } from '@/components/interfaces/SelfHosted/PocketBaseMigratePanel'
import DefaultLayout from '@/components/layouts/DefaultLayout'
import SettingsLayout from '@/components/layouts/ProjectSettingsLayout/SettingsLayout'
import type { NextPageWithLayout } from '@/types'

interface PBProject {
  ref: string
  name: string
  public_url: string
  creation_mode: string
  pocketbase_admin_email: string
  pocketbase_admin_password: string
  pocketbase_port: number
}

const PocketBaseSettingsPage: NextPageWithLayout = () => {
  const { ref } = useParams() as { ref: string }

  const { data: project, isLoading } = useQuery<PBProject>({
    queryKey: ['pb-project-detail', ref],
    queryFn: async () => {
      const res = await fetch(`/api/platform/projects/${ref}`)
      if (!res.ok) throw new Error('Failed to load project')
      return res.json()
    },
    enabled: !!ref,
    staleTime: 30_000,
  })

  return (
    <>
      <PageHeader size="small">
        <PageHeaderMeta>
          <PageHeaderSummary>
            <PageHeaderTitle>PocketBase</PageHeaderTitle>
            <PageHeaderDescription>
              Admin credentials, API URL, and data migration tools
            </PageHeaderDescription>
          </PageHeaderSummary>
        </PageHeaderMeta>
      </PageHeader>

      <PageContainer size="small">
        <PageSection>
          <PageSectionMeta>
            <PageSectionSummary>
              <PageSectionTitle>Admin Access</PageSectionTitle>
              <PageSectionDescription>
                Connect to your PocketBase instance and manage collections.
              </PageSectionDescription>
            </PageSectionSummary>
          </PageSectionMeta>
          <PageSectionContent>
            {isLoading ? (
              <GenericSkeletonLoader />
            ) : project?.pocketbase_admin_email ? (
              <PocketBaseProjectPanel
                adminEmail={project.pocketbase_admin_email}
                adminPassword={project.pocketbase_admin_password}
                publicUrl={project.public_url}
              />
            ) : (
              <p className="text-sm text-foreground-muted">
                Admin credentials not available. This may not be a PocketBase project.
              </p>
            )}
          </PageSectionContent>
        </PageSection>

        <PageSection>
          <PageSectionMeta>
            <PageSectionSummary>
              <PageSectionTitle>Data Migration</PageSectionTitle>
              <PageSectionDescription>
                Move data between this PocketBase instance and a Supabase project. Requires a
                running Supabase project in the same Studio as the migration target/source.
              </PageSectionDescription>
            </PageSectionSummary>
          </PageSectionMeta>
          <PageSectionContent>
            <PocketBaseMigratePanel supaRef={ref} />
          </PageSectionContent>
        </PageSection>
      </PageContainer>
    </>
  )
}

PocketBaseSettingsPage.getLayout = (page) => (
  <DefaultLayout>
    <SettingsLayout title="PocketBase">{page}</SettingsLayout>
  </DefaultLayout>
)

export default PocketBaseSettingsPage
