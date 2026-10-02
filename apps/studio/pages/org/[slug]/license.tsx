import { PageContainer } from 'ui-patterns/PageContainer'
import {
  PageHeader,
  PageHeaderDescription,
  PageHeaderMeta,
  PageHeaderSummary,
  PageHeaderTitle,
} from 'ui-patterns/PageHeader'

import { LicenseSettings } from '@/components/interfaces/Organization/LicenseSettings/LicenseSettings'
import DefaultLayout from '@/components/layouts/DefaultLayout'
import OrganizationLayout from '@/components/layouts/OrganizationLayout'
import OrganizationSettingsLayout from '@/components/layouts/ProjectLayout/OrganizationSettingsLayout'
import type { NextPageWithLayout } from '@/types'

const OrgLicensePage: NextPageWithLayout = () => {
  return (
    <>
      <PageHeader size="default">
        <PageHeaderMeta>
          <PageHeaderSummary>
            <PageHeaderTitle>License</PageHeaderTitle>
            <PageHeaderDescription>
              Manage your Multi-Head Studio Pro license
            </PageHeaderDescription>
          </PageHeaderSummary>
        </PageHeaderMeta>
      </PageHeader>
      <PageContainer size="default">
        <LicenseSettings />
      </PageContainer>
    </>
  )
}

OrgLicensePage.getLayout = (page) => (
  <DefaultLayout>
    <OrganizationLayout title="License">
      <OrganizationSettingsLayout>{page}</OrganizationSettingsLayout>
    </OrganizationLayout>
  </DefaultLayout>
)

export default OrgLicensePage
