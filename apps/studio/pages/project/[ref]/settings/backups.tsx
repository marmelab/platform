import {
  PageHeader,
  PageHeaderDescription,
  PageHeaderMeta,
  PageHeaderSummary,
  PageHeaderTitle,
} from 'ui-patterns/PageHeader'
import { PageContainer } from 'ui-patterns/PageContainer'

import { BackupPanel } from '@/components/interfaces/Settings/Backups/BackupPanel'
import DefaultLayout from '@/components/layouts/DefaultLayout'
import SettingsLayout from '@/components/layouts/ProjectSettingsLayout/SettingsLayout'
import type { NextPageWithLayout } from '@/types'

const BackupsPage: NextPageWithLayout = () => {
  return (
    <>
      <PageHeader size="small">
        <PageHeaderMeta>
          <PageHeaderSummary>
            <PageHeaderTitle>Database Backups</PageHeaderTitle>
            <PageHeaderDescription>
              Schedule and manage pg_dump backups for this project
            </PageHeaderDescription>
          </PageHeaderSummary>
        </PageHeaderMeta>
      </PageHeader>
      <PageContainer size="small">
        <BackupPanel />
      </PageContainer>
    </>
  )
}

BackupsPage.getLayout = (page) => (
  <DefaultLayout>
    <SettingsLayout title="Backups">{page}</SettingsLayout>
  </DefaultLayout>
)

export default BackupsPage
