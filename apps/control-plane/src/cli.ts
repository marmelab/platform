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
import { setPassword } from "./sessions.ts";
import { getSettings, setSetting, SMTP_KEYS, smtpSummary, SSO_PROVIDER_KEYS, ssoSummary, unsetSetting } from "./settings.ts";
import { syncCompanySso } from "./app-sso.ts";

const USAGE = "usage: cli.ts init | create-user <email> [admin|developer] [token-name] | delete-user <email> | " +
  "set-password <email> [--generate] | add-member <slug> <email> [owner|collaborator] | remove-member <slug> <email> | stop-app <slug> | start-app <slug> | delete-app <slug> [--no-backup] | " +
  "settings | set-setting <key> <value> | unset-setting <key> | sync-auth | sample-metrics | realtime-migrate <slug>|--all";

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
  const settings = await getSettings();
  console.log(JSON.stringify({
    ...settings,
    oidcJwks: settings.oidcJwks ? "(inline JWKS set: test only)" : null,
    smtp: smtpSummary(settings.smtp),
    sso: ssoSummary(settings.sso),
  }, null, 2));
} else if (command === "set-setting" && args[0] && args[1] !== undefined) {
  const secret = args[0] === "smtp_password" || args[0] === "sso_client_secret";
  const value = secret && args[1] === "-" ? (await text(process.stdin)).trim() : args[1];
  await setSetting(args[0], value);
  console.log(`${args[0]} set`);
  if (SMTP_KEYS.includes(args[0])) await syncAuth();
  if (SSO_PROVIDER_KEYS.includes(args[0])) console.log(JSON.stringify(await syncCompanySso()));
} else if (command === "unset-setting" && args[0]) {
  await unsetSetting(args[0]);
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
} else {
  console.error(USAGE);
  process.exitCode = 1;
}
await platform.end();
