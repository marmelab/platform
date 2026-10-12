// Admin CLI, run inside the control-plane container:
//   node src/cli.ts init
//   node src/cli.ts create-user <email> [admin|developer] [token-name]   -> prints a new PAT
//   node src/cli.ts delete-user <email>         (also deletes the user's sessions, tokens and memberships)
//   node src/cli.ts set-password <email>        (password read from stdin: docker exec -i ... < file)
//   node src/cli.ts set-password <email> --generate                     -> prints a generated password
//   node src/cli.ts add-member <slug> <email> [owner|collaborator]
//   node src/cli.ts remove-member <slug> <email>   (idempotent, refuses to remove the last owner)
//   node src/cli.ts stop-app <slug>            (maintenance page, containers stopped, database read-only)
//   node src/cli.ts start-app <slug>
//   node src/cli.ts delete-app <slug> [--no-backup]   (final backup first, prints its path; aborted if the backup
//                                                     fails; --no-backup skips it: the data is lost for good)
//   node src/cli.ts settings                       (effective platform settings)
//   node src/cli.ts set-setting <key> <value>      (overrides the environment, e.g. direct_deploy admins; smtp_password
//                                                  and sso_client_secret are read from stdin when the value is "-"; an
//                                                  smtp_* change recreates the GoTrue of every running app, one at a
//                                                  time; an sso_* provider change updates the apps using company SSO)
//   node src/cli.ts unset-setting <key>            (back to the environment's value)
//   node src/cli.ts sync-auth                      (recreates the GoTrue of running apps whose environment changed)
//   node src/cli.ts sample-metrics                 (samples app_metrics now, as the control plane does every minute)
//   node src/cli.ts realtime-migrate <slug>|--all  (after a Realtime upgrade: recreates the app's Realtime tenant, which
//                                                  runs the new tenant migrations; its clients reconnect)
//   node src/cli.ts backup-app <slug>              (manual backup now, audited; prints it as JSON)
//   node src/cli.ts list-backups [<slug>]          (newest first, every app's or one slug's, deleted apps included)
//   node src/cli.ts restore-app <backup-id> --confirm <slug> [--no-safety-backup]
//                                                  (replaces the app's database, files and secrets with the backup's,
//                                                  after a pre_restore backup; a deleted app is recreated; audited)
//   node src/cli.ts run-backups [<slug>...]        (the daily run now: scheduled backups, retention, failure email)
//   node src/cli.ts prune-backups [--now <iso date>]   (the retention alone; --now simulates another date)
//   node src/cli.ts lint-apps [--source manual|upgrade] [<slug>...]  (security linter now, results recorded)
//   node src/cli.ts recycle-apps [--force] [<slug>...]  (A8: recreates the GoTrue and PostgREST containers whose spec or
//                                                  image changed, one app at a time, without downtime; --force: all)
//   node src/cli.ts verify [--json]                (A8: checks the shared services and every app; exit 1 on a failure)
//   node src/cli.ts version                        (running version, previous one, components)
import { randomBytes } from "node:crypto";
import { text } from "node:stream/consumers";
import type { MemberRole } from "@platform/shared";
import { type AppRow, deleteApp, startApp, stopApp, syncAuthServices } from "./apps.ts";
import { createToken, upsertUser } from "./auth.ts";
import { many, one, platform } from "./db.ts";
import { initCluster } from "./init.ts";
import { registerRealtime } from "./storage-realtime.ts";
import { sampleMetrics } from "./metrics.ts";
import { addMember, removeMember } from "./members.ts";
import { deleteShadowUser } from "./platform-auth.ts";
import { setPassword } from "./sessions.ts";
import {
  ENCRYPTED_KEYS,
  getSettings,
  setSetting,
  settingsSummary,
  SMTP_KEYS,
  SSO_PROVIDER_KEYS,
  unsetSetting,
} from "./settings.ts";
import { audit } from "./audit.ts";
import { syncCompanySso } from "./app-sso.ts";
import { backupView, type BackupRow, createManualBackup, pruneBackups, runScheduledBackups } from "./backups.ts";
import { restoreBackup } from "./restore.ts";
import { lintApps, type LintSource } from "./lint.ts";
import { recycleApps } from "./apps.ts";
import { verifyPlatform } from "./verify.ts";
import { platformVersion } from "./version.ts";

const USAGE = "usage: cli.ts init | create-user <email> [admin|developer] [token-name] | delete-user <email> | " +
  "set-password <email> [--generate] | add-member <slug> <email> [owner|collaborator] | remove-member <slug> <email> | stop-app <slug> | start-app <slug> | delete-app <slug> [--no-backup] | " +
  "settings | set-setting <key> <value> | unset-setting <key> | sync-auth | sample-metrics | realtime-migrate <slug>|--all | " +
  "backup-app <slug> | list-backups [<slug>] | restore-app <backup-id> --confirm <slug> [--no-safety-backup] | " +
  "run-backups [<slug>...] | prune-backups [--now <iso date>] | lint-apps [--source manual|upgrade] [<slug>...] | " +
  "recycle-apps [--force] [<slug>...] | verify [--json] | version";

const [command, ...args] = process.argv.slice(2);

/** Every running app's GoTrue gets the platform SMTP settings now in effect. */
async function syncAuth() {
  const { apps, failed } = await syncAuthServices();
  console.log(`auth service of ${apps - failed.length}/${apps} running apps up to date${failed.length ? `, failed: ${failed.join(", ")}` : ""}`);
  if (failed.length) process.exitCode = 1;
}

async function appBySlug(slug: string) {
  const app = await one<AppRow>("select * from apps where slug = $1", [slug]);
  if (!app) throw new Error(`unknown app ${slug}`);
  return app;
}

if (command === "init") {
  await initCluster();
  console.log("cluster initialised");
} else if (command === "create-user") {
  const [email, role = "developer", tokenName = "default"] = args;
  if (!email || !["admin", "developer"].includes(role)) throw new Error("usage: create-user <email> [admin|developer]");
  const user = await upsertUser(email, role as "admin" | "developer");
  console.log(await createToken(user.id, tokenName));
} else if (command === "delete-user" && args[0]) {
  const deleted = await one<{ id: string }>("delete from users where email = $1 returning id", [args[0].toLowerCase()]);
  if (!deleted) throw new Error(`unknown user ${args[0]}`);
  await deleteShadowUser(deleted.id);
  console.log(`user ${args[0]} deleted`);
} else if (command === "set-password" && args[0]) {
  const generate = args[1] === "--generate";
  const password = generate ? randomBytes(18).toString("base64url") : (await text(process.stdin)).trim();
  await setPassword(args[0], password);
  console.log(generate ? password : `password set for ${args[0]}`);
} else if (command === "add-member" && args[0] && args[1]) {
  const [slug, email, role = "collaborator"] = args;
  if (!["owner", "collaborator"].includes(role)) throw new Error("role must be owner or collaborator");
  await addMember(null, await appBySlug(slug), email, role as MemberRole);
  console.log(`${email} is ${role} of ${slug}`);
} else if (command === "remove-member" && args[0] && args[1]) {
  const [slug, email] = args;
  const { removed } = await removeMember(null, await appBySlug(slug), email);
  console.log(removed ? `${email} removed from ${slug}` : `${email} is not a member of ${slug}`);
} else if (command === "stop-app" && args[0]) {
  const { changed } = await stopApp(null, await appBySlug(args[0]));
  console.log(changed ? `app ${args[0]} stopped` : `app ${args[0]} is already stopped`);
} else if (command === "start-app" && args[0]) {
  const { changed } = await startApp(null, await appBySlug(args[0]));
  console.log(changed ? `app ${args[0]} started` : `app ${args[0]} is already running`);
} else if (command === "delete-app" && args[0] && args.slice(1).every((a) => a === "--no-backup")) {
  const { backup, backup_skipped } = await deleteApp(null, args[0], { backup: !args.includes("--no-backup") });
  console.log(
    backup ? `app ${args[0]} deleted, backup in ${backup}`
    : backup_skipped ? `app ${args[0]} deleted, without backup`
    : `app ${args[0]} deleted (nothing to back up)`,
  );
} else if (command === "settings") {
  console.log(JSON.stringify(settingsSummary(await getSettings()), null, 2));
} else if (command === "set-setting" && args[0] && args[1] !== undefined) {
  const secret = ENCRYPTED_KEYS.includes(args[0]);
  const value = secret && args[1] === "-" ? (await text(process.stdin)).trim() : args[1];
  await setSetting(args[0], value);
  // no actor: the CLI runs in the control plane container (TECH_DEBT CP-8)
  await audit(null, null, "set_setting", { key: args[0], value: secret ? "(secret)" : value, source: "cli" });
  console.log(`${args[0]} set`);
  if (SMTP_KEYS.includes(args[0])) await syncAuth();
  if (SSO_PROVIDER_KEYS.includes(args[0])) console.log(JSON.stringify(await syncCompanySso()));
} else if (command === "unset-setting" && args[0]) {
  await unsetSetting(args[0]);
  await audit(null, null, "unset_setting", { key: args[0], source: "cli" });
  console.log(`${args[0]} unset`);
  if (SMTP_KEYS.includes(args[0])) await syncAuth();
  if (SSO_PROVIDER_KEYS.includes(args[0])) console.log(JSON.stringify(await syncCompanySso()));
} else if (command === "sync-auth") {
  await syncAuth();
} else if (command === "sample-metrics") {
  console.log(JSON.stringify(await sampleMetrics()));
} else if (command === "realtime-migrate" && args[0]) {
  const apps = args[0] === "--all"
    ? await many<AppRow>("select * from apps where status = 'running' order by slug")
    : [await appBySlug(args[0])];
  for (const app of apps) {
    if (app.status !== "running") throw new Error(`app ${app.slug} is ${app.status}: start it first`);
    await registerRealtime(app, { migrate: true });
    console.log(`realtime tenant of ${app.slug} migrated`);
  }
} else if (command === "backup-app" && args[0]) {
  console.log(JSON.stringify(await createManualBackup(null, await appBySlug(args[0])), null, 2));
} else if (command === "list-backups") {
  const rows = await many<BackupRow>(
    "select * from backups where ($1::text is null or slug = $1) order by started_at desc limit 200",
    [args[0] ?? null],
  );
  for (const b of rows.map(backupView)) {
    console.log([b.id, b.app, b.kind, b.status, b.started_at.toISOString(), b.size_bytes ?? "-", b.location ?? b.error ?? "-",
      b.app_deleted ? "(app deleted)" : ""].join("  "));
  }
} else if (command === "restore-app" && args[0]) {
  const confirm = args[args.indexOf("--confirm") + 1];
  if (!args.includes("--confirm") || !confirm) throw new Error("restore-app replaces the app's data: add --confirm <slug>");
  const result = await restoreBackup(null, args[0], { confirm, safetyBackup: !args.includes("--no-safety-backup") });
  console.log(JSON.stringify(result, null, 2));
} else if (command === "run-backups") {
  const result = await runScheduledBackups({ apps: args.length ? args : undefined });
  console.log(JSON.stringify(result, null, 2));
  if (result.failed.length) process.exitCode = 1;
} else if (command === "prune-backups") {
  const at = args.indexOf("--now");
  const now = at >= 0 ? new Date(args[at + 1] ?? "") : new Date();
  if (Number.isNaN(now.getTime())) throw new Error("--now takes an ISO date, e.g. 2026-11-01T03:00:00Z");
  const result = await pruneBackups({ now });
  console.log(JSON.stringify({ pruned: result.pruned.length, errors: result.errors, ids: result.pruned.map((p) => p.id) }));
} else if (command === "lint-apps") {
  const at = args.indexOf("--source");
  const source = (at >= 0 ? args[at + 1] : "manual") as LintSource;
  if (!["manual", "upgrade"].includes(source)) throw new Error("--source is manual or upgrade");
  const slugs = args.filter((_, i) => at < 0 || (i !== at && i !== at + 1));
  const results = await lintApps(source, { only: slugs.length ? slugs : undefined });
  for (const r of results) {
    console.log(r.error ? `${r.app}: lint failed: ${r.error}`
      : `${r.app}: ${r.errors} errors (${r.unaccepted_errors} not accepted), ${r.warnings} warnings, ${r.infos} infos`);
  }
  if (results.some((r) => r.error)) process.exitCode = 1;
} else if (command === "recycle-apps") {
  const slugs = args.filter((a) => a !== "--force");
  const results = await recycleApps({ only: slugs.length ? slugs : undefined, force: args.includes("--force") });
  for (const r of results) {
    console.log(r.error ? `${r.app}: FAILED after ${r.ms} ms: ${r.error}` : `${r.app}: auth ${r.auth}, rest ${r.rest} (${r.ms} ms)`);
  }
  console.log(`${results.filter((r) => !r.error).length}/${results.length} apps recycled`);
  if (results.some((r) => r.error)) process.exitCode = 1;
} else if (command === "verify") {
  const report = await verifyPlatform();
  if (args.includes("--json")) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`platform ${report.version}: ${report.ok ? "OK" : "FAILED"}`);
    for (const c of report.shared) console.log(`  ${c.ok ? "ok  " : "FAIL"} ${c.name} (${c.detail})`);
    for (const a of report.apps) {
      const failed = a.checks.filter((c) => !c.ok);
      const lints = a.lints ? `, lints: ${a.lints.unaccepted_errors} errors, ${a.lints.warnings} warnings` : "";
      console.log(`  ${a.ok ? "ok  " : "FAIL"} ${a.app} (${a.status}${lints})${failed.length ? ": " + failed.map((c) => `${c.name} ${c.detail}`).join("; ") : ""}`);
    }
  }
  if (!report.ok) process.exitCode = 1;
} else if (command === "version") {
  console.log(JSON.stringify(await platformVersion(), null, 2));
} else {
  console.error(USAGE);
  process.exitCode = 1;
}
await platform.end();
// provision() (start-app, restore-app) starts the app's schema relay (pgrst-relay.ts), a LISTEN connection meant for the
// server process: the CLI must not keep it, nor wait for it
process.exit();
