// End-to-end test of the M2 control plane against the running "plat" stack (deploy/install.sh).
// Uses a real MCP client with the admin PAT stored in deploy/.env.local, on a disposable app deleted at the end of the run.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createClient } from "@supabase/supabase-js";
import * as tar from "tar";
import { cleanup, cli, psql, runId } from "./disposable.ts";

const ROOT = new URL("../../../", import.meta.url);
const env = Object.fromEntries(
  readFileSync(new URL("deploy/.env.local", ROOT), "utf8")
    .split("\n")
    .filter((line) => line.includes("="))
    .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
);
const MCP_URL = env.PLATFORM_URL ?? "http://api.localhost:8100/mcp";
const ADMIN_EMAIL = env.PLATFORM_ADMIN_EMAIL ?? "admin@example.com";
const APP = `e2e-${runId()}`;
const APP_URL = `http://${APP}.localhost:8100`;
/** Deleted with backup: false (test 13). */
const NO_BACKUP_APP = `${APP}-nb`;
const RUN = Date.now();
const OUTSIDER = `${APP}-outsider@example.com`;
const OWNER = `${APP}-owner@example.com`;
const COLLAB = `${APP}-collab@example.com`;
const NPM_CACHE = "/deno-cache/npm/registry.npmjs.org";
const work = mkdtempSync(join(tmpdir(), "plat-e2e-"));

async function connect(token: string) {
  const client = new Client({ name: "e2e", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(MCP_URL), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}

type ToolResult = { isError?: boolean; content: { type: string; text: string }[] };

async function callRaw(client: Client, name: string, args: Record<string, unknown> = {}) {
  return (await client.callTool({ name, arguments: args })) as ToolResult;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const result = await callRaw(client, name, args);
  const text = result.content[0]?.text ?? "";
  if (result.isError) throw new Error(`${name} failed: ${text}`);
  return JSON.parse(text);
}

async function pack(cwd: string, entries: string[]) {
  const file = join(work, `bundle-${Math.random().toString(36).slice(2)}.tgz`);
  await tar.c({ gzip: true, cwd, file, portable: true }, entries);
  return new Blob([readFileSync(file)]);
}

async function deploy(client: Client, kind: "frontend" | "functions", archive: Blob) {
  const created = await call(client, "create_deployment", { app: APP, kind });
  const upload = await fetch(created.upload_url, { method: "PUT", body: archive });
  assert.equal(upload.status, 200, await upload.clone().text());
  const reuse = await fetch(created.upload_url, { method: "PUT", body: archive });
  assert.equal(reuse.status, 404, "upload URL must be single use");
  return { created, finalized: await call(client, "finalize_deployment", { deployment_id: created.deployment_id }) };
}

function writeSite(label: string) {
  const dir = join(work, `dist-${label}`);
  mkdirSync(join(dir, "assets"), { recursive: true });
  writeFileSync(join(dir, "index.html"), `<!doctype html><title>demo</title><h1>Demo ${label}</h1>\n`);
  writeFileSync(join(dir, "assets", `app-${label}.js`), `console.log(${JSON.stringify(label)});\n`);
  return dir;
}

const getPage = async (path = "/") => {
  const response = await fetch(`${APP_URL}${path}`);
  return { status: response.status, text: await response.text(), headers: response.headers };
};

const sqlLiteral = (value: string) => `'${value.replaceAll("'", "''")}'`;

describe("control plane M2 e2e", () => {
  let admin: Client;
  let owner: Client;
  let collab: Client;
  let app: any;

  before(async () => {
    admin = await connect(env.PLATFORM_TOKEN);
  });

  after(async () => {
    for (const client of [admin, owner, collab]) await client?.close();
    await cleanup([APP, NO_BACKUP_APP], [OUTSIDER, OWNER, COLLAB]);
  });

  test("1. whoami", async () => {
    const me = await call(admin, "whoami");
    assert.equal(me.email, ADMIN_EMAIL);
    assert.equal(me.role, "admin");
    assert.equal(me.direct_deploy, true, "admins always deploy directly");
    assert.match(me.direct_deploy_setting, /^(admins|everyone)$/);
    const tools = (await admin.listTools()).tools.map((t) => t.name).sort();
    for (const name of ["apply_migrations", "create_app", "create_deployment", "execute_sql", "finalize_deployment",
      "get_app", "get_logs", "list_apps", "list_deployments", "list_members", "list_secrets", "rollback", "set_secrets",
      "add_member", "remove_member", "stop_app", "start_app", "delete_app", "list_schema_changes", "whoami"]) {
      assert.ok(tools.includes(name), `tool ${name} missing`);
    }
  });

  test("2. create_app (idempotent)", async () => {
    app = await call(admin, "create_app", { name: "Demo", slug: APP });
    assert.equal(app.slug, APP);
    assert.equal(app.url, APP_URL);
    assert.equal(app.status, "running");
    assert.match(app.anon_key, /^eyJ/);
    assert.ok(!JSON.stringify(app).includes("service_role_key"));
    const again = await call(admin, "create_app", { name: "Demo", slug: APP });
    assert.equal(again.anon_key, app.anon_key);
    const fetched = await call(admin, "get_app", { app: APP });
    assert.equal(fetched.anon_key, app.anon_key);
    const health = await fetch(`${APP_URL}/auth/v1/health`, { headers: { apikey: app.anon_key } });
    assert.equal(health.status, 200);
  });

  async function rejected(args: Record<string, unknown>) {
    const result = await callRaw(admin, "apply_migrations", args);
    assert.equal(result.isError, true, result.content[0]?.text);
    const body = JSON.parse(result.content[0].text);
    assert.equal(body.status, "rejected");
    assert.deepEqual(body.applied, []);
    return body;
  }

  async function relationExists(name: string) {
    const result = await call(admin, "execute_sql", { app: APP, sql: `select to_regclass(${sqlLiteral(name)}) as r` });
    return result.rows[0].r !== null;
  }

  async function migrationRecorded(version: string) {
    const result = await call(admin, "execute_sql", {
      app: APP,
      sql: `select 1 from supabase_migrations.schema_migrations where version = ${sqlLiteral(version)}`,
    });
    return result.row_count === 1;
  }

  test("3. apply_migrations: todos + RLS, idempotence, linter in the transaction", async () => {
    const todos = {
      version: "20260101000001",
      name: "create_todos",
      sql: readFileSync(new URL("test/fixtures/todos.sql", new URL("../", import.meta.url)), "utf8"),
    };
    const first = await call(admin, "apply_migrations", { app: APP, migrations: [todos] });
    assert.deepEqual([...first.applied, ...first.skipped], [todos.version]);
    assert.ok(!first.lints.some((l: { object: string; level: string }) => l.object === "public.todos" && l.level === "ERROR"));

    const second = await call(admin, "apply_migrations", { app: APP, migrations: [todos] });
    assert.deepEqual(second.applied, []);
    assert.deepEqual(second.skipped, [todos.version]);

    // a public table without RLS is rejected: nothing committed
    const unsafe = { version: `${RUN}1`, name: "lint_probe", sql: "create table public.lint_probe (id int primary key);" };
    const third = await rejected({ app: APP, migrations: [todos, unsafe] });
    assert.deepEqual(third.would_apply, [unsafe.version]);
    const alert = third.blocking_lints.find((l: { name: string; object: string }) =>
      l.name === "rls_disabled_in_public" && l.object === "public.lint_probe"
    );
    assert.ok(alert, `linter should flag lint_probe: ${JSON.stringify(third)}`);
    assert.equal(alert.level, "ERROR");
    assert.equal(await relationExists("public.lint_probe"), false);
    assert.equal(await migrationRecorded(unsafe.version), false);

    // a security definer view bypasses RLS: rejected, then dry run, then accepted
    const view = {
      version: `${RUN}5`,
      name: "todo_titles",
      sql: "create view public.todo_titles as select title from public.todos;",
    };
    const definer = await rejected({ app: APP, migrations: [todos, view] });
    assert.ok(
      definer.blocking_lints.some((l: { name: string; object: string }) =>
        l.name === "security_definer_view" && l.object === "public.todo_titles"
      ),
      JSON.stringify(definer),
    );
    assert.equal(await relationExists("public.todo_titles"), false);
    assert.equal(await migrationRecorded(view.version), false);

    const dry = await call(admin, "apply_migrations", { app: APP, migrations: [todos, view], dry_run: true });
    assert.equal(dry.status, "dry_run");
    assert.deepEqual(dry.applied, []);
    assert.deepEqual(dry.would_apply, [view.version]);
    assert.deepEqual(dry.skipped, [todos.version]);
    assert.equal(dry.blocking_lints[0]?.name, "security_definer_view");
    assert.equal(await relationExists("public.todo_titles"), false);
    assert.equal(await migrationRecorded(view.version), false);

    const accepted = await call(admin, "apply_migrations", {
      app: APP,
      migrations: [todos, view],
      accept_lints: [{ name: "security_definer_view", object: "public.todo_titles" }],
    });
    assert.equal(accepted.status, "applied");
    assert.deepEqual(accepted.applied, [view.version]);
    assert.deepEqual(accepted.accepted_lints.map((l: { object: string }) => l.object), ["public.todo_titles"]);
    assert.equal(await relationExists("public.todo_titles"), true);
    assert.equal(await migrationRecorded(view.version), true);
    const audited = psql(
      "select details->'accepted_lints'->0->>'name' from audit_log where action = 'apply_migrations' " +
        "order by created_at desc limit 1",
    );
    assert.equal(audited, "security_definer_view");

    // a failing migration rolls back the whole batch
    const broken = await callRaw(admin, "apply_migrations", {
      app: APP,
      migrations: [
        { version: `${RUN}2`, sql: "create table public.never_created (id int);" },
        { version: `${RUN}3`, sql: "select * from does_not_exist;" },
      ],
    });
    assert.equal(broken.isError, true);
    assert.match(broken.content[0].text, /does_not_exist/);

    const cleanup = await call(admin, "apply_migrations", {
      app: APP,
      migrations: [{ version: `${RUN}4`, name: "drop_todo_titles", sql: "drop view public.todo_titles;" }],
    });
    assert.deepEqual(cleanup.applied, [`${RUN}4`]);
    assert.ok(!cleanup.lints.some((l: { level: string }) => l.level === "ERROR"), JSON.stringify(cleanup.lints));

    const tables = await call(admin, "execute_sql", {
      app: APP,
      sql: "select table_name from information_schema.tables where table_schema = 'public' order by 1",
    });
    assert.deepEqual(tables.rows.map((r: { table_name: string }) => r.table_name), ["todos"]);

    const history = await call(admin, "execute_sql", {
      app: APP,
      sql: "select version from supabase_migrations.schema_migrations where version = '20260101000001'",
    });
    assert.equal(history.row_count, 1);
  });

  test("3b. execute_sql is read-only by default", async () => {
    const write = await callRaw(admin, "execute_sql", { app: APP, sql: "create table public.nope (id int)" });
    assert.equal(write.isError, true);
    assert.match(write.content[0].text, /read-only/);
    const escape = await callRaw(admin, "execute_sql", {
      app: APP,
      sql: "commit; create table public.nope (id int)",
    });
    assert.equal(escape.isError, true);
    const authid = await callRaw(admin, "execute_sql", { app: APP, sql: "select * from pg_catalog.pg_authid" });
    assert.equal(authid.isError, true, "owner role must not read pg_authid");
  });

  test("3c. schema changes outside releases: execute_sql flagged, migrations and GoTrue not", async () => {
    // GoTrue's boot migrations (create_app) and the platform's provisioning are not recorded; the migrations of
    // test 3 are, as part of their release (rejected and dry-run batches were rolled back with their records)
    const clean = await call(admin, "get_app", { app: APP });
    assert.deepEqual({ count: clean.schema_drift.count, last_at: clean.schema_drift.last_at }, { count: 0, last_at: null });
    const recorded = (await call(admin, "list_schema_changes", { app: APP, all: true, limit: 500 })).changes;
    assert.ok(recorded.length > 0, "migrations are recorded");
    for (const change of recorded) {
      assert.equal(change.in_release, true, JSON.stringify(change));
      assert.match(change.release_id, /^[0-9a-f-]{36}$/);
      assert.equal(change.role, `app_${APP.replace(/-/g, "_")}_owner`);
      assert.equal(change.application_name, "platform-migrations");
    }
    assert.ok(recorded.some((c: { object_identity: string }) => c.object_identity === "public.todos"));
    assert.ok(!recorded.some((c: { object_identity: string | null }) => c.object_identity?.startsWith("public.lint_probe")),
      "a rejected batch leaves no record");

    // a schema change through execute_sql (owner role, outside any release) is flagged
    await call(admin, "execute_sql", { app: APP, sql: "create index todos_title_idx on public.todos (title)", write: true });
    const drift = (await call(admin, "get_app", { app: APP })).schema_drift;
    assert.equal(drift.count, 1, JSON.stringify(drift));
    assert.ok(drift.last_at);
    const [outside] = (await call(admin, "list_schema_changes", { app: APP })).changes;
    assert.equal(outside.command_tag, "CREATE INDEX");
    assert.equal(outside.object_identity, "public.todos_title_idx");
    assert.equal(outside.application_name, "platform-execute-sql");
    assert.equal(outside.in_release, false);

    // the owner role cannot switch the recording off nor rewrite it
    for (const sql of [
      "alter event trigger platform_record_ddl disable",
      "drop event trigger platform_record_drop",
      "drop schema _platform cascade",
      "delete from _platform.schema_changes",
      "set session_replication_role = replica",
    ]) {
      const result = await callRaw(admin, "execute_sql", { app: APP, sql, write: true });
      assert.equal(result.isError, true, sql);
      assert.match(result.content[0]!.text, /must be owner|permission denied/, sql);
    }

    // a migration through a release is not flagged, and the count restarts from that release
    const migration = { version: `${RUN}6`, name: "drop_title_index", sql: "drop index public.todos_title_idx;" };
    assert.deepEqual((await call(admin, "apply_migrations", { app: APP, migrations: [migration] })).applied, [migration.version]);
    assert.equal((await call(admin, "get_app", { app: APP })).schema_drift.count, 0);
    const all = (await call(admin, "list_schema_changes", { app: APP, all: true })).changes;
    assert.equal(all[0].command_tag, "DROP INDEX");
    assert.equal(all[0].in_release, true);
    assert.equal(all[1].command_tag, "CREATE INDEX");
    assert.equal(all[1].in_release, false);
  });

  test("4. deploy functions (tar + upload + finalize) and secrets", async () => {
    const secrets = await call(admin, "set_secrets", { app: APP, secrets: { GREETING: `hi-${RUN}` } });
    assert.deepEqual(secrets.map((s: { name: string }) => s.name), ["GREETING"]);
    assert.ok(!JSON.stringify(await call(admin, "list_secrets", { app: APP })).includes(`hi-${RUN}`));
    const reserved = await callRaw(admin, "set_secrets", { app: APP, secrets: { SUPABASE_URL: "x" } });
    assert.equal(reserved.isError, true);

    const project = join(work, "project");
    mkdirSync(join(project, "supabase/functions/hello"), { recursive: true });
    mkdirSync(join(project, "supabase/functions/ping"), { recursive: true });
    writeFileSync(
      join(project, "supabase/functions/hello/index.ts"),
      readFileSync(new URL("fixtures/hello.ts", import.meta.url)),
    );
    writeFileSync(
      join(project, "supabase/functions/ping/index.ts"),
      `Deno.serve(() => Response.json({ pong: true }));\n`,
    );
    mkdirSync(join(project, "supabase/functions/odd"), { recursive: true });
    writeFileSync(
      join(project, "supabase/functions/odd/index.ts"),
      `import isOdd from "npm:is-odd@3.0.1";\nDeno.serve(() => Response.json({ odd: isOdd(3) }));\n`,
    );
    writeFileSync(
      join(project, "supabase/config.toml"),
      `[functions.ping]\nverify_jwt = false\n\n[functions.odd]\nverify_jwt = false\n`,
    );
    // the warm-up before the switch must download npm dependencies into the shared DENO_DIR
    execFileSync("docker", ["exec", "plat-edge", "rm", "-rf", `${NPM_CACHE}/is-odd`]);
    const { finalized } = await deploy(admin, "functions", await pack(project, ["supabase"]));
    assert.equal(finalized.status, "live");
    assert.deepEqual(finalized.functions, {
      hello: { verify_jwt: true },
      odd: { verify_jwt: false },
      ping: { verify_jwt: false },
    });
    assert.deepEqual(Object.keys(finalized.warm).sort(), ["hello", "odd", "ping"]);
    execFileSync("docker", ["exec", "plat-edge", "test", "-d", `${NPM_CACHE}/is-odd/3.0.1`]);
    const started = Date.now();
    const odd = await fetch(`${APP_URL}/functions/v1/odd`);
    assert.deepEqual(await odd.json(), { odd: true });
    assert.ok(Date.now() - started < 1500, `first real call should hit a warm cache (${Date.now() - started} ms)`);

    const ping = await fetch(`${APP_URL}/functions/v1/ping`);
    assert.equal(ping.status, 200);
    assert.deepEqual(await ping.json(), { pong: true });
    const noJwt = await fetch(`${APP_URL}/functions/v1/hello`);
    assert.equal(noJwt.status, 401);
  });

  test("4b. archives with symlinks or .. are rejected", async () => {
    const evil = join(work, "evil");
    mkdirSync(evil, { recursive: true });
    writeFileSync(join(evil, "index.html"), "<h1>evil</h1>");
    symlinkSync("/etc/passwd", join(evil, "passwd"));
    const created = await call(admin, "create_deployment", { app: APP, kind: "frontend" });
    const archive = await pack(evil, ["."]);
    assert.equal((await fetch(created.upload_url, { method: "PUT", body: archive })).status, 200);
    const result = await callRaw(admin, "finalize_deployment", { deployment_id: created.deployment_id });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /SymbolicLink/);

    const outside = join(work, "outside.txt");
    writeFileSync(outside, "escape");
    const created2 = await call(admin, "create_deployment", { app: APP, kind: "frontend" });
    const file = join(work, "dotdot.tgz");
    mkdirSync(join(work, "dist-escape"), { recursive: true });
    await tar.c({ gzip: true, cwd: join(work, "dist-escape"), file, preservePaths: true }, ["../outside.txt"]);
    const put = await fetch(created2.upload_url, { method: "PUT", body: new Blob([readFileSync(file)]) });
    assert.equal(put.status, 200);
    const result2 = await callRaw(admin, "finalize_deployment", { deployment_id: created2.deployment_id });
    assert.equal(result2.isError, true);
    assert.match(result2.content[0].text, /"\.\." is not allowed/);
  });

  test("4c. a function that fails to boot is not published", async () => {
    const previous = await call(admin, "get_app", { app: APP });
    const project = join(work, "project-broken");
    mkdirSync(join(project, "supabase/functions/ping"), { recursive: true });
    mkdirSync(join(project, "supabase/functions/broken"), { recursive: true });
    writeFileSync(join(project, "supabase/functions/ping/index.ts"), `Deno.serve(() => Response.json({ v: "new" }));\n`);
    writeFileSync(
      join(project, "supabase/functions/broken/index.ts"),
      `import { createClient } from "npm:@supabase/supabase-js@2.999.0";\n` +
        `Deno.serve(() => Response.json({ ok: typeof createClient }));\n`,
    );
    writeFileSync(join(project, "supabase/config.toml"), `[functions.ping]\nverify_jwt = false\n`);
    const created = await call(admin, "create_deployment", { app: APP, kind: "functions" });
    const put = await fetch(created.upload_url, { method: "PUT", body: await pack(project, ["supabase"]) });
    assert.equal(put.status, 200);
    const result = await callRaw(admin, "finalize_deployment", { deployment_id: created.deployment_id });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /broken: BOOT_ERROR .*2\.999\.0/);

    const current = await call(admin, "get_app", { app: APP });
    assert.equal(current.functions_version, previous.functions_version, "current must not move");
    const deployments = await call(admin, "list_deployments", { app: APP, kind: "functions" });
    const failed = deployments.find((d: { id: string }) => d.id === created.deployment_id);
    assert.equal(failed.status, "failed");
    assert.match(failed.error, /BOOT_ERROR/);
    const ping = await fetch(`${APP_URL}/functions/v1/ping`);
    assert.equal(ping.status, 200);
    assert.deepEqual(await ping.json(), { pong: true }, "the previous version keeps answering");
  });

  test("4d. the warm-up endpoint is not reachable through the public routes", async () => {
    const adminToken = /^PLATFORM_EDGE_ADMIN_TOKEN=(.*)$/m.exec(readFileSync(new URL("deploy/.env", ROOT), "utf8"))?.[1];
    assert.ok(adminToken);
    for (const path of ["/functions/v1/_internal/warm", "/functions/v1/_internal/metrics"]) {
      const response: Response = await fetch(`${APP_URL}${path}`, {
        method: "POST",
        headers: { "x-platform-admin-token": adminToken, "content-type": "application/json" },
        body: JSON.stringify({ app: APP, version: 1, function: "ping" }),
      });
      assert.equal(response.status, 404, path);
    }
  });

  let v1: number;
  let v2: number;

  test("5. deploy frontend and serve it on <slug>.localhost", async () => {
    const first = await deploy(admin, "frontend", await pack(writeSite("v1"), ["."]));
    v1 = first.finalized.version;
    assert.equal(first.finalized.url, APP_URL);
    let page = await getPage("/");
    assert.equal(page.status, 200);
    assert.match(page.text, /Demo v1/);
    assert.equal(page.headers.get("cache-control"), "no-cache");
    page = await getPage("/some/deep/route");
    assert.match(page.text, /Demo v1/, "SPA fallback");
    const asset = await getPage("/assets/app-v1.js");
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get("cache-control") ?? "", /immutable/);

    const second = await deploy(admin, "frontend", await pack(writeSite("v2"), ["."]));
    v2 = second.finalized.version;
    assert.match((await getPage("/")).text, /Demo v2/);
    assert.equal((await call(admin, "get_app", { app: APP })).frontend_version, v2);
  });

  test("6. supabase-js: signup, insert/select under RLS, function call", async () => {
    const options = { auth: { persistSession: false, autoRefreshToken: false } };
    const alice = createClient(APP_URL, app.anon_key, options);
    const bob = createClient(APP_URL, app.anon_key, options);
    const signup = await alice.auth.signUp({ email: `alice-${RUN}@example.com`, password: "password-123" });
    assert.ifError(signup.error);
    assert.ok(signup.data.session, "autoconfirm gives a session");
    assert.ifError((await bob.auth.signUp({ email: `bob-${RUN}@example.com`, password: "password-123" })).error);

    const title = `buy milk ${RUN}`;
    const inserted = await alice.from("todos").insert({ title }).select().single();
    assert.ifError(inserted.error);
    assert.equal(inserted.data.user_id, signup.data.user!.id);

    const mine = await alice.from("todos").select("title");
    assert.ifError(mine.error);
    assert.deepEqual(mine.data.map((t) => t.title), [title]);
    const theirs = await bob.from("todos").select("title");
    assert.deepEqual(theirs.data, []);
    const anon = await createClient(APP_URL, app.anon_key, options).from("todos").select("title");
    assert.deepEqual(anon.data, []);

    const invoked = await alice.functions.invoke("hello", { body: { name: "alice" } });
    assert.ifError(invoked.error);
    assert.equal(invoked.data.message, "hello alice");
    assert.equal(invoked.data.greeting, `hi-${RUN}`);
    assert.deepEqual(invoked.data.todos, [{ title }], "function reads todos through SUPABASE_URL under RLS");
    assert.equal(invoked.data.has_service_key, true);
  });

  test("7. rollback frontend", async () => {
    const rolled = await call(admin, "rollback", { app: APP, kind: "frontend" });
    assert.deepEqual([rolled.from, rolled.to], [v2, v1]);
    assert.match((await getPage("/")).text, /Demo v1/);
    const deployments = await call(admin, "list_deployments", { app: APP, kind: "frontend" });
    assert.equal(deployments.find((d: { status: string }) => d.status === "live").version, v1);
    // roll forward to an explicit version
    await call(admin, "rollback", { app: APP, kind: "frontend", version: v2 });
    assert.match((await getPage("/")).text, /Demo v2/);
  });

  test("8. get_logs returns app logs", async () => {
    const logs = await call(admin, "get_logs", { app: APP, since_minutes: 30 });
    assert.ok(logs.length > 0);
    const services = new Set(logs.map((l: { service: string }) => l.service));
    assert.ok(services.has("gotrue"), `services: ${[...services]}`);
    const fnLogs = await call(admin, "get_logs", { app: APP, service: "functions", since_minutes: 30 });
    assert.ok(fnLogs.some((l: { line: string }) => l.line.includes('"function":"hello"')), "edge logs filtered by app");
    assert.ok(fnLogs.every((l: { line: string }) => JSON.parse(l.line).app === APP));
  });

  test("9. invalid token rejected, non-member cannot see the app", async () => {
    const bad = await fetch(MCP_URL, {
      method: "POST",
      headers: {
        Authorization: "Bearer plat_invalid",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equal(bad.status, 401);
    await assert.rejects(connect("plat_invalid"));

    const token = cli(["create-user", OUTSIDER, "developer"]).trim();
    const outsider = await connect(token);
    try {
      const me = await call(outsider, "whoami");
      assert.equal(me.role, "developer");
      assert.deepEqual(me.apps, []);
      assert.deepEqual(await call(outsider, "list_apps"), []);
      for (const [name, args] of [
        ["get_app", { app: APP }],
        ["execute_sql", { app: APP, sql: "select 1" }],
        ["create_deployment", { app: APP, kind: "frontend" }],
        ["get_logs", { app: APP }],
        ["create_app", { name: "Demo", slug: APP }],
      ] as const) {
        const result = await callRaw(outsider, name, args);
        assert.equal(result.isError, true, `${name} should fail for a non-member`);
        assert.match(result.content[0].text, /not found|already taken/);
      }
    } finally {
      await outsider.close();
    }
  });

  const refused = async (client: Client, name: string, args: Record<string, unknown>, pattern: RegExp) => {
    const result = await callRaw(client, name, args);
    assert.equal(result.isError, true, `${name} should be refused: ${result.content[0]?.text}`);
    assert.match(result.content[0]!.text, pattern);
  };

  test("10. members: owner, collaborator and admin rights", async () => {
    owner = await connect(cli(["create-user", OWNER, "developer"]).trim());
    collab = await connect(cli(["create-user", COLLAB, "developer"]).trim());
    await refused(admin, "add_member", { app: APP, email: `${APP}-nobody@example.com` }, /an admin must create it/);
    await call(admin, "add_member", { app: APP, email: OWNER, role: "owner" });
    const members = await call(owner, "add_member", { app: APP, email: COLLAB });
    assert.deepEqual(
      members.map((m: { email: string; role: string }) => `${m.role}:${m.email}`).sort(),
      [`owner:${ADMIN_EMAIL}`, `owner:${OWNER}`, `collaborator:${COLLAB}`].sort(),
    );
    assert.equal((await call(collab, "whoami")).apps.find((a: { slug: string }) => a.slug === APP).role, "collaborator");
    assert.equal((await call(collab, "list_members", { app: APP })).length, 3);

    await refused(collab, "add_member", { app: APP, email: OUTSIDER }, /only an owner/);
    await refused(collab, "remove_member", { app: APP, email: OWNER }, /only an owner/);
    const deployment = await call(collab, "create_deployment", { app: APP, kind: "frontend" });
    assert.match(deployment.upload_url, /\/uploads\//);

    await call(owner, "remove_member", { app: APP, email: ADMIN_EMAIL });
    await refused(owner, "remove_member", { app: APP, email: OWNER }, /last owner/);
    await refused(owner, "add_member", { app: APP, email: OWNER, role: "collaborator" }, /last owner/);
    await refused(admin, "remove_member", { app: APP, email: OWNER }, /last owner/);
    await call(admin, "add_member", { app: APP, email: ADMIN_EMAIL, role: "owner" });
    const audited = psql(`select count(*) from audit_log l join apps a on a.id = l.app_id
      where a.slug = '${APP}' and l.action in ('add_member', 'remove_member')`);
    assert.equal(audited, "4");
  });

  const runningContainers = () =>
    execFileSync("docker", ["ps", "-q", "--filter", `label=platform.app=${APP}`], { encoding: "utf8" }).trim();

  test("11. stop_app / start_app: maintenance page, no API or functions, read-only, then back", async () => {
    await refused(collab, "stop_app", { app: APP }, /only an owner/);
    await refused(collab, "start_app", { app: APP }, /only an owner/);
    // uploaded before the stop, finalized only once started
    const created = await call(owner, "create_deployment", { app: APP, kind: "functions" });
    const put = await fetch(created.upload_url, { method: "PUT", body: await pack(join(work, "project"), ["supabase"]) });
    assert.equal(put.status, 200);

    assert.deepEqual(await call(owner, "stop_app", { app: APP }), { slug: APP, status: "stopped", changed: true });
    assert.equal((await call(owner, "stop_app", { app: APP })).changed, false, "stop_app is idempotent");
    assert.equal((await call(owner, "get_app", { app: APP })).status, "stopped");
    assert.equal((await call(collab, "whoami")).apps.find((a: { slug: string }) => a.slug === APP).status, "stopped");
    assert.equal(runningContainers(), "", "GoTrue and PostgREST are stopped");

    const page = await getPage("/");
    assert.equal(page.status, 503);
    assert.match(page.text, /under maintenance/);
    assert.match(page.headers.get("content-type") ?? "", /text\/html/);
    assert.match((await getPage("/assets/app-v2.js")).text, /under maintenance/, "no static file is served");
    for (const path of ["/rest/v1/todos", "/auth/v1/health", "/functions/v1/ping"]) {
      const response = await fetch(`${APP_URL}${path}`, { headers: { apikey: app.anon_key } });
      assert.equal(response.status, 503, path);
      assert.equal((await response.json()).code, "APP_STOPPED", path);
    }

    // read-only: the database default for every new session, and the control plane refuses every write
    const database = `app_${APP.replace(/-/g, "_")}`;
    assert.equal(psql("show default_transaction_read_only", database), "on");
    assert.equal((await call(collab, "execute_sql", { app: APP, sql: "select count(*)::int as n from public.todos" })).rows.length, 1);
    const stopped = /APP_STOPPED: app .* is stopped and read-only/;
    await refused(owner, "execute_sql", { app: APP, sql: "comment on table public.todos is 'x'", write: true }, stopped);
    const probe = { version: `${RUN}3`, name: "stopped_probe", sql: "create table public.stopped_probe (id int primary key);" +
      "alter table public.stopped_probe enable row level security;" };
    const dry = await call(owner, "apply_migrations", { app: APP, migrations: [probe], dry_run: true });
    assert.equal(dry.status, "dry_run", "dry_run keeps working on a read-only database");
    assert.deepEqual(dry.would_apply, [probe.version]);
    await refused(owner, "apply_migrations", { app: APP, migrations: [probe] }, stopped);
    await refused(owner, "set_secrets", { app: APP, secrets: { GREETING: "no" } }, stopped);
    await refused(owner, "create_deployment", { app: APP, kind: "frontend" }, stopped);
    await refused(owner, "finalize_deployment", { deployment_id: created.deployment_id }, stopped);
    await refused(owner, "rollback", { app: APP, kind: "frontend" }, stopped);
    assert.ok((await call(collab, "list_secrets", { app: APP })).length > 0, "reads stay available");
    assert.ok((await call(collab, "list_deployments", { app: APP })).length > 0);
    assert.equal(psql(`select count(*) from pg_tables where tablename = 'stopped_probe'`, database), "0");

    assert.deepEqual(await call(owner, "start_app", { app: APP }), { slug: APP, status: "running", changed: true });
    assert.equal((await call(owner, "start_app", { app: APP })).changed, false, "start_app is idempotent");
    assert.equal((await call(admin, "get_app", { app: APP })).status, "running");
    assert.equal(psql("show default_transaction_read_only", database), "off");
    assert.notEqual(runningContainers(), "");
    assert.match((await getPage("/")).text, /Demo v2/);
    const rest = await fetch(`${APP_URL}/rest/v1/todos?select=title`, { headers: { apikey: app.anon_key } });
    assert.equal(rest.status, 200);
    assert.deepEqual(await rest.json(), [], "anon sees no todo under RLS");
    const ping = await fetch(`${APP_URL}/functions/v1/ping`);
    assert.deepEqual(await ping.json(), { pong: true });
    const finalized = await call(owner, "finalize_deployment", { deployment_id: created.deployment_id });
    assert.equal(finalized.status, "live", "the upload kept while stopped can be published once started");
    await call(owner, "execute_sql", { app: APP, sql: "comment on table public.todos is 'writable again'", write: true });

    const audited = psql(`select string_agg(l.action, ',' order by l.id) from audit_log l join apps a on a.id = l.app_id
      where a.slug = '${APP}' and l.action in ('stop_app', 'start_app')`);
    assert.equal(audited, "stop_app,start_app");
  });

  test("12. delete_app: owner only, explicit confirmation, final backup first", async () => {
    await refused(collab, "delete_app", { app: APP, confirm: APP }, /only an owner/);
    await refused(owner, "delete_app", { app: APP, confirm: "yes" }, new RegExp(`irreversible: pass confirm="${APP}"`));
    assert.equal((await call(owner, "get_app", { app: APP })).status, "running", "a refused delete changes nothing");

    const deleted = await call(owner, "delete_app", { app: APP, confirm: APP });
    assert.equal(deleted.slug, APP);
    assert.equal(deleted.deleted, true);
    assert.match(deleted.backup, new RegExp(`^/data/backups/${APP}-\\d{4}-\\d\\d-\\d\\dT[\\d-]+Z$`));
    await refused(owner, "get_app", { app: APP }, /not found/);
    assert.equal((await getPage("/")).status, 404, "Caddy no longer routes the app");
    assert.equal(
      psql(`select details->>'backup' from audit_log where action = 'delete_app' and app_id is null and details->>'slug' = '${APP}'`),
      deleted.backup,
    );

    // the backup: a restorable dump of the database (schema, data, auth users) and the deployed files
    const inCp = (...args: string[]) => execFileSync("docker", ["exec", "plat-control-plane", ...args]);
    assert.deepEqual(inCp("ls", deleted.backup).toString().trim().split("\n").sort(),
      ["database.dump", "functions.tar.gz", "manifest.json", "sites.tar.gz"]);
    const dump = inCp("cat", `${deleted.backup}/database.dump`);
    assert.ok(dump.length > 10_000, `dump of ${dump.length} bytes`);
    const listing = execFileSync("docker", ["exec", "-i", "plat-db", "pg_restore", "--list"], { input: dump, encoding: "utf8" });
    assert.match(listing, /TABLE public todos /);
    assert.match(listing, /TABLE DATA auth users /);
    assert.match(listing, /TABLE DATA supabase_migrations schema_migrations /);
    assert.match(inCp("tar", "-tzf", `${deleted.backup}/sites.tar.gz`).toString(), new RegExp(`^${APP}/current`, "m"));
    assert.match(inCp("tar", "-tzf", `${deleted.backup}/functions.tar.gz`).toString(), /\/ping\//);
    assert.equal(JSON.parse(inCp("cat", `${deleted.backup}/manifest.json`).toString()).slug, APP);
  });

  test("13. delete_app with backup: false: nothing kept, audited as skipped", async () => {
    await call(admin, "create_app", { name: "No backup", slug: NO_BACKUP_APP });
    await call(admin, "execute_sql", { app: NO_BACKUP_APP, sql: "create table public.gone (id int)", write: true });
    await refused(admin, "delete_app", { app: NO_BACKUP_APP, confirm: "yes", backup: false },
      new RegExp(`irreversible: pass confirm="${NO_BACKUP_APP}"`));

    const deleted = await call(admin, "delete_app", { app: NO_BACKUP_APP, confirm: NO_BACKUP_APP, backup: false });
    assert.deepEqual(deleted, { slug: NO_BACKUP_APP, deleted: true, backup: null, backup_skipped: true });
    await refused(admin, "get_app", { app: NO_BACKUP_APP }, /not found/);
    const backups = execFileSync("docker", ["exec", "plat-control-plane", "sh", "-c",
      `ls -d /data/backups/${NO_BACKUP_APP}-* 2>/dev/null || true`], { encoding: "utf8" });
    assert.equal(backups.trim(), "", "no backup directory");
    assert.equal(
      psql(`select concat_ws(',', details->>'backup', details->>'backup_skipped') from audit_log
        where action = 'delete_app' and app_id is null and details->>'slug' = '${NO_BACKUP_APP}'`),
      "true",
    );
  });
});
