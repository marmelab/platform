import { useQuery } from '@tanstack/react-query'

import { constructHeaders } from '@/data/fetchers'
import { IS_PLATFORM } from '@/lib/constants'

export interface CurrentMemberInfo {
  gotrue_id?: string
  email?: string
  username?: string
  /** 1=Owner, 2=Administrator, 3=Developer, 4=Read-only */
  role_id: number
  org_slug?: string
  is_admin_session?: boolean
}

async function fetchCurrentMember(): Promise<CurrentMemberInfo | null> {
  const headers = await constructHeaders()
  const res = await fetch('/api/self-hosted/me', { headers })
  if (!res.ok) return null
  return res.json()
}

export function useCurrentMember() {
  const { data, isLoading } = useQuery<CurrentMemberInfo | null>({
    queryKey: ['self-hosted', 'current-member'],
    queryFn: fetchCurrentMember,
    enabled: !IS_PLATFORM,
    staleTime: 5 * 60 * 1000,
  })

  // Default to Owner (role 1) for: no-password mode, admin session, or unknown state.
  const role_id = data?.role_id ?? 1

  return {
    member: data ?? null,
    isLoading,
    isOwner: role_id === 1,
    isAdmin: role_id <= 2,
    isDeveloper: role_id <= 3,
    isReadOnly: role_id === 4,
    canManageTeam: role_id <= 2,
    canDeleteOrg: role_id === 1,
    canCreateProject: role_id <= 2,
    canManageSettings: role_id <= 2,
  }
}
