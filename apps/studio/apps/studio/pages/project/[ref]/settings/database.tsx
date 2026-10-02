import {
  PageHeader,
  PageHeaderDescription,
  PageHeaderMeta,
  PageHeaderSummary,
  PageHeaderTitle,
} from 'ui-patterns/PageHeader'
import { PageContainer } from 'ui-patterns/PageContainer'

import ResetDbPassword from '@/components/interfaces/Settings/Database/DatabaseSettings/ResetDbPassword'
import DefaultLayout from '@/components/layouts/DefaultLayout'
import SettingsLayout from '@/components/layouts/ProjectSettingsLayout/SettingsLayout'
import type { NextPageWithLayout } from '@/types'

const DatabaseSettingsPage: NextPageWithLayout = () => {
  return (
    <>
      <PageHeader size="small">
        <PageHeaderMeta>
          <PageHeaderSummary>
            <PageHeaderTitle>Database Settings</PageHeaderTitle>
            <PageHeaderDescription>Manage your database credentials</PageHeaderDescription>
          </PageHeaderSummary>
        </PageHeaderMeta>
      </PageHeader>
      <PageContainer size="small">
        <ResetDbPassword />
      </PageContainer>
    </>
  )
}

DatabaseSettingsPage.getLayout = (page) => (
  <DefaultLayout>
    <SettingsLayout title="Database">{page}</SettingsLayout>
  </DefaultLayout>
)

export default DatabaseSettingsPage
