// Restore of a backup (M7, journey A4), admin only (admin console, CLI restore-app), audited. Two cases:
// - into the same app (the backup's app still exists): a pre_restore backup of the current state is taken first
//   (unless skipped), the app is stopped, then its data is replaced;
// - a deleted app (the backup's app row is gone, e.g. its final backup): the app is recreated with the same slug,
//   name, keys, members (accounts that still exist) and repository link. The slug must be free.
// Both then run the same steps:
// 1. Database: the dump is restored with pg_restore into a fresh database created from template0 (not the
//    template: the dump holds every object, extensions and event triggers included, and restores identically into an
//    empty database), as supabase_admin, ownerships and grants included: the app's roles exist (recreated from the
//    backed-up passwords for a deleted app), and the global roles (anon, authenticated, service_role,
//    supabase_realtime_admin) are those of the cluster. The new database then replaces the app's (connections
//    refused, sessions terminated, renamed, the old one dropped). The platform's DDL event trigger is restored last by
//    pg_restore, so the restore itself is not recorded as schema changes.
// 2. Secrets: the app's keys and function secrets (secrets.enc), and its auth policy.
// 3. Files: the live frontend and functions versions are put back and made live (deployments rows updated or
//    recreated); the app's Storage files are replaced by the backup's, with their extended attributes.
// 4. The app is provisioned again (provision(): grants, GoTrue and PostgREST, Storage and Realtime tenants, routes,
//    Studio): it ends `running`.
// A failure before the database is replaced leaves the app as it was (restarted if it was running). A failure after
// leaves it in `error`: the pre_restore backup holds the state from before the restore.
import { mkdir, readFile, readdir, readlink, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import * as tar from "tar";
import { appRoles, clusterRolesSql, databaseExistsSql } from "@platform/sql";
import {
  type AppRow,
  appSecrets,
  dbId,
  deleteApp,
  generateSecrets,
  orchestrator,
  pathExists,
  provision,
  setDatabaseReadOnly,
  startApp,
  stopApp,
  UserError,
} from "./apps.ts";
import { audit } from "./audit.ts";
import type { User } from "./auth.ts";
import {
  type BackupManifest,
  type BackupRow,
  type BackupSecrets,
  backupView,
  fetchBackupFiles,
  takeBackup,
  withBackupLock,
} from "./backups.ts";
import { config } from "./config.ts";
import { decrypt, encrypt, randomHex } from "./crypto.ts";
import { many, one, platform, runAll, withAdmin } from "./db.ts";
import { markLive } from "./deployments.ts";
import { switchCurrent } from "./fsutil.ts";
import { unwatchSchema } from "./pgrst-relay.ts";
import { deleteRealtime, restoreStorageXattrs, storageFilesDir } from "./storage-realtime.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export async function backupById(id: string) {
  const row = UUID_RE.test(id) ? await one<BackupRow>("select * from backups where id = $1", [id]) : undefined;
  if (!row) throw new UserError(`backup ${id} not found`);
  return row;
}

/** The pg_restore of the dump into a new database, then the swap with the app's database. */
async function restoreDatabase(app: AppRow, dump: string) {
  const id = dbId(app.slug);
  const roles = appRoles(id);
  // the app's roles: unchanged for the same app, recreated (same passwords) for a deleted one
  await withAdmin("postgres", (c) => runAll(c, clusterRolesSql(id, appSecrets(app).passwords)));
  const temp = `${roles.database}_restore`;
  const old = `${roles.database}_replaced`;
  await withAdmin("postgres", async (c) => {
    await c.query(`drop database if exists ${temp} with (force)`);
    await c.query(`drop database if exists ${old} with (force)`);
    await c.query(`create database ${temp} template template0 owner ${roles.owner}`);
  });
  const remoteDir = `/tmp/platform-restore-${randomHex(6)}`;
  try {
    await orchestrator.exec(config.docker.dbContainer, ["mkdir", "-m", "700", remoteDir]);
    await orchestrator.copyTo(config.docker.dbContainer, dirname(dump), ["database.dump"], remoteDir);
    await orchestrator.exec(
      config.docker.dbContainer,
      ["pg_restore", "--exit-on-error", "--no-password", "--host=localhost", `--username=${config.pg.adminUser}`,
        `--dbname=${temp}`, `${remoteDir}/database.dump`],
      { PGPASSWORD: config.pg.adminPassword },
    );
  } catch (error) {
    await withAdmin("postgres", (c) => c.query(`drop database if exists ${temp} with (force)`)).catch(() => {});
    throw new Error(`pg_restore failed, the app's database is unchanged: ${message(error)}`);
  } finally {
    await orchestrator.exec(config.docker.dbContainer, ["rm", "-rf", remoteDir]).catch(() => {});
  }
  // the swap: no session may use either database while it is renamed
  await withAdmin("postgres", async (c) => {
    const exists = (await c.query(databaseExistsSql, [roles.database])).rowCount === 1;
    if (exists) {
      await c.query(`alter database ${roles.database} allow_connections false`);
      // Realtime's slots: dropped with the old database (DROP DATABASE refuses a database with logical slots)
      await c.query(
        "select pg_terminate_backend(active_pid) from pg_replication_slots where database = $1 and active_pid is not null",
        [roles.database],
      );
      for (let attempt = 1; ; attempt++) {
        await c.query("select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()", [
          roles.database,
        ]);
        try {
          await c.query(`alter database ${roles.database} rename to ${old}`);
          break;
        } catch (error) {
          // 55006: still accessed by a terminating session
          if ((error as { code?: string }).code !== "55006" || attempt >= 20) throw error;
          await sleep(250);
        }
      }
    }
    await c.query(`alter database ${temp} rename to ${roles.database}`);
    if (exists) {
      await c.query(
        "select pg_drop_replication_slot(slot_name) from pg_replication_slots where database = $1 and not temporary",
        [old],
      ).catch(() => {});
      await c.query(`drop database ${old} with (force)`);
    }
  });
}

/** Moves `from` to `to`, replacing it (same file system). */
async function replace(from: string, to: string) {
  await rm(to, { recursive: true, force: true });
  await rename(from, to);
}

/** Live versions and Storage files of the backup. */
async function restoreFiles(actor: User | null, app: AppRow, dir: string, manifest: BackupManifest, backupId: string) {
  const restored: Record<string, number | null> = { frontend: null, functions: null };
  for (const [name, kind, root] of [
    ["sites", "frontend", config.dataDir.sites],
    ["functions", "functions", config.dataDir.functions],
  ] as const) {
    const archive = join(dir, `${name}.tar.gz`);
    if (!(await pathExists(archive))) continue;
    const appRoot = join(root, app.slug);
    const temp = join(root, `.restore-${app.slug}-${randomHex(4)}`);
    try {
      await mkdir(temp, { recursive: true });
      await mkdir(appRoot, { recursive: true });
      // backups taken before M7 hold every version and the `current` link: the link is only read
      await tar.x({
        file: archive,
        cwd: temp,
        strict: true,
        preserveOwner: false,
        filter: (path, entry) => {
          const type = (entry as tar.ReadEntry).type;
          if (type === "SymbolicLink") return path.replace(/\/$/, "") === `${app.slug}/current`;
          return ["File", "OldFile", "ContiguousFile", "Directory"].includes(type);
        },
      });
      const staged = join(temp, app.slug);
      const versions = (await readdir(staged, { withFileTypes: true }))
        .filter((e) => e.isDirectory() && /^v\d+$/.test(e.name)).map((e) => e.name);
      for (const version of versions) await replace(join(staged, version), join(appRoot, version));
      const fromLink = await readlink(join(staged, "current")).catch(() => null);
      const live = manifest.versions?.[kind] ?? (fromLink && /^v\d+$/.test(fromLink) ? Number(fromLink.slice(1)) : null);
      if (live !== null && (await pathExists(join(appRoot, `v${live}`)))) {
        await switchCurrent(appRoot, `v${live}`);
        await setLiveVersion(actor, app, kind, live, backupId);
        restored[kind] = live;
      }
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }
  // Storage files: replaced by the backup's (none in the backup: none after the restore)
  const files = storageFilesDir(app.slug);
  const archive = join(dir, "storage.tar.gz");
  let storageFiles = 0;
  if (await pathExists(archive)) {
    const temp = join(dirname(files), `.restore-${app.slug}-${randomHex(4)}`);
    try {
      await mkdir(temp, { recursive: true });
      await tar.x({
        file: archive,
        cwd: temp,
        strict: true,
        preserveOwner: false,
        filter: (_path, entry) => {
          const ok = ["File", "OldFile", "ContiguousFile", "Directory"].includes((entry as tar.ReadEntry).type);
          if (ok && (entry as tar.ReadEntry).type !== "Directory") storageFiles++;
          return ok;
        },
      });
      if (await pathExists(join(temp, app.slug))) await replace(join(temp, app.slug), files);
      else await rm(files, { recursive: true, force: true });
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  } else {
    await rm(files, { recursive: true, force: true });
  }
  // content types and cache control of the files (Storage's extended attributes)
  let storageAttributes: number | null = null;
  if (storageFiles > 0 && (await pathExists(join(dir, "storage-xattrs.json")))) {
    storageAttributes = await restoreStorageXattrs(app.slug, dir, "storage-xattrs.json", orchestrator).catch((error) => {
      console.error(`storage attributes of ${app.slug} not restored`, error);
      return null;
    });
  }
  return { versions: restored, storage_files: storageFiles, storage_attributes: storageAttributes };
}

/** Makes `version` the live deployment of `kind` (its row recreated when it is gone, e.g. a deleted app). */
async function setLiveVersion(actor: User | null, app: AppRow, kind: "frontend" | "functions", version: number, backupId: string) {
  if (version === 0) {
    // the placeholder page of an app that never deployed its frontend: no deployment row
    await platform.query("update deployments set status = 'ready' where app_id = $1 and kind = $2 and status = 'live'", [
      app.id,
      kind,
    ]);
    return;
  }
  let row = await one<{ id: string }>("select id from deployments where app_id = $1 and kind = $2 and version = $3", [
    app.id,
    kind,
    version,
  ]);
  if (!row) {
    row = await one<{ id: string }>(
      `insert into deployments (app_id, kind, version, status, created_by, finalized_at, manifest)
       values ($1, $2, $3, 'ready', $4, now(), $5) returning id`,
      [app.id, kind, version, actor?.id ?? null, JSON.stringify({ restored_from_backup: backupId })],
    );
  }
  await markLive(app.id, kind, row!.id);
}

/** Keys, function secrets and auth policy of the backup. */
async function restoreSettings(app: AppRow, secrets: BackupSecrets | null, manifest: BackupManifest) {
  if (secrets) {
    app.secrets_enc = encrypt(JSON.stringify(secrets.app));
    await platform.query("update apps set secrets_enc = $2, updated_at = now() where id = $1", [app.id, app.secrets_enc]);
    await platform.query("delete from app_secrets where app_id = $1", [app.id]);
    for (const [name, value] of Object.entries(secrets.functions)) {
      await platform.query("insert into app_secrets (app_id, name, value_enc) values ($1, $2, $3)", [
        app.id,
        name,
        encrypt(value),
      ]);
    }
  }
  if (manifest.auth_config !== undefined) {
    await platform.query("delete from app_auth_config where app_id = $1", [app.id]);
    const auth = manifest.auth_config;
    if (auth) {
      await platform.query(
        `insert into app_auth_config (app_id, signup_enabled, email_confirmation, allowed_email_domains, redirect_urls,
            sender_name, sender_email, sso_provider) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [app.id, auth.signup_enabled, auth.email_confirmation, auth.allowed_email_domains, auth.redirect_urls,
          auth.sender_name, auth.sender_email, auth.sso_provider ?? null],
      );
    }
  }
}

/** A deleted app's row, members and keys, from its backup. The owners are the backed-up owners that still exist. */
async function recreateApp(actor: User | null, row: BackupRow, manifest: BackupManifest, secrets: BackupSecrets | null) {
  const members = await many<{ id: string; email: string }>(
    "select id, email from users where active and email = any($1) order by email",
    [(manifest.members ?? []).map((m) => m.email)],
  );
  const roleOf = new Map((manifest.members ?? []).map((m) => [m.email, m.role]));
  const owner = members.find((m) => roleOf.get(m.email) === "owner") ??
    (actor ? { id: actor.id, email: actor.email } : await one<{ id: string; email: string }>(
      "select id, email from users where role = 'admin' and active order by created_at limit 1",
    ));
  if (!owner) throw new UserError("no account can own the restored app: create an admin first");
  const appSecretsJson = JSON.stringify(secrets?.app ?? generateSecrets(row.slug));
  const app = await one<AppRow>(
    `insert into apps (slug, name, owner_id, db_name, secrets_enc, github_repo, github_repo_id, default_branch,
       created_at, restored_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, coalesce($9::timestamptz, now()), now()) on conflict (slug) do nothing
     returning *`,
    [row.slug, manifest.name ?? row.slug, owner.id, appRoles(dbId(row.slug)).database, encrypt(appSecretsJson),
      manifest.github_repo ?? null, manifest.github_repo_id ?? null, manifest.default_branch ?? null,
      manifest.created_at ?? null],
  );
  if (!app) throw new UserError(`slug "${row.slug}" is already taken`);
  for (const member of members) {
    await platform.query("insert into app_members (app_id, user_id, role) values ($1, $2, $3) on conflict do nothing", [
      app.id,
      member.id,
      roleOf.get(member.email) === "owner" ? "owner" : "collaborator",
    ]);
  }
  await platform.query(
    "insert into app_members (app_id, user_id, role) values ($1, $2, 'owner') on conflict (app_id, user_id) do update set role = 'owner'",
    [app.id, owner.id],
  );
  // the deleted app's backups belong to the restored app again
  await platform.query("update backups set app_id = $2 where app_id is null and slug = $1", [row.slug, app.id]);
  return app;
}

/**
 * Restores a backup (admin only, checked by the callers). `confirm` must repeat the app's slug. `safetyBackup`
 * (default true): a pre_restore backup of the current state first (same app only).
 */
export async function restoreBackup(
  actor: User | null,
  backupId: string,
  { confirm, safetyBackup = true }: { confirm: string; safetyBackup?: boolean },
) {
  const row = await backupById(backupId);
  if (row.status !== "succeeded") throw new UserError(`backup ${row.id} is ${row.status}: only a succeeded backup can be restored`);
  if (confirm !== row.slug) {
    throw new UserError(
      `restoring replaces the data of "${row.slug}" (database, files, secrets) with the backup's: pass confirm="${row.slug}"`,
    );
  }
  const current = await one<AppRow>("select * from apps where slug = $1", [row.slug]);
  if (row.app_id && current?.id !== row.app_id) throw new UserError(`the app of backup ${row.id} is gone`);
  if (!row.app_id && current) {
    throw new UserError(`slug "${row.slug}" is used by another app: a deleted app is restored under its own slug only`);
  }
  if (current?.status === "provisioning") throw new UserError(`app "${row.slug}" is being provisioned`);
  const mode = current ? "same_app" : "deleted_app";

  return withBackupLock(async () => {
    const started = Date.now();
    const staging = join(config.dataDir.backups, `.restore-${row.id.slice(0, 8)}-${randomHex(4)}`);
    let app: AppRow | null = current ?? null;
    let wasRunning = current?.status === "running";
    let replaced = false;
    let safety: BackupRow | null = null;
    try {
      const dir = await fetchBackupFiles(row, staging);
      const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")) as BackupManifest;
      if (manifest.slug !== row.slug) throw new Error(`manifest of backup ${row.id} is for "${manifest.slug}"`);
      const secrets = (await pathExists(join(dir, "secrets.enc")))
        ? JSON.parse(decrypt(await readFile(join(dir, "secrets.enc"), "utf8"))) as BackupSecrets
        : null;
      const dump = join(dir, "database.dump");
      const hasDump = await stat(dump).then((s) => s.size > 0, () => false);

      if (current) {
        if (safetyBackup) safety = await takeBackup(current.slug, "pre_restore", { actor, app: current, lock: false });
        await stopApp(actor, current);
        // the app's own connections: Realtime's tenant (recreated by provision), the schema relay
        await deleteRealtime(current.slug);
        await unwatchSchema(current.slug);
        app = current;
      } else {
        app = await recreateApp(actor, row, manifest, secrets);
        wasRunning = true;
      }
      // a deleted app's row already holds the backed-up keys (its roles get the backed-up passwords); the same app
      // keeps its current ones until the database is replaced
      if (hasDump) {
        await restoreDatabase(app, dump);
        replaced = true;
      }
      // keys, function secrets and auth policy (provision() then aligns the roles' passwords with the keys)
      await restoreSettings(app, secrets, manifest);
      replaced = true;
      const files = await restoreFiles(actor, app, dir, manifest, row.id);
      replaced = true;
      await setDatabaseReadOnly(app.slug, false);
      await platform.query("update apps set status = 'provisioning', restored_at = now(), updated_at = now() where id = $1", [
        app.id,
      ]);
      const fresh = (await one<AppRow>("select * from apps where id = $1", [app.id]))!;
      await provision(fresh);
      const result = {
        slug: app.slug,
        mode,
        status: "running",
        backup: backupView(row),
        pre_restore_backup: safety ? safety.id : null,
        database_restored: hasDump,
        secrets_restored: secrets !== null,
        ...files,
        ms: Date.now() - started,
      };
      await audit(actor?.id ?? null, app.id, "restore_app", {
        slug: app.slug,
        mode,
        backup_id: row.id,
        backup_kind: row.kind,
        backup_started_at: row.started_at,
        location: row.location,
        pre_restore_backup: result.pre_restore_backup,
        versions: files.versions,
        secrets_restored: result.secrets_restored,
      });
      return result;
    } catch (error) {
      const reason = message(error);
      if (app && mode === "deleted_app") {
        // nothing to keep: the half-recreated app goes, so that the restore can be retried
        await deleteApp(null, app.slug, { backup: false }).catch((e) => console.error(`cleanup of ${app!.slug} failed`, e));
      } else if (app && !replaced) {
        if (wasRunning) {
          const fresh = await one<AppRow>("select * from apps where id = $1", [app.id]);
          if (fresh) await startApp(actor, fresh).catch((e) => console.error(`restart of ${app!.slug} failed`, e));
        }
      } else if (app) {
        await platform.query("update apps set status = 'error', error = $2, updated_at = now() where id = $1", [
          app.id,
          `restore of backup ${row.id} failed: ${reason}`,
        ]);
      }
      // a recreated app was deleted again above: its id is gone
      await audit(actor?.id ?? null, mode === "deleted_app" ? null : app?.id ?? null, "restore_app_failed", {
        slug: row.slug,
        mode,
        backup_id: row.id,
        pre_restore_backup: safety?.id ?? null,
        data_replaced: replaced,
        error: reason,
      }).catch(() => {});
      if (error instanceof UserError) throw error;
      throw new Error(
        `restore of ${row.slug} from backup ${row.id} failed: ${reason}` +
          (replaced && safety ? ` (the state from before the restore is in backup ${safety.id})` : ""),
      );
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  });
}
