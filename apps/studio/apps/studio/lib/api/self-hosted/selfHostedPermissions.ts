/**
 * Role-based permission definitions for self-hosted GoTrue auth mode.
 *
 * Role IDs mirror SELF_HOSTED_ROLES in membersStore.ts:
 *   1 = Owner       – full access
 *   2 = Administrator – full access (billing is irrelevant in self-hosted)
 *   3 = Developer   – data r/w, no member/org management
 *   4 = Read-only   – read access only
 *
 * Permission objects follow the same shape as the cloud platform API so that
 * doPermissionsCheck() / useAsyncCheckPermissions() work without changes.
 */

import type { Permission } from '@/types'

// PermissionAction string values (matches @supabase/shared-types PermissionAction enum)
const A = {
  READ: 'read:Read',
  CREATE: 'write:Create',
  UPDATE: 'write:Update',
  DELETE: 'write:Delete',
  TENANT_SQL_ADMIN_READ: 'tenant:Sql:Admin:Read',
  TENANT_SQL_ADMIN_WRITE: 'tenant:Sql:Admin:Write',
  TENANT_SQL_CREATE_TABLE: 'tenant:Sql:CreateTable',
  TENANT_SQL_DELETE: 'tenant:Sql:Write:Delete',
  TENANT_SQL_INSERT: 'tenant:Sql:Write:Insert',
  TENANT_SQL_QUERY: 'tenant:Sql:Query',
  TENANT_SQL_SELECT: 'tenant:Sql:Read:Select',
  TENANT_SQL_UPDATE: 'tenant:Sql:Write:Update',
  FUNCTIONS_READ: 'functions:Read',
  FUNCTIONS_WRITE: 'functions:Write',
  FUNCTIONS_SECRET_READ: 'functions:Secret:Read',
  FUNCTIONS_SECRET_WRITE: 'functions:Secret:Write',
  STORAGE_ADMIN_READ: 'storage:Admin:Read',
  STORAGE_ADMIN_WRITE: 'storage:Admin:Write',
  STORAGE_READ: 'storage:Read',
  STORAGE_WRITE: 'storage:Write',
  AUTH_EXECUTE: 'auth:Execute',
  SECRETS_READ: 'secrets:Read',
  ANALYTICS_READ: 'analytics:Read',
  ANALYTICS_ADMIN_READ: 'analytics:Admin:Read',
  INFRA_EXECUTE: 'infra:Execute',
  REALTIME_ADMIN_READ: 'realtime:Admin:Read',
  REALTIME_ADMIN_WRITE: 'realtime:Admin:Write',
  REPLICATION_ADMIN_READ: 'replication:Admin:Read',
  REPLICATION_ADMIN_WRITE: 'replication:Admin:Write',
  BILLING_READ: 'billing:Read',
  BILLING_WRITE: 'billing:Write',
  SECRETS_WRITE: 'secrets:Write',
  ANALYTICS_ADMIN_WRITE: 'analytics:Admin:Write',
} as const

function perm(
  actions: string[],
  resources: string[],
  organization_slug: string,
  restrictive = false,
  condition: object | null = null
): Permission {
  return {
    actions: actions as any,
    resources,
    organization_slug,
    project_refs: [],
    condition: condition as any,
    restrictive,
  }
}

/** Returns the permissions array for a given role + org. */
export function permissionsForRole(role_id: number, organization_slug: string): Permission[] {
  switch (role_id) {
    // Owner & Administrator – full access
    case 1:
    case 2:
      return [perm(['%'], ['%'], organization_slug)]

    // Developer – data r/w; cannot manage team members or org settings
    case 3: {
      const developerActions = [
        A.READ,
        A.CREATE,
        A.UPDATE,
        A.DELETE,
        A.TENANT_SQL_ADMIN_READ,
        A.TENANT_SQL_ADMIN_WRITE,
        A.TENANT_SQL_CREATE_TABLE,
        A.TENANT_SQL_DELETE,
        A.TENANT_SQL_INSERT,
        A.TENANT_SQL_QUERY,
        A.TENANT_SQL_SELECT,
        A.TENANT_SQL_UPDATE,
        A.FUNCTIONS_READ,
        A.FUNCTIONS_WRITE,
        A.FUNCTIONS_SECRET_READ,
        A.FUNCTIONS_SECRET_WRITE,
        A.STORAGE_ADMIN_READ,
        A.STORAGE_ADMIN_WRITE,
        A.STORAGE_READ,
        A.STORAGE_WRITE,
        A.AUTH_EXECUTE,
        A.SECRETS_READ,
        A.ANALYTICS_READ,
        A.ANALYTICS_ADMIN_READ,
        A.INFRA_EXECUTE,
        A.REALTIME_ADMIN_READ,
        A.REPLICATION_ADMIN_READ,
      ]
      return [
        // Grant all developer actions on all resources…
        perm(developerActions, ['%'], organization_slug, false),
        // …except team/org management
        perm([A.CREATE, A.UPDATE, A.DELETE], ['user_invites'], organization_slug, true),
        perm([A.UPDATE, A.DELETE], ['organizations'], organization_slug, true),
        // …and cannot assign/remove Owner (1) or Administrator (2) roles
        perm(
          [A.CREATE, A.UPDATE, A.DELETE],
          ['auth.subject_roles'],
          organization_slug,
          true,
          { in: [{ var: 'resource.role_id' }, [1, 2]] }
        ),
      ]
    }

    // Read-only – no writes
    case 4: {
      const readOnlyActions = [
        A.READ,
        A.TENANT_SQL_ADMIN_READ,
        A.TENANT_SQL_SELECT,
        A.FUNCTIONS_READ,
        A.FUNCTIONS_SECRET_READ,
        A.STORAGE_ADMIN_READ,
        A.STORAGE_READ,
        A.SECRETS_READ,
        A.ANALYTICS_READ,
        A.ANALYTICS_ADMIN_READ,
        A.REALTIME_ADMIN_READ,
        A.REPLICATION_ADMIN_READ,
      ]
      return [perm(readOnlyActions, ['%'], organization_slug, false)]
    }

    default:
      return []
  }
}
