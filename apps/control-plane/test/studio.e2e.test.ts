// End-to-end test of Studio for app builders against the running "plat" stack (deploy/install.sh).
// Creates two disposable apps and two disposable builders, all deleted at the end of the run.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { request } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { cleanup, cli, runId } from "./disposable.ts";

const ROOT = new URL("../../../", import.meta.url);
const readEnv = (file: string) =>
  Object.fromEntries(
    readFileSync(new URL(file, ROOT), "utf8").split("\n").filter((l) => l.includes("="))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );
const local = readEnv("deploy/.env.local");
const secrets = readEnv("deploy/.env");

const STUDIO = "http://studio.localhost:8100";
const RUN = Date.now();
const ID = runId();
/** alice is a member of A only, bob of B only. */
const A = `e2e-${ID}-a`;
const B = `e2e-${ID}-b`;
const dbId = (slug: string) => slug.replace(/-/g, "_");

async function connect(token = local.PLATFORM_TOKEN) {
  const client = new Client({ name: "studio-e2e", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(local.PLATFORM_URL ?? "http://api.localhost:8100/mcp"), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }));
  return client;
}

async function tool(client: Client, name: string, args: Record<string, unknown>): Promise<any> {
  const result = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
  if (result.isError) throw new Error(`${name} failed: ${result.content[0]?.text}`);
  return JSON.parse(result.content[0]!.text);
}
/** Runs a fetch inside the plat network (from the control-plane container) and returns {status, body}. */
const inNetwork = (url: string, init: Record<string, unknown> = {}) =>
  JSON.parse(execFileSync("docker", ["exec", "plat-control-plane", "node", "-e",
    `fetch(${JSON.stringify(url)}, ${JSON.stringify(init)}).then(async (r) => console.log(JSON.stringify({ status: r.status, body: await r.text() })))`,
  ], { encoding: "utf8" }));

interface Reply { status: number; headers: Record<string, string | string[] | undefined>; body: string }

/** Raw HTTP through Caddy: the path is sent as is (fetch would normalise "..", "%2e"...). */
function raw(method: string, path: string, headers: Record<string, string> = {}, body?: unknown): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = request({
      host: "127.0.0.1",
      port: 8100,
      method,
      path,
      headers: {
        host: "studio.localhost:8100",
        ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
        ...headers,
      },
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data }));
    });
    req.on("error", reject);
    req.end(payload);
  });
}

async function login(email: string, password: string): Promise<string> {
  const response = await fetch(`${STUDIO}/_platform/login`, {
    method: "POST",
    redirect: "manual",
    body: new URLSearchParams({ email, password, next: "/projects" }),
  });
  assert.equal(response.status, 303, `login ${email}`);
  const cookie = response.headers.getSetCookie().find((c) => c.startsWith("platform_session="));
  assert.ok(cookie, "session cookie");
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Lax/i);
  return cookie.split(";")[0]!;
}

const sql = (cookie: string, ref: string, query: string, headers: Record<string, string> = {}) =>
  raw("POST", `/api/platform/pg-meta/${ref}/query`, { cookie, ...headers }, { query });

const projectRefs = async (cookie: string) => {
  const reply = await raw("GET", "/api/platform/projects", { cookie });
  assert.equal(reply.status, 200, reply.body);
  return (JSON.parse(reply.body).projects as { ref: string }[]).map((p) => p.ref).sort();
};

describe("Studio for app builders", () => {
  const users = {
    alice: { email: `e2e-${ID}-alice@example.com`, password: randomBytes(18).toString("base64url"), app: A, token: "" },
    bob: { email: `e2e-${ID}-bob@example.com`, password: randomBytes(18).toString("base64url"), app: B, token: "" },
  };
  let alice = "";
  let bob = "";
  let admin = "";
  let projects: { ref: string; service_key: string; internal_url: string }[] = [];

  before(async () => {
    const client = await connect();
    try {
      for (const slug of [A, B]) await tool(client, "create_app", { name: slug, slug });
      await tool(client, "apply_migrations", {
        app: A,
        migrations: [{ version: "20260101000001", name: "create_todos", sql: readFileSync(new URL("fixtures/todos.sql", import.meta.url), "utf8") }],
      });
      const { anon_key } = await tool(client, "get_app", { app: A });
      const signup = await fetch(`http://${A}.localhost:8100/auth/v1/signup`, {
        method: "POST",
        headers: { apikey: anon_key, "content-type": "application/json" },
        body: JSON.stringify({ email: `user-${RUN}@example.com`, password: randomBytes(12).toString("hex") }),
      });
      assert.equal(signup.status, 200, await signup.text());
    } finally {
      await client.close();
    }
    for (const user of Object.values(users)) {
      user.token = cli(["create-user", user.email, "developer", "studio-e2e"]).trim();
      cli(["set-password", user.email], user.password);
      cli(["add-member", user.app, user.email, "collaborator"]);
    }
    alice = await login(users.alice.email, users.alice.password);
    bob = await login(users.bob.email, users.bob.password);
    admin = await login(local.PLATFORM_ADMIN_EMAIL!, local.PLATFORM_ADMIN_PASSWORD!);
    const internal = inNetwork("http://localhost:3001/internal/studio/projects", {
      headers: { authorization: `Bearer ${secrets.PLATFORM_STUDIO_CONFIG_TOKEN}` },
    });
    projects = JSON.parse(internal.body);
    // Studio caches the project list for 2 s
    for (let i = 0; i < 20 && !(await projectRefs(admin)).includes(B); i++) await sleep(500);
  });

  after(async () => {
    await raw("POST", "/_platform/logout", { cookie: bob });
    await raw("POST", "/_platform/logout", { cookie: admin });
    await cleanup([A, B], Object.values(users).map((u) => u.email));
  });

  test("1. login: wrong password, no session", async () => {
    const wrong = await fetch(`${STUDIO}/_platform/login`, {
      method: "POST",
      redirect: "manual",
      body: new URLSearchParams({ email: users.alice.email, password: "not-the-password" }),
    });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.headers.getSetCookie().length, 0);
    assert.equal((await raw("GET", "/api/platform/projects")).status, 401);
    assert.equal((await raw("POST", `/api/platform/pg-meta/${A}/query`, {}, { query: "select 1" })).status, 401);
    const page = await raw("GET", `/project/${A}/editor`, { accept: "text/html" });
    assert.equal(page.status, 302);
    assert.equal(page.headers.location, `/_platform/login?next=%2Fproject%2F${A}%2Feditor`);
    assert.equal((await raw("GET", "/api/platform/projects", { cookie: "platform_session=sess_forged" })).status, 401);
  });

  test("2. project lists are filtered", async () => {
    assert.deepEqual(await projectRefs(alice), [A]);
    assert.deepEqual(await projectRefs(bob), [B]);
    const all = await projectRefs(admin);
    assert.ok(all.includes(A) && all.includes(B), all.join());
    const orgProjects = await raw("GET", "/api/platform/organizations/default-org-slug/projects", { cookie: alice });
    assert.equal(orgProjects.status, 200, orgProjects.body);
    assert.ok(orgProjects.body.includes(A) && !orgProjects.body.includes(B), orgProjects.body);
    const profile = JSON.parse((await raw("GET", "/api/platform/profile", { cookie: alice })).body);
    assert.equal(profile.primary_email, users.alice.email);
  });

  test("2b. add-member and remove-member apply to open sessions", async () => {
    cli(["add-member", A, users.bob.email, "collaborator"]);
    assert.deepEqual(await projectRefs(bob), [A, B].sort());
    assert.equal((await sql(bob, A, "select 1")).status, 200);
    assert.equal(cli(["remove-member", A, users.bob.email]).trim(), `${users.bob.email} removed from ${A}`);
    assert.equal(cli(["remove-member", A, users.bob.email]).trim(), `${users.bob.email} is not a member of ${A}`);
    assert.deepEqual(await projectRefs(bob), [B]);
    assert.equal((await sql(bob, A, "select 1")).status, 403);
    assert.throws(() => cli(["remove-member", A, local.PLATFORM_ADMIN_EMAIL!]), /last owner/);
  });

  test("2c. MCP add_member and remove_member apply at once to Studio and whoami", async () => {
    const owner = await connect();
    const bobClient = await connect(users.bob.token);
    try {
      const bobApps = async () => (await tool(bobClient, "whoami", {})).apps.map((a: { slug: string; role: string }) => `${a.slug}:${a.role}`).sort();
      await tool(owner, "add_member", { app: A, email: users.bob.email, role: "collaborator" });
      assert.deepEqual(await projectRefs(bob), [A, B].sort());
      assert.deepEqual(await bobApps(), [`${A}:collaborator`, `${B}:collaborator`].sort());
      const { removed } = await tool(owner, "remove_member", { app: A, email: users.bob.email });
      assert.equal(removed, true);
      assert.deepEqual(await projectRefs(bob), [B]);
      assert.deepEqual(await bobApps(), [`${B}:collaborator`]);
    } finally {
      await bobClient.close();
      await owner.close();
    }
  });

  test("3. alice queries her app through pg-meta (own database, owner role)", async () => {
    const reply = await sql(alice, A, "select current_user as u, current_database() as d");
    assert.equal(reply.status, 200, reply.body);
    assert.deepEqual(JSON.parse(reply.body), [{ u: `app_${dbId(A)}_owner`, d: `app_${dbId(A)}` }]);
    // proxy routes (fixed fork bug): the table list comes from the app, not from pg-meta's default database
    const tables = await raw("GET", `/api/platform/pg-meta/${A}/tables?included_schemas=public`, { cookie: alice });
    assert.equal(tables.status, 200, tables.body);
    assert.ok((JSON.parse(tables.body) as { name: string }[]).some((t) => t.name === "todos"), tables.body);
    const users = await sql(alice, A, "select count(*)::int as n from auth.users");
    assert.equal(users.status, 200, users.body);
  });

  test("4. alice cannot reach bob's app", async () => {
    const deny = async (label: string, reply: Promise<Reply>) => {
      const { status, body } = await reply;
      assert.ok(status === 403 || status === 400, `${label}: ${status} ${body}`);
    };
    await deny("url", sql(alice, B, "select 1"));
    await deny("forged X-Platform-Apps", sql(alice, B, "select 1", { "x-platform-apps": `${A},${B}`, "x-platform-role": "admin" }));
    await deny("encoded ref", sql(alice, B.replaceAll("-", "%2D"), "select 1"));
    await deny("encoded ref 2", sql(alice, `%${B.charCodeAt(0).toString(16)}${B.slice(1)}`, "select 1"));
    await deny("case", sql(alice, B.toUpperCase(), "select 1"));
    await deny("dot-dot", raw("POST", `/api/platform/pg-meta/${A}/../${B}/query`, { cookie: alice }, { query: "select 1" }));
    await deny("encoded dot-dot", raw("POST", `/api/platform/pg-meta/${A}/%2e%2e/${B}/query`, { cookie: alice }, { query: "select 1" }));
    await deny("upper-case prefix", raw("POST", `/API/platform/pg-meta/${B}/query`, { cookie: alice }, { query: "select 1" }));
    await deny("page", raw("GET", `/project/${B}/editor`, { cookie: alice, accept: "text/html" }));
    await deny("auth route", raw("POST", `/api/platform/auth/${B}/users`, { cookie: alice }, { email: `x${RUN}@example.com` }));
    await deny("types", raw("GET", `/api/v1/projects/${B}/types/typescript`, { cookie: alice }));
    await deny("bob on alice's app", sql(bob, A, "select 1"));
  });

  test("5. Studio's own guard (behind Caddy) checks the signed identity", () => {
    const now = Math.floor(Date.now() / 1000);
    const sign = (user: string, role: string, apps: string, ts = now) =>
      `t=${ts},s=${createHmac("sha256", secrets.PLATFORM_STUDIO_HEADER_SECRET!).update(`${user}\n${role}\n${apps}\n${ts}`).digest("hex")}`;
    const call = (headers: Record<string, string>, ref = B) =>
      inNetwork(`http://studio:3000/api/platform/pg-meta/${ref}/query`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ query: "select 1 as one" }),
      }).status;
    const identity = (apps: string, signature = sign(users.alice.email, "developer", apps)) => ({
      "x-platform-user": users.alice.email,
      "x-platform-role": "developer",
      "x-platform-apps": apps,
      "x-platform-signature": signature,
    });
    assert.equal(call({}), 401, "no identity");
    assert.equal(call({ ...identity(A), "x-platform-apps": `${A},${B}` }), 401, "apps changed after signing");
    assert.equal(call(identity(A, sign(users.alice.email, "developer", A, now - 3600))), 401, "expired");
    assert.equal(call(identity(A)), 403, "foreign ref");
    assert.equal(call(identity(A), A), 200, "own ref");
  });

  test("6. fork features are refused, admins included", async () => {
    for (const cookie of [alice, admin]) {
      assert.equal((await raw("POST", "/api/self-hosted/bootstrap", { cookie }, { email: "a@b.c", password: "x" })).status, 403);
      assert.equal((await raw("POST", "/api/platform/projects/import", { cookie }, { name: "x" })).status, 403);
      assert.equal((await raw("POST", "/api/platform/projects", { cookie }, { name: "x" })).status, 403);
      assert.equal((await raw("DELETE", `/api/platform/projects/${A}`, { cookie })).status, 403);
      assert.equal((await raw("POST", `/api/platform/projects/${A}/failover`, { cookie })).status, 403);
    }
  });

  test("7. the admin sees and queries every app", async () => {
    for (const ref of [A, B]) {
      const reply = await sql(admin, ref, "select current_database() as d");
      assert.equal(reply.status, 200, reply.body);
      assert.deepEqual(JSON.parse(reply.body), [{ d: `app_${dbId(ref)}` }]);
    }
  });

  test("8. an auth user created from Studio lands in the app's GoTrue only", async () => {
    const email = `studio-${RUN}@example.com`;
    const created = await raw("POST", `/api/platform/auth/${A}/users`, { cookie: alice }, {
      email,
      password: randomBytes(12).toString("hex"),
      email_confirm: true,
    });
    assert.equal(created.status, 200, created.body);
    const id = JSON.parse(created.body).id as string;
    const find = (ref: string) => {
      const project = projects.find((p) => p.ref === ref)!;
      const reply = inNetwork(`${project.internal_url}/auth/v1/admin/users?per_page=1000`, {
        headers: { apikey: project.service_key, authorization: `Bearer ${project.service_key}` },
      });
      assert.equal(reply.status, 200, reply.body);
      return (JSON.parse(reply.body).users as { id: string; email: string }[]).find((u) => u.email === email);
    };
    assert.equal(find(A)?.id, id);
    assert.equal(find(B), undefined);
    const listed = await sql(alice, A, `select id from auth.users where email = '${email}'`);
    assert.deepEqual(JSON.parse(listed.body), [{ id }]);

    const removed = await raw("DELETE", `/api/platform/auth/${A}/users/${id}`, { cookie: alice });
    assert.equal(removed.status, 200, removed.body);
    assert.equal(find(A), undefined);
  });

  test("9. storage targets the project and fails cleanly (no Storage before M5)", async () => {
    const reply = await raw("GET", `/api/platform/storage/${A}/buckets`, { cookie: alice });
    assert.ok(reply.status >= 400 && reply.status < 600, `${reply.status} ${reply.body}`);
    assert.doesNotThrow(() => JSON.parse(reply.body));
    assert.equal((await raw("GET", `/api/platform/storage/${B}/buckets`, { cookie: alice })).status, 403);
  });

  test("9b. owner role: no BYPASSRLS, auth.* read through targeted policies only", async () => {
    const rows = async (query: string) => {
      const reply = await sql(alice, A, query);
      assert.equal(reply.status, 200, reply.body);
      return JSON.parse(reply.body) as Record<string, unknown>[];
    };
    assert.deepEqual(await rows("select rolbypassrls from pg_roles where rolname = current_user"), [{ rolbypassrls: false }]);
    // Auth > Users (pg-meta get-users-paginated: auth.users joined with auth.identities)
    const listed = await rows(`select u.email, coalesce((select array_agg(distinct i.provider) from auth.identities i
      where i.user_id = u.id), '{}') as providers from auth.users u order by u.created_at desc limit 20`);
    assert.ok(listed.length > 0, "the app's users are visible");
    assert.ok(listed.some((u) => (u.providers as string[]).includes("email")), JSON.stringify(listed));
    for (const table of ["sessions", "refresh_tokens", "mfa_factors", "one_time_tokens", "oauth_clients"]) {
      const reply = await sql(alice, A, `select count(*) from auth.${table}`);
      assert.notEqual(reply.status, 200, `${table}: ${reply.body}`);
      assert.match(reply.body, /permission denied/, table);
    }
    assert.deepEqual(await rows(`select tablename::text as t, roles::text[] as roles, cmd from pg_policies
      where schemaname = 'auth' order by 1`), [
      { t: "identities", roles: [`app_${dbId(A)}_owner`], cmd: "SELECT" },
      { t: "users", roles: [`app_${dbId(A)}_owner`], cmd: "SELECT" },
    ]);
    assert.deepEqual(await rows(`select bool_and(relrowsecurity) as rls from pg_class
      where oid in ('auth.users'::regclass, 'auth.identities'::regclass)`), [{ rls: true }]);
    assert.deepEqual(await rows(`select r, has_schema_privilege(r, 'auth', 'usage') and
      (has_table_privilege(r, 'auth.users', 'select') or has_table_privilege(r, 'auth.identities', 'select')) as reads
      from unnest(array['anon', 'authenticated', 'service_role', 'app_${dbId(A)}_authenticator']) r`), [
      { r: "anon", reads: false },
      { r: "authenticated", reads: false },
      { r: "service_role", reads: false },
      { r: `app_${dbId(A)}_authenticator`, reads: false },
    ]);
    // Assumed: the owner owns its public tables, so their RLS does not apply to it (as for Supabase's "postgres").
    const probe = `public.rls_probe_${RUN}`;
    try {
      assert.deepEqual(await rows(`create table ${probe} (x int); alter table ${probe} enable row level security;
        insert into ${probe} values (1); select count(*)::int as n from ${probe}`), [{ n: 1 }]);
    } finally {
      await rows(`drop table if exists ${probe}`);
    }
  });

  test("9c. execute_sql (owner role) still reads auth.users for diagnostics", async () => {
    const client = await connect();
    try {
      const run = async (query: string) =>
        (await client.callTool({ name: "execute_sql", arguments: { app: A, sql: query } })) as
          { isError?: boolean; content: { text: string }[] };
      const users = await run("select count(*)::int as n, (select rolbypassrls from pg_roles where rolname = current_user) as b from auth.users");
      assert.ok(!users.isError, users.content[0]?.text);
      const [row] = JSON.parse(users.content[0]!.text).rows as { n: number; b: boolean }[];
      assert.ok(row!.n > 0 && row!.b === false, JSON.stringify(row));
      const sessions = await run("select count(*) from auth.sessions");
      assert.ok(sessions.isError && /permission denied/.test(sessions.content[0]!.text), sessions.content[0]?.text);
    } finally {
      await client.close();
    }
  });

  test("10. logout ends the session", async () => {
    const out = await raw("POST", "/_platform/logout", { cookie: alice });
    assert.equal(out.status, 303);
    assert.equal((await raw("GET", "/api/platform/projects", { cookie: alice })).status, 401);
  });
});
