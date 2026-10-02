import fs from 'node:fs'
import { randomUUID, scryptSync, randomBytes, timingSafeEqual } from 'node:crypto'
import path from 'node:path'

const DATA_DIR = process.env.STUDIO_DATA_DIR || path.join(/*turbopackIgnore: true*/ process.cwd(), '.studio-data')
const MEMBERS_FILE = path.join(DATA_DIR, 'members.json')

export const SELF_HOSTED_ROLES = [
  { id: 1, name: 'Owner', base_role_id: 1, description: 'Full access to all resources and members', projects: [] },
  { id: 2, name: 'Administrator', base_role_id: 2, description: 'Manage project settings and team', projects: [] },
  { id: 3, name: 'Developer', base_role_id: 3, description: 'Read and write access to project data', projects: [] },
  { id: 4, name: 'Read-only', base_role_id: 4, description: 'Read-only access to project data', projects: [] },
] as const

export interface StoredMember {
  id: number
  gotrue_id: string
  username: string
  primary_email: string
  role_ids: number[]
  /** Set only when member has project-scoped access; null/undefined means org-scoped. */
  project_refs?: string[] | null
  created_at: string
  mfa_enabled: boolean
  is_sso_user: boolean
  metadata: Record<string, unknown>
  password_hash?: string
}

/** Returns the base role ID (1-4) from either an org-scoped or project-scoped role ID. */
export function getBaseRoleId(roleId: number): number {
  return roleId >= 1000 ? roleId % 10 : roleId
}

/** Computes the unique project-scoped role ID for a given member+role combination. */
export function projectScopedRoleId(memberId: number, baseRoleId: number): number {
  return 1000 + memberId * 10 + baseRoleId
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex')
  const hash = scryptSync(password, salt, 64).toString('hex')
  return `${salt}:${hash}`
}

export function verifyMemberPassword(password: string, stored: string): boolean {
  const colonIdx = stored.indexOf(':')
  if (colonIdx === -1) return false
  const salt = stored.slice(0, colonIdx)
  const hash = stored.slice(colonIdx + 1)
  try {
    const derived = scryptSync(password, salt, 64)
    return timingSafeEqual(derived, Buffer.from(hash, 'hex'))
  } catch {
    return false
  }
}

export function findMemberByEmail(email: string): { member: StoredMember; org_slug: string } | null {
  const store = read()
  const lc = email.toLowerCase()
  for (const [slug, data] of Object.entries(store)) {
    const member = data.members.find((m) => m.primary_email.toLowerCase() === lc)
    if (member) return { member, org_slug: slug }
  }
  return null
}

export function findMemberByGotrueId(gotrue_id: string): { member: StoredMember; org_slug: string } | null {
  const store = read()
  for (const [slug, data] of Object.entries(store)) {
    const member = data.members.find((m) => m.gotrue_id === gotrue_id)
    if (member) return { member, org_slug: slug }
  }
  return null
}

interface OrgData {
  members: StoredMember[]
}

type Store = Record<string, OrgData>

function read(): Store {
  try {
    if (!fs.existsSync(MEMBERS_FILE)) return {}
    return JSON.parse(fs.readFileSync(MEMBERS_FILE, 'utf-8'))
  } catch {
    return {}
  }
}

function write(store: Store): void {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(MEMBERS_FILE, JSON.stringify(store, null, 2), 'utf-8')
}

function orgData(store: Store, slug: string): OrgData {
  return store[slug] ?? { members: [] }
}

export function getOrgMembers(slug: string): StoredMember[] {
  return orgData(read(), slug).members
}

export function addOrgMember(
  slug: string,
  data: {
    primary_email: string
    role_id: number
    username?: string
    password?: string
    /** Provide the real GoTrue user id (sub) to use as gotrue_id instead of a random UUID. */
    gotrue_id_override?: string
  }
): StoredMember {
  const store = read()
  const org = orgData(store, slug)

  const maxId = org.members.reduce((m, x) => Math.max(m, x.id), 0)
  const member: StoredMember = {
    id: maxId + 1,
    gotrue_id: data.gotrue_id_override ?? randomUUID(),
    username: data.username ?? data.primary_email.split('@')[0],
    primary_email: data.primary_email,
    role_ids: [data.role_id],
    created_at: new Date().toISOString(),
    mfa_enabled: false,
    is_sso_user: false,
    metadata: {},
    ...(data.password ? { password_hash: hashPassword(data.password) } : {}),
  }

  org.members.push(member)
  store[slug] = org
  write(store)
  return member
}

export function assignOrgMemberRole(
  slug: string,
  gotrue_id: string,
  role_id: number,
  project_refs?: string[]
): StoredMember | null {
  const store = read()
  const org = orgData(store, slug)
  const idx = org.members.findIndex((m) => m.gotrue_id === gotrue_id)
  if (idx === -1) return null

  const member = org.members[idx]
  if (project_refs && project_refs.length > 0) {
    // Project-scoped: use a unique role ID = 1000 + member.id * 10 + base_role_id
    const psRoleId = projectScopedRoleId(member.id, role_id)
    org.members[idx] = { ...member, role_ids: [psRoleId], project_refs }
  } else {
    // Org-scoped: clear any project scoping
    org.members[idx] = { ...member, role_ids: [role_id], project_refs: null }
  }
  store[slug] = org
  write(store)
  return org.members[idx]
}

/**
 * Updates the project list for an existing project-scoped role.
 * If project_refs is empty, converts back to org-scoped.
 */
export function updateOrgMemberRoleProjectRefs(
  slug: string,
  gotrue_id: string,
  project_role_id: number,
  project_refs: string[]
): StoredMember | null {
  const store = read()
  const org = orgData(store, slug)
  const idx = org.members.findIndex((m) => m.gotrue_id === gotrue_id)
  if (idx === -1) return null

  const member = org.members[idx]
  if (project_refs.length === 0) {
    // Convert back to org-scoped using the base role ID
    const baseRoleId = getBaseRoleId(project_role_id)
    org.members[idx] = { ...member, role_ids: [baseRoleId], project_refs: null }
  } else {
    org.members[idx] = { ...member, project_refs }
  }
  store[slug] = org
  write(store)
  return org.members[idx]
}

export function unassignOrgMemberRole(
  slug: string,
  gotrue_id: string,
  role_id: number
): StoredMember | null {
  const store = read()
  const org = orgData(store, slug)
  const idx = org.members.findIndex((m) => m.gotrue_id === gotrue_id)
  if (idx === -1) return null

  org.members[idx] = {
    ...org.members[idx],
    role_ids: org.members[idx].role_ids.filter((r) => r !== role_id),
  }
  store[slug] = org
  write(store)
  return org.members[idx]
}

export function deleteOrgMember(slug: string, gotrue_id: string): boolean {
  const store = read()
  const org = orgData(store, slug)
  const before = org.members.length
  org.members = org.members.filter((m) => m.gotrue_id !== gotrue_id)
  if (org.members.length === before) return false
  store[slug] = org
  write(store)
  return true
}
