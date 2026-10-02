/**
 * Bi-directional migration runner between PocketBase and Supabase.
 *
 * PocketBase → Supabase:
 *   1. Authenticate with PocketBase admin API
 *   2. List all non-system collections
 *   3. CREATE TABLE in Postgres (via pg-meta query endpoint)
 *   4. Bulk-insert records via PostgREST
 *
 * Supabase → PocketBase:
 *   1. List Postgres tables via pg-meta
 *   2. Map column types → PocketBase field types
 *   3. Create PocketBase collections
 *   4. Read rows via PostgREST → create PocketBase records
 *
 * Jobs are persisted to DATA_DIR/pb-migrations/{id}.json + .log
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

// ── Types ─────────────────────────────────────────────────────────────────────

export type PBMigDirection = 'pb-to-supa' | 'supa-to-pb'
export type PBMigStatus = 'pending' | 'running' | 'done' | 'error'

export interface PBMigrationJob {
  id: string
  direction: PBMigDirection
  // Runtime-only secrets (never written to disk)
  pbAdminPassword?: string
  supaServiceKey?: string
  // Persisted
  pbUrl: string
  pbAdminEmail: string
  supaRef: string
  supaPublicUrl: string
  status: PBMigStatus
  logs: string[]
  startedAt: string
  finishedAt?: string
}

type PersistedMeta = Omit<PBMigrationJob, 'logs' | 'pbAdminPassword' | 'supaServiceKey'>

export type PBMigrationJobView = Omit<PBMigrationJob, 'pbAdminPassword' | 'supaServiceKey'>

// ── Persistence ───────────────────────────────────────────────────────────────

const DATA_DIR = process.env.STUDIO_DATA_DIR || path.join(/*turbopackIgnore: true*/ process.cwd(), '.studio-data')
const MIG_DIR = path.join(DATA_DIR, 'pb-migrations')

function metaPath(id: string) { return path.join(MIG_DIR, `${id}.json`) }
function logPath(id: string)  { return path.join(MIG_DIR, `${id}.log`)  }

function saveMeta(job: PBMigrationJob): void {
  try {
    fs.mkdirSync(MIG_DIR, { recursive: true })
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { logs, pbAdminPassword, supaServiceKey, ...meta } = job
    fs.writeFileSync(metaPath(job.id), JSON.stringify(meta, null, 2), 'utf-8')
  } catch { /* non-fatal */ }
}

function appendLog(id: string, line: string): void {
  try {
    fs.mkdirSync(MIG_DIR, { recursive: true })
    fs.appendFileSync(logPath(id), line + '\n', 'utf-8')
  } catch { /* non-fatal */ }
}

function readLogs(id: string): string[] {
  try {
    return fs.readFileSync(logPath(id), 'utf-8').split('\n').filter(Boolean)
  } catch { return [] }
}

// ── In-memory store ───────────────────────────────────────────────────────────

const jobs = new Map<string, PBMigrationJob>()

function loadJob(id: string): PBMigrationJob | undefined {
  if (jobs.has(id)) return jobs.get(id)
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath(id), 'utf-8')) as PersistedMeta
    const job: PBMigrationJob = { ...meta, logs: readLogs(id) }
    jobs.set(id, job)
    return job
  } catch { return undefined }
}

export function getPBMigrationJob(id: string): PBMigrationJobView | undefined {
  return loadJob(id)
}

// ── Type mapping helpers ──────────────────────────────────────────────────────

// PocketBase field type → Postgres column type
function pbTypeToPostgres(pbType: string, options?: Record<string, unknown>): string {
  switch (pbType) {
    case 'number':  return 'NUMERIC'
    case 'bool':    return 'BOOLEAN'
    case 'date':    return 'TIMESTAMPTZ'
    case 'json':    return 'JSONB'
    case 'autodate': return 'TIMESTAMPTZ'
    case 'select': {
      const maxSelect = (options as { maxSelect?: number } | undefined)?.maxSelect
      return maxSelect && maxSelect > 1 ? 'TEXT[]' : 'TEXT'
    }
    default: return 'TEXT'  // text, url, email, editor, file, relation, password
  }
}

// Postgres data type → PocketBase field type
function postgresTypeToPB(dataType: string): string {
  const t = dataType.toLowerCase()
  if (t.includes('int') || t.includes('serial')) return 'number'
  if (t.includes('numeric') || t.includes('float') || t.includes('double') || t.includes('real')) return 'number'
  if (t.includes('bool')) return 'bool'
  if (t.includes('timestamp') || t.includes('date') || t.includes('time')) return 'date'
  if (t.includes('json')) return 'json'
  if (t.includes('[]') || t === 'array') return 'json'
  return 'text'
}

// ── PocketBase admin auth ─────────────────────────────────────────────────────

async function pbAuthToken(pbUrl: string, email: string, password: string): Promise<string> {
  const res = await fetch(`${pbUrl}/api/collections/_superusers/auth-with-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identity: email, password }),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { message?: string }
    throw new Error(`PocketBase auth failed: ${body.message ?? res.status}`)
  }
  const data = await res.json() as { token: string }
  return data.token
}

// ── PocketBase → Supabase ─────────────────────────────────────────────────────

interface PBCollection {
  id: string
  name: string
  type: string
  fields: Array<{ name: string; type: string; options?: Record<string, unknown> }>
}

interface PBRecord {
  id: string
  created: string
  updated: string
  [key: string]: unknown
}

async function listPBCollections(pbUrl: string, token: string): Promise<PBCollection[]> {
  const res = await fetch(`${pbUrl}/api/collections?perPage=500`, {
    headers: { Authorization: token },
  })
  if (!res.ok) throw new Error(`Failed to list PocketBase collections: ${res.status}`)
  const body = await res.json() as { items: PBCollection[] }
  // Skip system collections (start with _) and auth/view types that don't have direct records
  return (body.items ?? []).filter(
    (c) => !c.name.startsWith('_') && c.type !== 'view'
  )
}

async function fetchAllPBRecords(
  pbUrl: string,
  token: string,
  collection: string
): Promise<PBRecord[]> {
  const all: PBRecord[] = []
  let page = 1
  const perPage = 500
  while (true) {
    const res = await fetch(
      `${pbUrl}/api/collections/${collection}/records?page=${page}&perPage=${perPage}&skipTotal=1`,
      { headers: { Authorization: token } }
    )
    if (!res.ok) break
    const body = await res.json() as { items: PBRecord[] }
    const items = body.items ?? []
    all.push(...items)
    if (items.length < perPage) break
    page++
  }
  return all
}

async function runPBToSupa(job: PBMigrationJob): Promise<void> {
  const log = (msg: string) => {
    job.logs.push(msg)
    appendLog(job.id, msg)
  }

  log(`[pb→supa] Authenticating with PocketBase at ${job.pbUrl}`)
  const token = await pbAuthToken(job.pbUrl, job.pbAdminEmail, job.pbAdminPassword!)

  log('[pb→supa] Listing collections…')
  const collections = await listPBCollections(job.pbUrl, token)
  log(`[pb→supa] Found ${collections.length} user collection(s): ${collections.map((c) => c.name).join(', ')}`)

  const serviceKey = job.supaServiceKey!
  const supaHeaders = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    'Content-Type': 'application/json',
  }

  for (const col of collections) {
    log(`\n[pb→supa] Processing collection: ${col.name}`)

    // Build CREATE TABLE SQL
    const colDefs = [
      'id TEXT PRIMARY KEY',
      'created TIMESTAMPTZ',
      'updated TIMESTAMPTZ',
    ]
    for (const field of col.fields) {
      // Skip system fields already defined above
      if (['id', 'created', 'updated'].includes(field.name)) continue
      const pgType = pbTypeToPostgres(field.type, field.options)
      colDefs.push(`${JSON.stringify(field.name)} ${pgType}`)
    }
    const createSql = `CREATE TABLE IF NOT EXISTS public.${JSON.stringify(col.name)} (${colDefs.join(', ')});`

    log(`[pb→supa]   Creating table: ${col.name}`)
    const createRes = await fetch(`${job.supaPublicUrl}/pg-meta/v0/query`, {
      method: 'POST',
      headers: supaHeaders,
      body: JSON.stringify({ query: createSql }),
    })
    if (!createRes.ok) {
      const body = await createRes.json().catch(() => ({})) as { message?: string }
      log(`[pb→supa]   WARNING: table creation failed: ${body.message ?? createRes.status}`)
    }

    // Fetch records
    log(`[pb→supa]   Fetching records from PocketBase…`)
    const records = await fetchAllPBRecords(job.pbUrl, token, col.name)
    log(`[pb→supa]   ${records.length} record(s) to insert`)

    if (records.length === 0) continue

    // Batch insert via PostgREST (max 1000 per request)
    const batchSize = 500
    let inserted = 0
    for (let i = 0; i < records.length; i += batchSize) {
      const batch = records.slice(i, i + batchSize)
      const insertRes = await fetch(
        `${job.supaPublicUrl}/rest/v1/${col.name}`,
        {
          method: 'POST',
          headers: {
            ...supaHeaders,
            Prefer: 'return=minimal,resolution=merge-duplicates',
          },
          body: JSON.stringify(batch),
        }
      )
      if (!insertRes.ok) {
        const body = await insertRes.json().catch(() => ({})) as { message?: string }
        log(`[pb→supa]   WARNING: insert batch ${i}–${i + batch.length} failed: ${body.message ?? insertRes.status}`)
      } else {
        inserted += batch.length
      }
    }
    log(`[pb→supa]   Inserted ${inserted}/${records.length} record(s) into ${col.name}`)
  }
}

// ── Supabase → PocketBase ─────────────────────────────────────────────────────

interface PGTable {
  id: number
  name: string
  schema: string
}

interface PGColumn {
  name: string
  data_type: string
  is_nullable: string
}

async function listSchemaTables(
  supaPublicUrl: string,
  serviceKey: string,
  schema = 'public'
): Promise<PGTable[]> {
  const res = await fetch(
    `${supaPublicUrl}/pg-meta/v0/tables?included_schemas=${schema}`,
    { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } }
  )
  if (!res.ok) throw new Error(`Failed to list Postgres tables: ${res.status}`)
  return res.json() as Promise<PGTable[]>
}

async function listTableColumns(
  supaPublicUrl: string,
  serviceKey: string,
  tableId: number
): Promise<PGColumn[]> {
  const res = await fetch(
    `${supaPublicUrl}/pg-meta/v0/columns?table_id=${tableId}`,
    { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } }
  )
  if (!res.ok) throw new Error(`Failed to list columns for table ${tableId}: ${res.status}`)
  return res.json() as Promise<PGColumn[]>
}

async function fetchAllSupaRows(
  supaPublicUrl: string,
  serviceKey: string,
  tableName: string
): Promise<Record<string, unknown>[]> {
  const all: Record<string, unknown>[] = []
  const pageSize = 1000
  let offset = 0
  while (true) {
    const res = await fetch(
      `${supaPublicUrl}/rest/v1/${tableName}?select=*&limit=${pageSize}&offset=${offset}`,
      {
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
          Prefer: 'count=none',
        },
      }
    )
    if (!res.ok) break
    const rows = await res.json() as Record<string, unknown>[]
    all.push(...rows)
    if (rows.length < pageSize) break
    offset += pageSize
  }
  return all
}

async function createPBCollection(
  pbUrl: string,
  token: string,
  name: string,
  fields: Array<{ name: string; type: string }>
): Promise<void> {
  const res = await fetch(`${pbUrl}/api/collections`, {
    method: 'POST',
    headers: {
      Authorization: token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name, type: 'base', fields }),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { message?: string }
    throw new Error(`Failed to create collection ${name}: ${body.message ?? res.status}`)
  }
}

async function runSupaToPB(job: PBMigrationJob): Promise<void> {
  const log = (msg: string) => {
    job.logs.push(msg)
    appendLog(job.id, msg)
  }

  const serviceKey = job.supaServiceKey!
  const supaHeaders = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    'Content-Type': 'application/json',
  }

  log(`[supa→pb] Listing tables in Supabase project ${job.supaRef}…`)
  const tables = await listSchemaTables(job.supaPublicUrl, serviceKey)
  log(`[supa→pb] Found ${tables.length} table(s): ${tables.map((t) => t.name).join(', ')}`)

  log(`[supa→pb] Authenticating with PocketBase at ${job.pbUrl}`)
  const token = await pbAuthToken(job.pbUrl, job.pbAdminEmail, job.pbAdminPassword!)

  for (const table of tables) {
    log(`\n[supa→pb] Processing table: ${table.name}`)

    const columns = await listTableColumns(job.supaPublicUrl, serviceKey, table.id)
    log(`[supa→pb]   ${columns.length} column(s)`)

    // Build PocketBase fields (skip system/Supabase columns)
    const SKIP_COLS = new Set(['id', 'created_at', 'updated_at'])
    const pbFields = columns
      .filter((c) => !SKIP_COLS.has(c.name))
      .map((c) => ({ name: c.name, type: postgresTypeToPB(c.data_type) }))

    log(`[supa→pb]   Creating PocketBase collection: ${table.name}`)
    try {
      await createPBCollection(job.pbUrl, token, table.name, pbFields)
    } catch (err) {
      log(`[supa→pb]   WARNING: ${err instanceof Error ? err.message : String(err)}`)
      // Continue — collection may already exist
    }

    log(`[supa→pb]   Fetching rows from Supabase…`)
    const rows = await fetchAllSupaRows(job.supaPublicUrl, serviceKey, table.name)
    log(`[supa→pb]   ${rows.length} row(s) to migrate`)

    if (rows.length === 0) continue

    let created = 0
    const batchSize = 100  // PocketBase doesn't have a bulk create endpoint; use sequential batches
    for (let i = 0; i < rows.length; i += batchSize) {
      const batch = rows.slice(i, i + batchSize)
      for (const row of batch) {
        // Map Postgres row to PocketBase record shape
        const pbRecord: Record<string, unknown> = {}
        for (const field of pbFields) {
          if (row[field.name] !== undefined) pbRecord[field.name] = row[field.name]
        }
        const createRes = await fetch(
          `${job.pbUrl}/api/collections/${table.name}/records`,
          {
            method: 'POST',
            headers: { Authorization: token, 'Content-Type': 'application/json' },
            body: JSON.stringify(pbRecord),
          }
        )
        if (createRes.ok) created++
      }
      log(`[supa→pb]   Inserted ${Math.min(i + batchSize, rows.length)}/${rows.length}…`)
    }
    log(`[supa→pb]   Done: ${created}/${rows.length} record(s) created in ${table.name}`)

    void supaHeaders // suppress unused-var warning
  }
}

// ── Public runner ─────────────────────────────────────────────────────────────

export interface StartPBMigrationOpts {
  direction: PBMigDirection
  pbUrl: string
  pbAdminEmail: string
  pbAdminPassword: string
  supaRef: string
  supaPublicUrl: string
  supaServiceKey: string
}

export function startPBMigration(opts: StartPBMigrationOpts): string {
  const id = crypto.randomBytes(8).toString('hex')
  const job: PBMigrationJob = {
    id,
    direction: opts.direction,
    pbUrl: opts.pbUrl,
    pbAdminEmail: opts.pbAdminEmail,
    pbAdminPassword: opts.pbAdminPassword,
    supaRef: opts.supaRef,
    supaPublicUrl: opts.supaPublicUrl,
    supaServiceKey: opts.supaServiceKey,
    status: 'pending',
    logs: [],
    startedAt: new Date().toISOString(),
  }

  jobs.set(id, job)
  saveMeta(job)

  const run = opts.direction === 'pb-to-supa' ? runPBToSupa : runSupaToPB

  job.status = 'running'
  saveMeta(job)

  run(job)
    .then(() => {
      job.status = 'done'
      job.finishedAt = new Date().toISOString()
      job.logs.push(`[done] Migration finished at ${job.finishedAt}`)
      appendLog(id, `[done] Migration finished at ${job.finishedAt}`)
      saveMeta(job)
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err)
      job.status = 'error'
      job.finishedAt = new Date().toISOString()
      job.logs.push(`[error] ${msg}`)
      appendLog(id, `[error] ${msg}`)
      saveMeta(job)
    })

  return id
}
