// Backups of the apps (M7, journey A4; B8 step 2 for the final backup). One module for every kind:
//   scheduled    the daily run (startBackupScheduler, CLI run-backups): every running, stopped or failed app
//   manual       create_backup (MCP, owner or admin), "Backup now" in the admin console, CLI backup-app
//   pre_restore  taken by a restore before it replaces the app's data (restore.ts)
//   final        delete_app, before anything is removed
//
// A backup is a directory <slug>-<timestamp>/ written on the backups volume:
//   database.dump     pg_dump -Fc of the app database (schema, data, auth users, Storage metadata), run in the Postgres
//                     container so that pg_dump always matches the server version
//   sites.tar.gz      the live frontend version (sites/<slug>/v<N>), when present
//   functions.tar.gz  the live functions version (functions/<slug>/v<N>), when present
//   storage.tar.gz    the app's Storage files (<storage>/<bucket>/<slug>/...), when present
//   storage-xattrs.json  their extended attributes (content type, cache control), which tar does not carry
//   secrets.enc       the app's keys (JWT secret, anon and service keys, role passwords) and its function secrets,
//                     encrypted with the platform master key (AES-256-GCM, crypto.ts): without them, a restored app
//                     would get new keys (its deployed frontend would break) and its functions no secrets
//   manifest.json     what was backed up, the live versions, the auth policy, the members and the repository link
//                     (no secret)
// Only the live versions of the frontend and functions are kept: older versions can be rebuilt from the app's
// repository by its CI (the platform does not host source code), and a daily copy of every version would grow without
// bound. After a restore, rolling back to a version that is not in the backup is refused (its files are gone).
//
// With an S3 target (settings backup_s3_*), the directory is uploaded to s3://<bucket>/<prefix>/<slug>-<timestamp>/
// and removed locally (the volume is only the staging area); otherwise it stays on the volume. One backup or restore
// at a time, across the control plane and the CLI (a session-level advisory lock). Failures are recorded in `backups`,
// shown on the admin dashboard and, for the scheduled run, emailed to the admins.
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import * as tar from "tar";
import { appRoles, databaseExistsSql } from "@platform/sql";
import { type AppRow, appSecrets, dbId, orchestrator, pathExists, UserError } from "./apps.ts";
import { audit } from "./audit.ts";
import type { User } from "./auth.ts";
import { adminUrl, config } from "./config.ts";
import { decrypt, encrypt } from "./crypto.ts";
import { many, one, platform, withAdmin, withClient } from "./db.ts";
import { currentTarget } from "./fsutil.ts";
import { sendPlatformMail } from "./mailer.ts";
import { ROUTING_MARKERS } from "./router.ts";
import { S3Client } from "./s3.ts";
import { dayKey, expiredBackups } from "./backup-retention.ts";
import { type BackupSettings, getSettings } from "./settings.ts";
import { saveStorageXattrs, storageFilesDir } from "./storage-realtime.ts";

export type BackupKind = "scheduled" | "manual" | "pre_restore" | "final";

export interface BackupRow {
  id: string;
  app_id: string | null;
  slug: string;
  kind: BackupKind;
  status: "running" | "succeeded" | "failed";
  started_at: Date;
  finished_at: Date | null;
  /** bigint: a string from pg. */
  size_bytes: string | null;
  location: string | null;
  files: Record<string, number> | null;
  manifest: BackupManifest | null;
  error: string | null;
  created_by: string | null;
}

export interface BackupManifest {
  /** 2 since M7 (secrets.enc, live versions only); 1 (absent) for the final backups taken before. */
  format?: number;
  slug: string;
  name: string | null;
  kind?: BackupKind;
  created_at: Date | string | null;
  status: string | null;
  github_repo: string | null;
  github_repo_id?: string | null;
  default_branch?: string | null;
  database: string | null;
  taken_at: string;
  files: Record<string, number>;
  /** Live versions backed up (v<N> directories); null when the app has none. */
  versions?: { frontend: number | null; functions: number | null };
  /** Whether storage-xattrs.json was saved (null: no Storage files). */
  storage_xattrs?: boolean | null;
  auth_config?: Record<string, unknown> | null;
  members?: { email: string; role: string }[];
}

/** What secrets.enc holds, once decrypted. */
export interface BackupSecrets {
  app: ReturnType<typeof appSecrets>;
  functions: Record<string, string>;
}

export const BACKUP_FILES = [
  "database.dump",
  "sites.tar.gz",
  "functions.tar.gz",
  "storage.tar.gz",
  "storage-xattrs.json",
  "secrets.enc",
  "manifest.json",
];

/** pg_advisory_lock key of backups and restores ("bckp" in ASCII). */
const LOCK_KEY = 0x62636b70;

const timestamp = (date = new Date()) => date.toISOString().replace(/[:.]/g, "-");
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Runs `fn` holding the cluster-wide backup lock: one backup or restore at a time (the scheduled run, manual backups,
 * final backups, restores, from the server or the CLI). Waits up to `waitSeconds` for a running one to finish.
 */
export function withBackupLock<T>(fn: () => Promise<T>, waitSeconds = 900): Promise<T> {
  return withClient({ database: config.pg.platformDb, applicationName: "control-plane-backup" }, async (c) => {
    await c.query(`set lock_timeout = '${Math.round(waitSeconds)}s'`);
    try {
      await c.query("select pg_advisory_lock($1)", [LOCK_KEY]);
    } catch (error) {
      if ((error as { code?: string }).code === "55P03") {
        throw new UserError("another backup or restore is in progress: try again in a few minutes");
      }
      throw error;
    }
    try {
      return await fn();
    } finally {
      await c.query("select pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => {});
    }
  });
}

/** The S3 target, when configured. */
export async function s3Target(settings?: BackupSettings): Promise<S3Client | null> {
  const backup = settings ?? (await getSettings()).backup;
  return backup.s3 ? new S3Client(backup.s3) : null;
}

const versionOf = (target: string | null) => {
  const match = target ? /^v(\d+)$/.exec(target) : null;
  return match ? Number(match[1]) : null;
};

/** Writes the backup files of an app into `dir`. Null when there is nothing at all to back up. */
async function writeBackupFiles(slug: string, app: AppRow | null, dir: string, kind: BackupKind) {
  const files: Record<string, number> = {};
  const database = appRoles(dbId(slug)).database;
  const exists = await withAdmin("postgres", async (c) => (await c.query(databaseExistsSql, [database])).rowCount === 1);
  if (exists) {
    await orchestrator.execToFile(
      config.docker.dbContainer,
      ["pg_dump", "--format=custom", "--host=localhost", `--username=${config.pg.adminUser}`, `--dbname=${database}`],
      { PGPASSWORD: config.pg.adminPassword },
      join(dir, "database.dump"),
    );
  }
  const versions: { frontend: number | null; functions: number | null } = { frontend: null, functions: null };
  for (const [name, kindName, root] of [
    ["sites", "frontend", config.dataDir.sites],
    ["functions", "functions", config.dataDir.functions],
  ] as const) {
    const appRoot = join(root, slug);
    if (!(await pathExists(appRoot))) continue;
    const target = await currentTarget(appRoot);
    const version = versionOf(target);
    if (version === null || !(await pathExists(join(appRoot, target!)))) continue;
    versions[kindName] = version;
    const markers = new Set(ROUTING_MARKERS);
    await tar.c({
      gzip: true,
      cwd: root,
      file: join(dir, `${name}.tar.gz`),
      portable: true,
      filter: (path) => !markers.has(path.split("/").pop()!),
    }, [`${slug}/${target}`]);
  }
  const storage = storageFilesDir(slug);
  let storageXattrs: boolean | null = null;
  if (await pathExists(storage)) {
    await tar.c({ gzip: true, cwd: join(storage, ".."), file: join(dir, "storage.tar.gz"), portable: true }, [slug]);
    // best effort: without them, restored files are served as application/octet-stream (Storage down: noted in the
    // manifest, the backup is still taken)
    storageXattrs = await saveStorageXattrs(slug, join(dir, "storage-xattrs.json"), orchestrator).then(() => true, async (error) => {
      console.error(`storage attributes of ${slug} not saved`, error);
      await rm(join(dir, "storage-xattrs.json"), { force: true });
      return false;
    });
  }
  let authConfig: Record<string, unknown> | null = null;
  let members: { email: string; role: string }[] = [];
  if (app) {
    const functions = await many<{ name: string; value_enc: string }>(
      "select name, value_enc from app_secrets where app_id = $1 order by name",
      [app.id],
    );
    const secrets: BackupSecrets = {
      app: appSecrets(app),
      functions: Object.fromEntries(functions.map((s) => [s.name, decrypt(s.value_enc)])),
    };
    await writeFile(join(dir, "secrets.enc"), encrypt(JSON.stringify(secrets)), { mode: 0o600 });
    authConfig = (await one<Record<string, unknown>>(
      `select signup_enabled, email_confirmation, allowed_email_domains, redirect_urls, sender_name, sender_email,
          sso_provider from app_auth_config where app_id = $1`,
      [app.id],
    )) ?? null;
    members = await many<{ email: string; role: string }>(
      "select u.email, m.role from app_members m join users u on u.id = m.user_id where m.app_id = $1 order by u.email",
      [app.id],
    );
  }
  for (const name of BACKUP_FILES) {
    const size = await stat(join(dir, name)).then((s) => s.size, () => null);
    if (size !== null) files[name] = size;
  }
  if (exists && !files["database.dump"]) throw new Error("pg_dump produced an empty file");
  if (!app && Object.keys(files).length === 0) return null;
  const manifest: BackupManifest = {
    format: 2,
    slug,
    name: app?.name ?? null,
    kind,
    created_at: app?.created_at ?? null,
    status: app?.status ?? null,
    github_repo: app?.github_repo ?? null,
    github_repo_id: app?.github_repo_id ?? null,
    default_branch: app?.default_branch ?? null,
    database: exists ? database : null,
    taken_at: new Date().toISOString(),
    files,
    versions,
    storage_xattrs: storageXattrs,
    auth_config: authConfig,
    members,
  };
  const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(join(dir, "manifest.json"), manifestJson, { mode: 0o600 });
  files["manifest.json"] = Buffer.byteLength(manifestJson);
  return { files, manifest };
}

/** Removes a backup's files, local or on S3. Local paths outside the backups volume are refused. */
export async function removeBackupFiles(location: string) {
  if (location.startsWith("s3://")) {
    const s3 = await s3Target();
    if (!s3) throw new Error(`${location}: no S3 target is configured any more`);
    const key = s3.keyOf(location);
    await s3.deletePrefix(key.endsWith("/") ? key : `${key}/`);
    return;
  }
  const root = resolve(config.dataDir.backups);
  const path = resolve(location);
  if (!path.startsWith(root + sep)) throw new Error(`${location} is not in the backups volume`);
  await rm(path, { recursive: true, force: true });
}

/**
 * Takes a backup of the app now and records it. Returns null when there is nothing to back up (no app row, database
 * or files: delete-app is idempotent). Throws if any part fails (the row is then `failed` and no file is left).
 * `lock: false`: the caller already holds the backup lock (a restore taking its pre_restore backup).
 */
export async function takeBackup(
  slug: string,
  kind: BackupKind,
  { actor = null, app, lock = true }: { actor?: User | null; app?: AppRow | null; lock?: boolean } = {},
): Promise<BackupRow | null> {
  const run = async () => {
    const target = app === undefined ? (await one<AppRow>("select * from apps where slug = $1", [slug])) ?? null : app;
    const settings = (await getSettings()).backup;
    const started = new Date();
    const row = (await one<BackupRow>(
      "insert into backups (app_id, slug, kind, started_at, created_by) values ($1, $2, $3, $4, $5) returning *",
      [target?.id ?? null, slug, kind, started, actor?.id ?? null],
    ))!;
    const name = `${slug}-${timestamp(started)}`;
    const dir = join(config.dataDir.backups, name);
    const s3 = await s3Target(settings);
    let uploaded = false;
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const result = await writeBackupFiles(slug, target, dir, kind);
      if (!result) {
        await rm(dir, { recursive: true, force: true });
        await platform.query("delete from backups where id = $1", [row.id]);
        return null;
      }
      let location = dir;
      if (s3) {
        uploaded = true;
        for (const file of Object.keys(result.files)) {
          try {
            await s3.putFile(`${name}/${file}`, join(dir, file));
          } catch (error) {
            throw new Error(`upload to S3 failed: ${message(error)}`);
          }
        }
        location = s3.location(`${name}/`);
        await rm(dir, { recursive: true, force: true });
      }
      const size = Object.values(result.files).reduce((n, s) => n + s, 0);
      return (await one<BackupRow>(
        `update backups set status = 'succeeded', finished_at = now(), size_bytes = $2, location = $3, files = $4,
            manifest = $5 where id = $1 returning *`,
        [row.id, size, location, JSON.stringify(result.files), JSON.stringify(result.manifest)],
      ))!;
    } catch (error) {
      await rm(dir, { recursive: true, force: true });
      if (uploaded && s3) await s3.deletePrefix(s3.key(`${name}/`)).catch(() => {});
      await platform.query("update backups set status = 'failed', finished_at = now(), error = $2 where id = $1", [
        row.id,
        message(error).slice(0, 2000),
      ]);
      throw new BackupError(`backup of ${slug} failed: ${message(error)}`, row.id);
    }
  };
  return lock ? withBackupLock(run) : run();
}

export class BackupError extends Error {
  readonly backupId: string;
  constructor(text: string, backupId: string) {
    super(text);
    this.backupId = backupId;
  }
}

/** Manual backup (MCP create_backup, admin console, CLI): audited. */
export async function createManualBackup(actor: User | null, app: AppRow) {
  if (app.status === "provisioning") throw new UserError(`app "${app.slug}" is still being provisioned`);
  const backup = await takeBackup(app.slug, "manual", { actor, app });
  await audit(actor?.id ?? null, app.id, "create_backup", {
    slug: app.slug,
    backup_id: backup?.id ?? null,
    location: backup?.location ?? null,
    size_bytes: backup ? Number(backup.size_bytes) : null,
  });
  return backupView(backup!);
}

/** A backup as returned by the APIs. */
export function backupView(row: BackupRow) {
  return {
    id: row.id,
    app: row.slug,
    app_deleted: row.app_id === null,
    kind: row.kind,
    status: row.status,
    started_at: row.started_at,
    finished_at: row.finished_at,
    duration_ms: row.finished_at ? row.finished_at.getTime() - row.started_at.getTime() : null,
    size_bytes: row.size_bytes === null ? null : Number(row.size_bytes),
    location: row.location,
    target: row.location?.startsWith("s3://") ? "s3" : row.location ? "local" : null,
    files: row.files,
    versions: row.manifest?.versions ?? null,
    error: row.error,
  };
}

export async function listBackups(appId: string, limit = 50) {
  const rows = await many<BackupRow>(
    "select * from backups where app_id = $1 order by started_at desc limit $2",
    [appId, limit],
  );
  return rows.map(backupView);
}

// ---------------------------------------------------------------------------------------------------------------
// retention

/** Applies the retention: deletes the files (local and S3) and the rows of the expired backups. Audited. */
export async function pruneBackups({ now = new Date() }: { now?: Date } = {}) {
  const settings = (await getSettings()).backup;
  const rows = await many<BackupRow>("select * from backups");
  const ids = new Set(expiredBackups(rows, settings, now));
  const pruned: { id: string; app: string; kind: string; started_at: Date; location: string | null }[] = [];
  const errors: { id: string; app: string; error: string }[] = [];
  for (const row of rows.filter((r) => ids.has(r.id))) {
    try {
      if (row.location) await removeBackupFiles(row.location);
      await platform.query("delete from backups where id = $1", [row.id]);
      pruned.push({ id: row.id, app: row.slug, kind: row.kind, started_at: row.started_at, location: row.location });
    } catch (error) {
      // kept: retried at the next run
      errors.push({ id: row.id, app: row.slug, error: message(error) });
    }
  }
  if (pruned.length || errors.length) {
    await audit(null, null, "prune_backups", {
      pruned: pruned.filter((p) => p.location).map((p) => ({ app: p.app, kind: p.kind, started_at: p.started_at })),
      failed_rows_forgotten: pruned.filter((p) => !p.location).length,
      errors,
    });
  }
  return { pruned, errors };
}

// ---------------------------------------------------------------------------------------------------------------
// scheduled run

export interface RunResult {
  started_at: Date;
  finished_at: Date;
  apps: number;
  succeeded: string[];
  failed: { app: string; backup_id: string | null; error: string }[];
  pruned: number;
  prune_errors: number;
  admins_notified: boolean;
}

/**
 * The daily run: a scheduled backup of every running, stopped or failed app, one at a time (each holds the lock, so a
 * restore or a manual backup can run in between), then the retention. Failures are audited per app and emailed to the
 * admins in one message.
 */
export async function runScheduledBackups({ apps: only }: { apps?: string[] } = {}): Promise<RunResult> {
  const startedAt = new Date();
  await platform.query(
    `insert into backup_state (id, run_started_at) values (1, now())
     on conflict (id) do update set run_started_at = now()`,
  );
  const apps = await many<AppRow>(
    `select * from apps where status in ('running', 'stopped', 'error') and ($1::text[] is null or slug = any($1))
      order by slug`,
    [only ?? null],
  );
  const succeeded: string[] = [];
  const failed: RunResult["failed"] = [];
  for (const app of apps) {
    try {
      // the app may have been deleted since the list was read
      const current = await one<AppRow>("select * from apps where id = $1", [app.id]);
      if (!current) continue;
      await takeBackup(app.slug, "scheduled", { app: current });
      succeeded.push(app.slug);
    } catch (error) {
      const backupId = error instanceof BackupError ? error.backupId : null;
      failed.push({ app: app.slug, backup_id: backupId, error: message(error) });
      await audit(null, app.id, "backup_failed", { slug: app.slug, kind: "scheduled", backup_id: backupId, error: message(error) })
        .catch(() => {});
    }
  }
  const prune = await pruneBackups().catch((error) => {
    console.error("backup retention failed", error);
    return { pruned: [], errors: [{ id: "", app: "", error: message(error) }] };
  });
  const notified = failed.length ? await notifyBackupFailures(failed).catch((error) => {
    console.error("backup failure email failed", error);
    return false;
  }) : false;
  const result: RunResult = {
    started_at: startedAt,
    finished_at: new Date(),
    apps: apps.length,
    succeeded,
    failed,
    pruned: prune.pruned.length,
    prune_errors: prune.errors.length,
    admins_notified: notified,
  };
  await platform.query("update backup_state set run_finished_at = now(), run_summary = $1 where id = 1", [
    JSON.stringify({ ...result, succeeded: succeeded.length }),
  ]);
  return result;
}

export function backupFailureMail(failed: RunResult["failed"]) {
  return {
    subject: `Backups failed for ${failed.length} app${failed.length > 1 ? "s" : ""}`,
    text: [
      "Hello,",
      "",
      `The scheduled backup of ${failed.length} app${failed.length > 1 ? "s" : ""} failed:`,
      "",
      ...failed.map((f) => `- ${f.app}: ${f.error}`),
      "",
      `These apps have no new backup today. Details in the admin console: ${adminUrl("/#/backups")}. ` +
      "Retry with \"Backup now\" on the app page, or with the CLI (run-backups) once the cause is fixed.",
      "",
      "You receive this email because you are a platform admin.",
    ].join("\n"),
  };
}

/** One email to every active admin; false without SMTP. */
async function notifyBackupFailures(failed: RunResult["failed"]) {
  const admins = (await many<{ email: string }>("select email from users where role = 'admin' and active order by email"))
    .map((u) => u.email);
  return sendPlatformMail({ to: admins, ...backupFailureMail(failed) });
}

/** Backups left `running` by a process that died (the lock is free: nothing is running). */
export async function failInterruptedBackups() {
  await withBackupLock(async () => {
    await platform.query(
      `update backups set status = 'failed', finished_at = now(), error = 'interrupted: the control plane stopped'
        where status = 'running'`,
    );
    // staging directories of interrupted backups and restores
    for (const entry of await readdir(config.dataDir.backups).catch(() => [] as string[])) {
      if (entry.startsWith(".restore-")) await rm(join(config.dataDir.backups, entry), { recursive: true, force: true });
    }
  }, 5);
}

/**
 * Checks every BACKUP_CHECK_INTERVAL_SECONDS whether today's run is due (enabled, the UTC hour reached, not claimed
 * yet today) and runs it in the background. The claim (backup_state.scheduled_on) makes one run per day across
 * processes and restarts; a run interrupted by a restart is not resumed that day (the dashboard shows the apps without
 * a recent backup).
 */
export function startBackupScheduler() {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const { backup } = await getSettings();
      const now = new Date();
      if (!backup.enabled || now.getUTCHours() < backup.hour) return;
      const claimed = await one(
        `insert into backup_state (id, scheduled_on) values (1, $1::date)
         on conflict (id) do update set scheduled_on = excluded.scheduled_on
           where backup_state.scheduled_on is distinct from excluded.scheduled_on
         returning id`,
        [dayKey(now)],
      );
      if (!claimed) return;
      const result = await runScheduledBackups();
      console.log(`scheduled backups: ${result.succeeded.length}/${result.apps} succeeded, ${result.pruned} pruned`);
    } catch (error) {
      console.error("scheduled backups failed", error);
    } finally {
      running = false;
    }
  };
  setTimeout(() => {
    failInterruptedBackups().catch((error) => console.error("backup recovery skipped", message(error))).finally(tick);
  }, 15_000).unref();
  setInterval(tick, config.backupCheckIntervalSeconds * 1000).unref();
}

// ---------------------------------------------------------------------------------------------------------------
// reading a backup back (restore.ts)

/**
 * Makes the backup's files available locally: its directory on the volume, or a download from S3 into `staging`.
 * Returns the directory.
 */
export async function fetchBackupFiles(row: BackupRow, staging: string): Promise<string> {
  if (!row.location) throw new UserError(`backup ${row.id} has no files`);
  await mkdir(staging, { recursive: true, mode: 0o700 });
  if (!row.location.startsWith("s3://")) {
    if (!(await pathExists(join(row.location, "manifest.json")))) {
      throw new UserError(`backup ${row.id}: ${row.location} is gone from the backups volume`);
    }
    return row.location;
  }
  const s3 = await s3Target();
  if (!s3) throw new UserError(`backup ${row.id} is on S3 (${row.location}) but no S3 target is configured`);
  const prefix = s3.keyOf(row.location);
  const objects = await s3.list(prefix);
  if (!objects.some((o) => o.key === `${prefix}manifest.json`)) {
    throw new UserError(`backup ${row.id}: ${row.location} is gone from the bucket`);
  }
  for (const object of objects) {
    const name = object.key.slice(prefix.length);
    if (!BACKUP_FILES.includes(name)) continue;
    await s3.getFile(object.key, join(staging, name));
  }
  return staging;
}
