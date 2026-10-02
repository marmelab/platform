import fs from 'node:fs'
import path from 'node:path'

const DATA_DIR = process.env.STUDIO_DATA_DIR || path.join(/*turbopackIgnore: true*/ process.cwd(), '.studio-data')
const ORGS_FILE = path.join(DATA_DIR, 'organizations.json')

export interface StoredOrganization {
  id: number
  name: string
  slug: string
  billing_email: string | null
  billing_partner: null
  is_owner: boolean
  opt_in_tags: string[]
  organization_missing_address: boolean
  organization_missing_tax_id: boolean
  organization_requires_mfa: boolean
  plan: {
    id: 'free' | 'pro' | 'team' | 'enterprise' | 'platform'
    name: string
  }
  restriction_data: null
  restriction_status: null
  stripe_customer_id: null
  subscription_id: null
  usage_billing_enabled: boolean
}

/** The default org is always id=1 / slug='default-org-slug'. Never persisted. */
function makeDefaultOrg(): StoredOrganization {
  return {
    id: 1,
    name: process.env.DEFAULT_ORGANIZATION_NAME || 'Default Organization',
    slug: 'default-org-slug',
    billing_email: null,
    billing_partner: null,
    is_owner: true,
    opt_in_tags: [],
    organization_missing_address: false,
    organization_missing_tax_id: false,
    organization_requires_mfa: false,
    plan: { id: 'enterprise', name: 'Enterprise' },
    restriction_data: null,
    restriction_status: null,
    stripe_customer_id: null,
    subscription_id: null,
    usage_billing_enabled: false,
  }
}

function readFromDisk(): StoredOrganization[] {
  try {
    if (!fs.existsSync(ORGS_FILE)) return []
    return JSON.parse(fs.readFileSync(ORGS_FILE, 'utf-8'))
  } catch {
    return []
  }
}

function writeToDisk(orgs: StoredOrganization[]): void {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(ORGS_FILE, JSON.stringify(orgs, null, 2), 'utf-8')
}

export function getStoredOrganizations(): StoredOrganization[] {
  const persisted = readFromDisk()
  // If the default org has been renamed it will be in the persisted list; use that version.
  const persistedDefault = persisted.find((o) => o.slug === 'default-org-slug')
  const defaultOrg = persistedDefault ?? makeDefaultOrg()
  const others = persisted.filter((o) => o.slug !== 'default-org-slug')
  return [defaultOrg, ...others]
}

export function getStoredOrganizationBySlug(slug: string): StoredOrganization | undefined {
  return getStoredOrganizations().find((o) => o.slug === slug)
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'org'
}

function uniqueSlug(base: string, existing: StoredOrganization[]): string {
  const taken = new Set(existing.map((o) => o.slug))
  if (!taken.has(base)) return base
  let n = 2
  while (taken.has(`${base}-${n}`)) n++
  return `${base}-${n}`
}

export interface CreateOrganizationData {
  name: string
  kind?: string
  size?: string
  tier?: string
}

export function updateStoredOrganization(
  slug: string,
  patch: Partial<Pick<StoredOrganization, 'name' | 'billing_email'>>
): StoredOrganization | null {
  const org = getStoredOrganizationBySlug(slug)
  if (!org) return null
  const updated = { ...org, ...patch }
  // Write back — filter out any existing record for this slug (including default if persisted)
  const existing = readFromDisk().filter((o) => o.slug !== slug)
  writeToDisk([...existing, updated])
  return updated
}

export function deleteStoredOrganization(slug: string): void {
  const existing = readFromDisk()
  writeToDisk(existing.filter((o) => o.slug !== slug))
}

export function createStoredOrganization(data: CreateOrganizationData): StoredOrganization {
  const existing = readFromDisk()
  const all = getStoredOrganizations()
  const id = Math.max(...all.map((o) => o.id), 0) + 1
  const slug = uniqueSlug(slugify(data.name), all)

  const org: StoredOrganization = {
    id,
    name: data.name,
    slug,
    billing_email: null,
    billing_partner: null,
    is_owner: true,
    opt_in_tags: [],
    organization_missing_address: false,
    organization_missing_tax_id: false,
    organization_requires_mfa: false,
    plan: { id: 'free', name: 'Free' },
    restriction_data: null,
    restriction_status: null,
    stripe_customer_id: null,
    subscription_id: null,
    usage_billing_enabled: false,
  }

  writeToDisk([...existing, org])
  return org
}
