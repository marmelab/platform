// M7, journey A4: backups and restore, against the running "plat" stack (local install with the s3-test and mail
// profiles). One disposable app with data in every place a backup covers: database rows and an auth user, a Storage
// file, a live frontend and functions version, a function secret. Then:
// - manual backup on the local volume, rights (owner, collaborator), restore into the same app through the admin API
//   (pre_restore backup first): data, file, frontend, function and secret come back, the user's session still works;
// - backup to the S3 target (the stack's SeaweedFS), restore from S3 with the CLI;
// - retention with a simulated clock (prune-backups --now) and small limits, on the volume and on S3;
// - failure path: an unreachable S3 target, recorded, audited, on the dashboard and emailed to the admins (Mailpit);
// - delete with the final backup on S3, then the deleted app recreated from it (same slug, keys and data).
// The backup settings are restored at the end of the run (TT-5).
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as tar from "tar";
import { AwsV4Signer } from "aws4fetch";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createClient } from "@supabase/supabase-js";
import { cleanup, cli, psql, runId, waitForControlPlane } from "./disposable.ts";
import { deleteMails, waitForMail } from "./mailpit.ts";

const ROOT = new URL("../../../", import.meta.url);
const readEnv = (file: string) => Object.fromEntries(
  readFileSync(new URL(file, ROOT), "utf8").split("\n").filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const env = readEnv("deploy/.env.local");
const stackEnv = readEnv("deploy/.env");
const MCP_URL = env.PLATFORM_URL ?? "http://api.localhost:8100/mcp";
const ADMIN_API = "http://admin.localhost:8100/api";
const RUN = runId();
const APP = `e2e-${RUN}-bk`;
const APP_URL = `http://${APP}.localhost:8100`;
const OWNER = `e2e-${RUN}-bk-owner@example.com`;
const COLLAB = `e2e-${RUN}-bk-collab@example.com`;
const USER_EMAIL = `bk-user-${RUN}@example.com`;
/** The test S3 store of the stack (compose service s3): http://s3:8333 from the control plane. */
const S3 = { local: "http://localhost:8333", internal: "http://s3:8333", accessKeyId: "platform-test", secretAccessKey: stackEnv.S3_TEST_SECRET_KEY ?? "" };
const BUCKET = `e2e-${RUN}`;
const PREFIX = "platform/backups";
const work = mkdtempSync(join(tmpdir(), "plat-bk-"));
const BACKUP_KEYS = [
  "backup_enabled", "backup_hour", "backup_keep_daily", "backup_keep_weekly", "backup_manual_retention_days",
  "backup_final_retention_days", "backup_s3_endpoint", "backup_s3_bucket", "backup_s3_region", "backup_s3_access_key_id",
  "backup_s3_secret_access_key", "backup_s3_prefix", "backup_s3_path_style",
];

async function connect(token: string) {
  const client = new Client({ name: "backups-e2e", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(MCP_URL), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }));
  return client;
}

type ToolResult = { isError?: boolean; content: { text: string }[] };
async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const result = (await client.callTool({ name, arguments: args })) as ToolResult;
  if (result.isError) throw new Error(`${name} failed: ${result.content[0]?.text}`);
  return JSON.parse(result.content[0]!.text);
}
async function refused(client: Client, name: string, args: Record<string, unknown>, pattern: RegExp) {
  const result = (await client.callTool({ name, arguments: args })) as ToolResult;
  assert.ok(result.isError, `${name} should be refused`);
  assert.match(result.content[0]!.text, pattern);
}

/** Admin REST API with the admin's PAT. */
async function adminApi(method: string, path: string, body?: unknown) {
  const response = await fetch(`${ADMIN_API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${env.PLATFORM_TOKEN}`,
      "x-platform-admin": "1",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

/** S3 request on the test store, signed like the control plane's. */
async function s3(method: string, path: string, query = "") {
  const signed = await new AwsV4Signer({
    url: `${S3.local}${path}${query}`,
    method,
    accessKeyId: S3.accessKeyId,
    secretAccessKey: S3.secretAccessKey,
    service: "s3",
    region: "us-east-1",
  }).sign();
  const response = await fetch(signed.url, { method, headers: signed.headers });
  return { status: response.status, text: await response.text() };
}
const s3Keys = async (prefix: string) => {
  const { status, text } = await s3("GET", `/${BUCKET}`, `?list-type=2&prefix=${encodeURIComponent(prefix)}`);
  assert.equal(status, 200, text);
  return [...text.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]!).sort();
};

async function pack(cwd: string, entries: string[]) {
  const file = join(work, `bundle-${Math.random().toString(36).slice(2)}.tgz`);
  await tar.c({ gzip: true, cwd, file, portable: true }, entries);
  return new Blob([readFileSync(file)]);
}

async function deploy(client: Client, kind: "frontend" | "functions", archive: Blob) {
  const created = await call(client, "create_deployment", { app: APP, kind });
  const upload = await fetch(created.upload_url, { method: "PUT", body: archive });
  assert.equal(upload.status, 200, await upload.text());
  return call(client, "finalize_deployment", { deployment_id: created.deployment_id });
}

function site(label: string) {
  const dir = join(work, `site-${label}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.html"), `<!doctype html><title>bk</title><h1>Site ${label}</h1>\n`);
  return pack(dir, ["."]);
}

/** Function "info": its version label and the MY_SECRET secret. */
function functions(label: string) {
  const dir = join(work, `fn-${label}`);
  mkdirSync(join(dir, "supabase/functions/info"), { recursive: true });
  writeFileSync(join(dir, "supabase/functions/info/index.ts"),
    `Deno.serve(() => Response.json({ version: ${JSON.stringify(label)}, secret: Deno.env.get("MY_SECRET") ?? null }));\n`);
  writeFileSync(join(dir, "supabase/config.toml"), "[functions.info]\nverify_jwt = false\n");
  return pack(dir, ["supabase"]);
}

const page = async () => (await fetch(`${APP_URL}/`)).text();
const info = async () => {
  const response = await fetch(`${APP_URL}/functions/v1/info`);
  assert.equal(response.status, 200);
  return response.json() as Promise<{ version: string; secret: string | null }>;
};
const notes = () => psql("select coalesce(string_agg(body, ',' order by id), '') from public.notes", `app_${APP.replaceAll("-", "_")}`);

const MIGRATION = {
  version: "20260301000001",
  name: "notes_and_files",
  sql: `
create table public.notes (id bigint generated always as identity primary key, body text not null);
alter table public.notes enable row level security;
create policy "read notes" on public.notes for select to authenticated using (true);
insert into public.notes (body) values ('alpha'), ('beta');
insert into storage.buckets (id, name, public) values ('files', 'files', false);
create policy "own files read" on storage.objects for select to authenticated
  using (bucket_id = 'files' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "own files write" on storage.objects for insert to authenticated
  with check (bucket_id = 'files' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "own files delete" on storage.objects for delete to authenticated
  using (bucket_id = 'files' and (storage.foldername(name))[1] = auth.uid()::text);
`,
};
const FILE_CONTENT = `backed up file ${RUN}\n`;

function setS3(endpoint = S3.internal) {
  cli(["set-setting", "backup_s3_endpoint", endpoint]);
  cli(["set-setting", "backup_s3_bucket", BUCKET]);
  cli(["set-setting", "backup_s3_access_key_id", S3.accessKeyId]);
  cli(["set-setting", "backup_s3_secret_access_key", "-"], S3.secretAccessKey);
  cli(["set-setting", "backup_s3_prefix", PREFIX]);
}
const unsetS3 = () => {
  for (const key of BACKUP_KEYS.filter((k) => k.startsWith("backup_s3_"))) cli(["unset-setting", key]);
  // an S3 target in the environment would still apply: the empty endpoint row turns it off
  cli(["set-setting", "backup_s3_endpoint", ""]);
};

describe("M7: backups and restore", () => {
  let admin: Client;
  let owner: Client;
  let collab: Client;
  let anonKey: string;
  let session: { access_token: string; user: { id: string } };
  let saved = "";
  let localBackup: any;
  let s3Backup: any;
  const filePath = () => `${session.user.id}/hello.txt`;
  const userClient = () => createClient(APP_URL, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${session.access_token}` } },
  });
  const download = async () => {
    const { data, error } = await userClient().storage.from("files").download(filePath());
    return error ? `error: ${error.message}` : await data.text();
  };
  /** Storage serves the content type kept in the file's extended attributes. */
  const contentType = async () => {
    const response = await fetch(`${APP_URL}/storage/v1/object/authenticated/files/${filePath()}`, {
      headers: { apikey: anonKey, authorization: `Bearer ${session.access_token}` },
    });
    await response.body?.cancel();
    assert.equal(response.status, 200);
    return response.headers.get("content-type");
  };

  before(async () => {
    assert.ok(S3.secretAccessKey, "S3_TEST_SECRET_KEY missing from deploy/.env: run deploy/install.sh (profile s3-test)");
    await waitForControlPlane(MCP_URL);
    saved = psql(`select coalesce(json_agg(json_build_object('key', key, 'value', value)), '[]') from settings
      where key like 'backup\\_%'`);
    for (const key of BACKUP_KEYS) cli(["unset-setting", key]);
    unsetS3();
    assert.equal((await s3("PUT", `/${BUCKET}`)).status, 200, "test bucket created");
    admin = await connect(env.PLATFORM_TOKEN);
    owner = await connect(cli(["create-user", OWNER, "developer"]).trim());
    collab = await connect(cli(["create-user", COLLAB, "developer"]).trim());
  });

  after(async () => {
    for (const client of [admin, owner, collab]) await client?.close();
    // settings first: an app deleted below must not leave a final backup on the test bucket
    psql(`delete from settings where key like 'backup\\_%'`);
    psql(`insert into settings (key, value) select r->>'key', r->>'value' from json_array_elements('${saved.replaceAll("'", "''")}'::json) r`);
    await cleanup([APP], [OWNER, COLLAB]);
    for (const key of await s3Keys("").catch(() => [])) await s3("DELETE", `/${BUCKET}/${key}`);
    await s3("DELETE", `/${BUCKET}`);
  });

  test("1. an app with data everywhere: rows, auth user, Storage file, frontend, function, secret", async () => {
    const app = await call(admin, "create_app", { name: "Backup demo", slug: APP });
    anonKey = app.anon_key;
    await call(admin, "add_member", { app: APP, email: OWNER, role: "owner" });
    await call(admin, "add_member", { app: APP, email: COLLAB });
    await call(admin, "configure_auth", { app: APP, email_confirmation: false });
    await call(admin, "apply_migrations", { app: APP, migrations: [MIGRATION] });
    const { data, error } = await createClient(APP_URL, anonKey, { auth: { persistSession: false } })
      .auth.signUp({ email: USER_EMAIL, password: "password-123" });
    assert.ifError(error);
    session = data.session as typeof session;
    const upload = await userClient().storage.from("files").upload(filePath(), new Blob([FILE_CONTENT], { type: "text/plain" }));
    assert.ifError(upload.error);
    await deploy(admin, "frontend", await site("v1"));
    await call(admin, "set_secrets", { app: APP, secrets: { MY_SECRET: "before" } });
    await deploy(admin, "functions", await functions("fn1"));
    assert.equal(notes(), "alpha,beta");
    assert.equal(await download(), FILE_CONTENT);
    assert.match(await page(), /Site v1/);
    assert.deepEqual(await info(), { version: "fn1", secret: "before" });
    assert.match(await contentType() ?? "", /^text\/plain/);
  });

  test("2. manual backup on the volume: owners and admins only, listed, audited", async () => {
    await refused(collab, "create_backup", { app: APP }, /only an owner/);
    await refused(collab, "list_backups", { app: APP }, /only an owner/);
    localBackup = await call(owner, "create_backup", { app: APP });
    assert.equal(localBackup.kind, "manual");
    assert.equal(localBackup.status, "succeeded");
    assert.equal(localBackup.target, "local");
    assert.match(localBackup.location, new RegExp(`^/data/backups/${APP}-\\d{4}-`));
    assert.deepEqual(Object.keys(localBackup.files).sort(),
      ["database.dump", "functions.tar.gz", "manifest.json", "secrets.enc", "sites.tar.gz", "storage-xattrs.json", "storage.tar.gz"]);
    assert.deepEqual(localBackup.versions, { frontend: 1, functions: 1 });
    const listed = await call(owner, "list_backups", { app: APP });
    assert.equal(listed[0].id, localBackup.id);
    assert.equal(psql(`select count(*) from audit_log where action = 'create_backup' and details->>'backup_id' = '${localBackup.id}'`), "1");
    // the secrets never appear in clear in the backup
    const secrets = execFileSync("docker", ["exec", "plat-control-plane", "cat", `${localBackup.location}/secrets.enc`], { encoding: "utf8" });
    assert.doesNotMatch(secrets, /before|jwt_secret/);
  });

  test("3. restore into the same app (admin API): data, file, frontend, function and secret come back", async () => {
    // everything changes after the backup
    psql("delete from public.notes; insert into public.notes (body) values ('gamma')", `app_${APP.replaceAll("-", "_")}`);
    assert.ifError((await userClient().storage.from("files").remove([filePath()])).error);
    await deploy(admin, "frontend", await site("v2"));
    await call(admin, "set_secrets", { app: APP, secrets: { MY_SECRET: "after", OTHER: "x" } });
    await deploy(admin, "functions", await functions("fn2"));
    assert.equal(notes(), "gamma");
    assert.match(await download(), /^error/);
    assert.deepEqual(await info(), { version: "fn2", secret: "after" });

    const wrong = await adminApi("POST", `/backups/${localBackup.id}/restore`, { confirm: "nope" });
    assert.equal(wrong.status, 400);
    assert.match(wrong.body.message, new RegExp(`pass confirm="${APP}"`));
    const restored = await adminApi("POST", `/backups/${localBackup.id}/restore`, { confirm: APP });
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
    assert.equal(restored.body.mode, "same_app");
    assert.equal(restored.body.status, "running");
    assert.deepEqual(restored.body.versions, { frontend: 1, functions: 1 });
    assert.ok(restored.body.pre_restore_backup, "a pre_restore backup was taken");

    assert.equal(notes(), "alpha,beta");
    // the same JWT secret: the user's session from before the restore still works
    assert.equal(await download(), FILE_CONTENT);
    assert.equal(restored.body.storage_files, 1);
    assert.ok(restored.body.storage_attributes >= 1, "the files' extended attributes are put back");
    assert.match(await contentType() ?? "", /^text\/plain/);
    assert.match(await page(), /Site v1/);
    assert.deepEqual(await info(), { version: "fn1", secret: "before" });
    assert.deepEqual((await call(admin, "list_secrets", { app: APP })).map((s: { name: string }) => s.name), ["MY_SECRET"]);
    const app = await call(owner, "get_app", { app: APP });
    assert.equal(app.anon_key, anonKey);
    assert.equal(app.frontend_version, 1);
    assert.equal(app.functions_version, 1);
    // the restore's own DDL is not recorded as schema changes outside a release
    assert.equal((await call(owner, "get_app", { app: APP })).schema_drift?.count ?? 0, 0);
    const pre = (await call(owner, "list_backups", { app: APP })).find((b: any) => b.id === restored.body.pre_restore_backup);
    assert.equal(pre.kind, "pre_restore");
    assert.equal(psql(`select details->>'backup_id' from audit_log where action = 'restore_app' and details->>'slug' = '${APP}'`),
      localBackup.id);
    // the version written after the backup is still deployable: no clash of version numbers
    assert.equal((await deploy(admin, "frontend", await site("v3"))).version, 3);
    assert.match(await page(), /Site v3/);
  });

  test("4. backup to S3 and restore from S3 (CLI)", async () => {
    setS3();
    s3Backup = await call(owner, "create_backup", { app: APP });
    assert.equal(s3Backup.status, "succeeded");
    assert.equal(s3Backup.target, "s3");
    const name = s3Backup.location.replace(/\/$/, "").split("/").pop();
    assert.equal(s3Backup.location, `s3://${BUCKET}/${PREFIX}/${name}/`);
    assert.deepEqual(await s3Keys(`${PREFIX}/${name}/`), Object.keys(s3Backup.files).map((f) => `${PREFIX}/${name}/${f}`).sort());
    // the volume is only the staging area
    assert.equal(execFileSync("docker", ["exec", "plat-control-plane", "sh", "-c", `ls -d /data/backups/${name} 2>/dev/null || true`],
      { encoding: "utf8" }).trim(), "");

    psql("delete from public.notes", `app_${APP.replaceAll("-", "_")}`);
    await call(admin, "set_secrets", { app: APP, secrets: { MY_SECRET: "changed" } });
    const out = JSON.parse(cli(["restore-app", s3Backup.id, "--confirm", APP, "--no-safety-backup"]));
    assert.equal(out.mode, "same_app");
    assert.equal(out.pre_restore_backup, null);
    assert.equal(notes(), "alpha,beta");
    assert.match(await page(), /Site v3/);
    assert.deepEqual(await info(), { version: "fn1", secret: "before" });
    assert.equal(await download(), FILE_CONTENT);
  });

  test("5. retention: N daily + M weekly scheduled, manual by age, on the volume and on S3 (simulated clock)", async () => {
    // three scheduled backups on S3, dated Tue 1 and Wed 2 September (same ISO week) and Wed 9 September; each is
    // backdated before the next run (whose own retention would prune two backups of the same day)
    const dates = ["2026-09-01T03:00:00Z", "2026-09-02T03:00:00Z", "2026-09-09T03:00:00Z"];
    const scheduled: string[] = [];
    for (const date of dates) {
      const run = JSON.parse(cli(["run-backups", APP]));
      assert.deepEqual(run.failed, []);
      const id = psql(`select id from backups where slug = '${APP}' and kind = 'scheduled' and id <> all('{${scheduled.join(",")}}'::uuid[])`);
      psql(`update backups set started_at = '${date}' where id = '${id}'`);
      scheduled.push(id);
    }
    // the manual backup on the volume (test 2): 40 days old; the S3 one (test 4) and the pre_restore one: 5 days
    psql(`update backups set started_at = '2026-08-01T00:00:00Z' where id = '${localBackup.id}'`);
    psql(`update backups set started_at = '2026-09-05T00:00:00Z' where slug = '${APP}' and kind in ('manual', 'pre_restore') and id <> '${localBackup.id}'`);
    cli(["set-setting", "backup_keep_daily", "1"]);
    cli(["set-setting", "backup_keep_weekly", "2"]);
    cli(["set-setting", "backup_manual_retention_days", "30"]);
    const s3Objects = async (id: string) => {
      const location = psql(`select location from backups where id = '${id}'`);
      return location ? s3Keys(location.replace(`s3://${BUCKET}/`, "")) : [];
    };
    const firstObjects = await s3Objects(scheduled[0]!);
    assert.ok(firstObjects.length >= 5);

    const result = JSON.parse(cli(["prune-backups", "--now", "2026-09-10T03:00:00Z"]));
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.ids.filter((id: string) => [...scheduled, localBackup.id].includes(id)).sort(),
      [scheduled[0], localBackup.id].sort());
    // newest of the last day (9 Sep) and newest of each of the last 2 weeks (9 Sep, 2 Sep) kept
    assert.equal(psql(`select count(*) from backups where id in ('${scheduled[1]}', '${scheduled[2]}', '${s3Backup.id}')`), "3");
    assert.equal(psql(`select count(*) from backups where id in ('${scheduled[0]}', '${localBackup.id}')`), "0");
    for (const key of firstObjects) assert.ok(!(await s3Keys(key)).length, `${key} deleted from S3`);
    assert.ok((await s3Objects(scheduled[1]!)).length >= 5, "kept backups stay on S3");
    assert.equal(execFileSync("docker", ["exec", "plat-control-plane", "sh", "-c", `ls -d ${localBackup.location} 2>/dev/null || true`],
      { encoding: "utf8" }).trim(), "", "the expired local backup is deleted from the volume");
    assert.equal(psql("select count(*) from audit_log where action = 'prune_backups' and created_at > now() - interval '1 minute'"), "1");
    for (const key of ["backup_keep_daily", "backup_keep_weekly", "backup_manual_retention_days"]) cli(["unset-setting", key]);
  });

  test("6. failure path: S3 unreachable, recorded, audited, on the dashboard, emailed to the admins", async () => {
    await deleteMails('subject:"Backups failed"');
    const onVolume = () => execFileSync("docker", ["exec", "plat-control-plane", "sh", "-c", `ls -d /data/backups/${APP}-* 2>/dev/null || true`],
      { encoding: "utf8" }).trim();
    // the run's retention uses the real clock: test 5 dated the pre_restore backup (on the volume) 2026-09-05
    cli(["set-setting", "backup_manual_retention_days", "3650"]);
    const before = onVolume();
    const dailyRun = () => psql("select concat_ws('|', run_started_at, run_finished_at, run_summary) from backup_state where id = 1");
    const dailyRunBefore = dailyRun();
    setS3("http://s3-unreachable.invalid:8333");
    let failedRun: any;
    try {
      cli(["run-backups", APP]);
      assert.fail("run-backups should exit with an error");
    } catch (error) {
      failedRun = JSON.parse(String((error as { stdout?: string }).stdout));
    } finally {
      cli(["unset-setting", "backup_manual_retention_days"]);
    }
    assert.equal(failedRun.failed.length, 1);
    assert.equal(failedRun.failed[0].app, APP);
    assert.match(failedRun.failed[0].error, /upload to S3 failed/);
    assert.equal(failedRun.admins_notified, true);
    const row = psql(`select concat_ws('|', status, location is null, error) from backups where id = '${failedRun.failed[0].backup_id}'`);
    assert.match(row, /^failed\|t\|upload to S3 failed/);
    assert.equal(onVolume(), before, "nothing left on the volume");
    assert.equal(dailyRun(), dailyRunBefore, "a run limited to one app is not the daily run (admin console)");
    assert.equal(psql(`select count(*) from audit_log l join apps a on a.id = l.app_id where a.slug = '${APP}' and l.action = 'backup_failed'`), "1");

    const mail = await waitForMail(`to:"${env.PLATFORM_ADMIN_EMAIL}" subject:"Backups failed"`);
    assert.match(mail.Text, new RegExp(`- ${APP}: .*upload to S3 failed`));
    const dashboard = await adminApi("GET", "/dashboard");
    assert.ok(dashboard.body.backups.failed_7d >= 1);
    assert.ok(dashboard.body.recent_failures.some((f: any) => f.app === APP && f.kind === "backup scheduled"));
    const list = await adminApi("GET", `/backups?filter=${encodeURIComponent(JSON.stringify({ app: APP, status: "failed" }))}`);
    assert.equal(list.status, 200);
    assert.equal(list.body.length, 1);
  });

  test("7. delete with a final backup on S3, then the deleted app recreated from it", async () => {
    setS3();
    const created = (await adminApi("GET", `/apps/${APP}`)).body.created_at;
    const deleted = await call(owner, "delete_app", { app: APP, confirm: APP });
    assert.match(deleted.backup, new RegExp(`^s3://${BUCKET}/${PREFIX}/${APP}-`));
    await refused(admin, "get_app", { app: APP }, /not found/);
    const final = await adminApi("GET", `/backups/${deleted.backup_id}`);
    assert.equal(final.body.kind, "final");
    assert.equal(final.body.app_deleted, true);

    const restored = await adminApi("POST", `/backups/${deleted.backup_id}/restore`, { confirm: APP });
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
    assert.equal(restored.body.mode, "deleted_app");
    const record = (await adminApi("GET", `/apps/${APP}`)).body;
    assert.equal(record.created_at, created, "the original creation date");
    assert.ok(record.restored_at > created, "and the restore");
    const app = await call(owner, "get_app", { app: APP });
    assert.equal(app.status, "running");
    assert.equal(app.anon_key, anonKey, "the same keys: the deployed frontend keeps working");
    assert.equal(app.role, "owner", "the backed-up owner is an owner again");
    assert.deepEqual((await call(owner, "list_members", { app: APP })).map((m: any) => `${m.email}:${m.role}`).sort(),
      [`${env.PLATFORM_ADMIN_EMAIL}:owner`, `${COLLAB}:collaborator`, `${OWNER}:owner`]);
    assert.equal(notes(), "alpha,beta");
    assert.equal(await download(), FILE_CONTENT);
    assert.match(await contentType() ?? "", /^text\/plain/);
    assert.match(await page(), /Site v3/);
    assert.deepEqual(await info(), { version: "fn1", secret: "before" });
    // the backups of the deleted app belong to the restored app again
    assert.ok((await call(owner, "list_backups", { app: APP })).some((b: any) => b.id === deleted.backup_id));
    // a new deployment continues the version numbers
    assert.equal((await deploy(admin, "functions", await functions("fn4"))).version, 2);
    assert.equal((await info()).version, "fn4");
  });
});
