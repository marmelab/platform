import { useMutation } from '@tanstack/react-query'
import { toast } from 'sonner'

import { DesiredInstanceSize, PostgresEngine, ReleaseChannel } from './new-project.constants'
import { useInvalidateProjectsInfiniteQuery } from './org-projects-infinite-query'
import type { components } from '@/data/api'
import { handleError, post } from '@/data/fetchers'
import { PROVIDERS } from '@/lib/constants'
import { captureCriticalError } from '@/lib/error-reporting'
import type { ResponseError, UseCustomMutationOptions } from '@/types'

type CreateProjectBody = components['schemas']['CreateProjectBody']
type CloudProvider = CreateProjectBody['cloud_provider']

export type ProjectCreateVariables = {
  name: string
  organizationSlug: string
  dbPass: string
  dbRegion?: string
  regionSelection?: CreateProjectBody['region_selection']
  dbSql?: string
  dbPricingTierId?: string
  cloudProvider?: string
  authSiteUrl?: string
  customSupabaseRequest?: object
  dbInstanceSize?: DesiredInstanceSize
  dataApiExposedSchemas?: string[]
  dataApiUseApiSchema?: boolean
  postgresEngine?: PostgresEngine
  releaseChannel?: ReleaseChannel
  highAvailability?: boolean
  // Self-hosted multi-head fields
  selfHosted?: {
    db_host?: string
    db_port?: number
    db_user?: string
    db_name?: string
    anon_key?: string
    service_key?: string
    jwt_secret?: string
    public_url?: string
    docker_host?: string
    cluster_mode?: boolean
    creation_mode?: 'stack' | 'embedded' | 'pocketbase' | 'pocketbase-embedded'
    embedded_target_ref?: string
  }
}

export async function createProject({
  name,
  organizationSlug,
  dbPass,
  dbRegion,
  regionSelection,
  dbSql,
  cloudProvider = PROVIDERS.AWS.id,
  authSiteUrl,
  customSupabaseRequest,
  dbInstanceSize,
  dataApiExposedSchemas,
  dataApiUseApiSchema,
  postgresEngine,
  releaseChannel,
  highAvailability,
  selfHosted,
}: ProjectCreateVariables) {
  const body: CreateProjectBody = {
    cloud_provider: cloudProvider as CloudProvider,
    organization_slug: organizationSlug,
    name,
    db_pass: dbPass,
    db_region: dbRegion,
    region_selection: regionSelection,
    db_sql: dbSql,
    auth_site_url: authSiteUrl,
    ...(customSupabaseRequest !== undefined && {
      custom_supabase_internal_requests: customSupabaseRequest as any,
    }),
    desired_instance_size: dbInstanceSize,
    data_api_exposed_schemas: dataApiExposedSchemas,
    data_api_use_api_schema: dataApiUseApiSchema,
    postgres_engine: postgresEngine,
    release_channel: releaseChannel,
    high_availability: highAvailability,
    // Spread self-hosted extra fields so the self-hosted API handler can read them
    ...(selfHosted as any),
  }

  const { data, error } = await post(`/platform/projects`, {
    body,
  })

  if (error) handleError(error)
  return data
}

type ProjectCreateData = Awaited<ReturnType<typeof createProject>>

export const useProjectCreateMutation = ({
  onSuccess,
  onError,
  ...options
}: Omit<
  UseCustomMutationOptions<ProjectCreateData, ResponseError, ProjectCreateVariables>,
  'mutationFn'
> = {}) => {
  const { invalidateProjectsQuery } = useInvalidateProjectsInfiniteQuery()

  return useMutation<ProjectCreateData, ResponseError, ProjectCreateVariables>({
    mutationFn: (vars) => createProject(vars),
    async onSuccess(data, variables, context) {
      await invalidateProjectsQuery()
      await onSuccess?.(data, variables, context)
    },
    async onError(data, variables, context) {
      if (onError === undefined) {
        toast.error(`Failed to create new project: ${data.message}`)
      } else {
        onError(data, variables, context)
      }
      captureCriticalError(data, 'create project')
    },
    ...options,
  })
}
