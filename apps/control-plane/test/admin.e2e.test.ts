// End-to-end test of the admin REST API (admin.<domain>/api, M4) against the running "plat" stack.
// Disposable resources: two builders created through the API, one app created by a builder through MCP, all deleted
// at the end of the run (the app through the API itself, the users through the API then checked by cleanup()).
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { cleanup, cli, psql, runId, waitForControlPlane } from "./disposable.ts";
import { waitForMail } from "./mailpit.ts";

const ROOT = new URL("../../../", import.meta.url);
const env = Object.fromEntries(
  readFileSync(new URL("deploy/.env.local", ROOT), "utf8").split("\n").filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const MCP_URL = env.PLATFORM_URL ?? "http://api.localhost:8100/mcp";
const ADMIN = "http://admin.localhost:8100";
const ADMIN_EMAIL = env.PLATFORM_ADMIN_EMAIL ?? "admin@example.com";
const ID = runId();
const APP = `e2e-${ID}-adm`;
const BUILDER = `e2e-${ID}-builder@example.com`;
const COLLAB = `e2e-${ID}-collab@example.com`;
const LOCKED = `e2e-${ID}-locked@example.com`;
const PASSWORD = randomBytes(18).toString("base64url");

async function connect(token: string) {
  const client = new Client({ name: "admin-e2e", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(MCP_URL), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }));
  return client;
}

/** Whether an MCP client authenticated by this PAT works (always closed). */
async function tokenWorks(token: string) {
  const client = new Client({ name: "admin-e2e", version: "0.0.0" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(MCP_URL), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }));
    await client.callTool({ name: "whoami", arguments: {} });
    return true;
  } catch {
    return false;
  } finally {
    await client.close().catch(() => {});
  }
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const result = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
  if (result.isError) throw new Error(`${name} failed: ${result.content[0]?.text}`);
  return JSON.parse(result.content[0]!.text);
}

interface Reply {
  status: number;
  body: any;
  headers: Headers;
}

/** Admin API request; `auth` is a PAT (Bearer) or `{ cookie }` with the browser headers to send. */
async function request(method: string, path: string, options: {
  token?: string | null;
  cookie?: string;
  headers?: Record<string, string>;
  body?: unknown;
} = {}): Promise<Reply> {
  const token = options.token === undefined ? env.PLATFORM_TOKEN : options.token;
  const headers: Record<string, string> = { ...options.headers };
  if (token) headers.authorization = `Bearer ${token}`;
  if (options.cookie) headers.cookie = options.cookie;
  if (options.body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${ADMIN}/api${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch { /* not JSON */ }
  return { status: response.status, body, headers: response.headers };
}

const list = (resource: string, query: { filter?: object; sort?: [string, string]; range?: [number, number] } = {}) => {
  const params = new URLSearchParams();
  if (query.filter) params.set("filter", JSON.stringify(query.filter));
  if (query.sort) params.set("sort", JSON.stringify(query.sort));
  params.set("range", JSON.stringify(query.range ?? [0, 99]));
  return request("GET", `/${resource}?${params}`);
};

const ok = (reply: Reply, status = 200) => {
  assert.equal(reply.status, status, JSON.stringify(reply.body));
  return reply.body;
};

/** Session cookie of the admin, through the SPA's login endpoint. */
async function adminLogin() {
  const reply = await fetch(`${ADMIN}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ADMIN, "x-platform-admin": "1" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: env.PLATFORM_ADMIN_PASSWORD }),
  });
  assert.equal(reply.status, 200, await reply.clone().text());
  const cookie = reply.headers.getSetCookie().find((c) => c.startsWith("platform_session="));
  assert.ok(cookie, "session cookie");
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Strict/i);
  assert.doesNotMatch(cookie, /Domain=/i, "host-only cookie");
  return cookie.split(";")[0]!;
}

const auditEntries = async (filter: object) => (ok(await list("audit_log", { filter, range: [0, 199] })) as any[]);

describe("admin API e2e", () => {
  const users: Record<string, { id: string; token: string }> = {};
  let builder: Client;

  before(async () => {
    await waitForControlPlane(MCP_URL);
    assert.ok(env.PLATFORM_ADMIN_PASSWORD, "PLATFORM_ADMIN_PASSWORD in deploy/.env.local (install.sh)");
  });

  after(async () => {
    await builder?.close();
    await cleanup([APP], [BUILDER, COLLAB, LOCKED]);
  });

  test("1. SPA and API are served on the admin host only", async () => {
    const page = await fetch(`${ADMIN}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<div id="root">/);
    assert.match(page.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
    for (const [url, init, label] of [
      [`${ADMIN}/mcp`, { method: "POST", body: "{}" }, "no MCP on the admin host"],
      ["http://api.localhost:8100/api/apps", {}, "no admin API on the API host"],
    ] as const) {
      const response = await fetch(url, init);
      await response.body?.cancel();
      assert.equal(response.status, 404, label);
    }
  });

  test("2. anonymous and non-admin callers are refused", async () => {
    assert.equal((await request("GET", "/apps", { token: null })).status, 401);
    assert.equal((await request("GET", "/apps", { token: "plat_not-a-token" })).status, 401);

    const created = ok(await request("POST", "/users", { body: { email: BUILDER, role: "developer", password: PASSWORD } }), 201);
    assert.equal(created.email, BUILDER);
    assert.equal(created.has_password, true);
    assert.equal(created.active, true);
    // M6: a welcome email through the platform SMTP, without the password
    assert.equal(created.welcome_email_sent, true);
    const welcome = await waitForMail(`to:"${BUILDER}" subject:"Your account"`);
    assert.equal(welcome.From.Address, "noreply@platform.localhost");
    assert.match(welcome.Text, /studio\.localhost/);
    assert.ok(!welcome.Text.includes(PASSWORD), "no password in the email");
    const token = ok(await request("POST", "/tokens", { body: { user_id: created.id, name: "e2e" } }), 201);
    assert.match(token.token, /^plat_/);
    users.builder = { id: created.id, token: token.token };

    const refused = await request("GET", "/apps", { token: token.token });
    assert.equal(refused.status, 403, "builder PAT");
    const login = await fetch(`${ADMIN}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ADMIN, "x-platform-admin": "1" },
      body: JSON.stringify({ email: BUILDER, password: PASSWORD }),
    });
    assert.equal(login.status, 403, "a builder cannot open an admin session");
    assert.equal(login.headers.getSetCookie().length, 0);
    const wrong = await fetch(`${ADMIN}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ADMIN, "x-platform-admin": "1" },
      body: JSON.stringify({ email: ADMIN_EMAIL, password: "wrong password!!" }),
    });
    assert.equal(wrong.status, 401);
    await Promise.all([login.body?.cancel(), wrong.body?.cancel()]);
  });

  test("2b. login throttling: the right password is refused while the email is locked out (SEC-3)", async () => {
    const email = LOCKED;
    const created = ok(await request("POST", "/users", { body: { email, role: "admin", password: PASSWORD } }), 201);
    try {
      const attempt = (password: string) => fetch(`${ADMIN}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ADMIN, "x-platform-admin": "1" },
        body: JSON.stringify({ email, password }),
      });
      for (let i = 0; i < 6; i++) {
        const reply = await attempt("wrong password!!");
        await reply.body?.cancel();
        assert.equal(reply.status, 401, `attempt ${i + 1}`);
      }
      const locked = await attempt(PASSWORD);
      assert.equal(locked.status, 429, "checked before the password");
      assert.ok(Number(locked.headers.get("retry-after")) > 0, "Retry-After");
      assert.match((await locked.json()).message, /Too many failed sign-in attempts/);
      assert.equal(locked.headers.getSetCookie().length, 0, "no session");
    } finally {
      ok(await request("DELETE", `/users/${created.id}`));
    }
  });

  test("3. users: list, filter, update, disable, self guards", async () => {
    const page = await list("users", { filter: { q: `e2e-${ID}` }, sort: ["email", "ASC"], range: [0, 9] });
    const rows = ok(page) as any[];
    assert.deepEqual(rows.map((u) => u.email), [BUILDER]);
    assert.match(page.headers.get("content-range") ?? "", /^users 0-0\/1$/);

    const collab = ok(await request("POST", "/users", { body: { email: COLLAB, name: "Collab", role: "developer" } }), 201);
    assert.equal(collab.has_password, false);
    users.collab = { id: collab.id, token: "" };
    assert.equal((await request("POST", "/users", { body: { email: COLLAB, role: "developer" } })).status, 409);
    assert.equal((await request("POST", "/users", { body: { email: "not-an-email", role: "developer" } })).status, 400);

    const renamed = ok(await request("PUT", `/users/${collab.id}`, { body: { ...collab, name: "Collaborator" } }));
    assert.equal(renamed.name, "Collaborator");
    assert.equal((await request("PUT", `/users/${collab.id}`, { body: { password: "short" } })).status, 400);

    // disabling: the builder's PAT stops working at once, re-enabling restores it
    assert.equal(await tokenWorks(users.builder!.token), true);
    ok(await request("PUT", `/users/${users.builder!.id}`, { body: { active: false } }));
    assert.equal(await tokenWorks(users.builder!.token), false, "disabled account");
    ok(await request("PUT", `/users/${users.builder!.id}`, { body: { active: true } }));
    builder = await connect(users.builder!.token);
    assert.equal((await call(builder, "whoami")).email, BUILDER);

    const me = ok(await list("users", { filter: { q: ADMIN_EMAIL } }))[0];
    assert.equal((await request("PUT", `/users/${me.id}`, { body: { active: false } })).status, 400);
    assert.equal((await request("PUT", `/users/${me.id}`, { body: { role: "developer" } })).status, 400);
    assert.equal((await request("DELETE", `/users/${me.id}`)).status, 400);

    const entries = await auditEntries({ action: ["create_user", "update_user"], q: `e2e-${ID}` });
    assert.ok(entries.length >= 4, "user changes audited");
    assert.ok(entries.every((e) => e.user_email === ADMIN_EMAIL), "attributed to the admin");
    assert.ok(!JSON.stringify(entries).includes(PASSWORD), "no password in the audit log");
  });

  test("4. tokens: value shown once, last_used_at, revoke", async () => {
    const created = ok(await request("POST", "/tokens", { body: { user_id: users.builder!.id, name: "e2e-second" } }), 201);
    assert.match(created.token, /^plat_/);
    const fetched = ok(await request("GET", `/tokens/${created.id}`));
    assert.equal(fetched.token, undefined, "the value is never returned again");
    assert.equal(fetched.status, "active");
    assert.equal(fetched.last_used_at, null);

    assert.equal(await tokenWorks(created.token), true);
    const used = ok(await request("GET", `/tokens/${created.id}`));
    assert.ok(used.last_used_at, "last_used_at set");

    const listed = ok(await list("tokens", { filter: { user_id: users.builder!.id } })) as any[];
    assert.deepEqual(listed.map((t) => t.name).sort(), ["e2e", "e2e-second"]);

    const revoked = ok(await request("DELETE", `/tokens/${created.id}`));
    assert.equal(revoked.status, "revoked");
    assert.equal(await tokenWorks(created.token), false, "revoked token");
    assert.equal((await request("POST", "/tokens", { body: { user_id: users.builder!.id, name: "x", expires_at: "2000-01-01" } })).status, 400);
    const entries = await auditEntries({ action: ["create_token", "revoke_token"], q: BUILDER });
    assert.ok(entries.some((e) => e.action === "revoke_token" && e.details.token_id === created.id));
    assert.ok(entries.every((e) => e.user_email === ADMIN_EMAIL));
    assert.ok(!JSON.stringify(entries).includes(created.token), "token value never audited");
  });

  test("5. apps list: fields, filters, sort, flags", async () => {
    await call(builder, "create_app", { name: "Admin e2e", slug: APP });
    const release = await call(builder, "begin_release", { app: APP, commit_sha: "a".repeat(40) });
    await call(builder, "finish_release", { release_id: release.release_id, status: "succeeded" });
    await call(builder, "set_secrets", { app: APP, secrets: { E2E_SECRET: "super-secret-value" } });
    // a schema change outside any release (as from Studio's SQL editor)
    await call(builder, "execute_sql", { app: APP, sql: "create table public.drift (id int)", write: true });

    const page = await list("apps", { filter: { q: APP }, range: [0, 9] });
    const [app] = ok(page) as any[];
    assert.match(page.headers.get("content-range") ?? "", /^apps 0-0\/1$/);
    assert.equal(app.id, APP);
    assert.equal(app.name, "Admin e2e");
    assert.equal(app.status, "running");
    assert.equal(app.url, `http://${APP}.localhost:8100`);
    assert.equal(app.studio_url, `http://studio.localhost:8100/project/${APP}`);
    assert.deepEqual(app.owners.map((o: any) => o.email), [BUILDER]);
    assert.equal(app.last_release.source, "direct");
    assert.equal(app.last_release.commit_sha, "a".repeat(40));
    assert.equal(app.last_release.created_by, BUILDER);
    assert.equal(app.last_release.status, "succeeded");
    assert.equal(app.flags.outside_ci, true);
    assert.equal(app.flags.no_repo, true);
    assert.ok(app.flags.schema_drift >= 1, `schema drift: ${app.flags.schema_drift}`);
    assert.ok(app.db_size > 0);
    assert.ok(!JSON.stringify(app).includes("anon_key") && !JSON.stringify(app).includes("secrets_enc"));

    // filters and sort
    const byOwner = ok(await list("apps", { filter: { owner_id: users.builder!.id } })) as any[];
    assert.deepEqual(byOwner.map((a) => a.slug), [APP]);
    const outside = ok(await list("apps", { filter: { outside_ci: true, q: APP } })) as any[];
    assert.equal(outside.length, 1);
    assert.equal((ok(await list("apps", { filter: { outside_ci: false, q: APP } })) as any[]).length, 0);
    const drift = ok(await list("apps", { filter: { schema_drift: true, q: APP } })) as any[];
    assert.equal(drift.length, 1);
    assert.equal((ok(await list("apps", { filter: { status: "stopped", q: APP } })) as any[]).length, 0);
    const desc = ok(await list("apps", { sort: ["slug", "DESC"], range: [0, 499] })) as any[];
    const slugs = desc.map((a) => a.slug);
    assert.deepEqual(slugs, [...slugs].sort().reverse());
    const many = ok(await list("apps", { filter: { id: [APP, "does-not-exist"] } })) as any[];
    assert.deepEqual(many.map((a) => a.id), [APP], "getMany");

    const detail = ok(await request("GET", `/apps/${APP}`));
    assert.deepEqual(detail.services.map((s: any) => s.service).sort(), ["gotrue", "postgrest"]);
    // M6: the auth policy, read-only, without any SMTP secret
    assert.equal(detail.auth.signup_enabled, true);
    assert.equal(detail.auth.smtp_configured, true);
    assert.equal(detail.auth.email_confirmation_effective, true);
    assert.deepEqual(detail.auth.uri_allow_list, [`http://${APP}.localhost:8100/**`]);
    assert.doesNotMatch(JSON.stringify(detail.auth), /password|pass"/i);
    assert.equal((await request("GET", "/apps/does-not-exist")).status, 404);
  });

  test("6. releases, deployments, secrets (names only), schema changes", async () => {
    const releases = ok(await list("releases", { filter: { app: APP } })) as any[];
    assert.equal(releases.length, 1);
    assert.equal(releases[0].source, "direct");
    assert.equal(releases[0].created_by, BUILDER);
    const deployments = ok(await list("deployments", { filter: { app: APP } })) as any[];
    assert.ok(Array.isArray(deployments));

    const secrets = await list("secrets", { filter: { app: APP } });
    assert.deepEqual((ok(secrets) as any[]).map((s) => s.name), ["E2E_SECRET"]);
    assert.ok(!JSON.stringify(secrets.body).includes("super-secret-value"), "secret values never returned");

    const changes = ok(await list("schema_changes", { filter: { app: APP } })) as any[];
    assert.ok(changes.some((c) => c.object_identity === "public.drift" && c.in_release === false));
    assert.equal((await list("schema_changes")).status, 400, "schema_changes needs an app");

    const logs = ok(await request("GET", `/apps/${APP}/logs?service=gotrue&limit=20`)) as any[];
    assert.ok(Array.isArray(logs));
  });

  test("7. members: add, change role, last-owner guard, remove", async () => {
    const added = ok(await request("POST", "/app_members", { body: { app: APP, email: COLLAB, role: "collaborator" } }), 201);
    assert.equal(added.id, `${APP}:${users.collab!.id}`);
    assert.equal(added.role, "collaborator");
    const promoted = ok(await request("PUT", `/app_members/${added.id}`, { body: { role: "owner" } }));
    assert.equal(promoted.role, "owner");
    ok(await request("PUT", `/app_members/${added.id}`, { body: { role: "collaborator" } }));

    const members = ok(await list("app_members", { filter: { app: APP } })) as any[];
    assert.deepEqual(members.map((m) => `${m.email}:${m.role}`).sort(), [`${BUILDER}:owner`, `${COLLAB}:collaborator`].sort());
    const ofUser = ok(await list("app_members", { filter: { user_id: users.collab!.id } })) as any[];
    assert.deepEqual(ofUser.map((m) => m.app), [APP]);

    const lastOwner = await request("DELETE", `/app_members/${APP}:${users.builder!.id}`);
    assert.equal(lastOwner.status, 400, JSON.stringify(lastOwner.body));
    assert.match(lastOwner.body.message, /last owner/);
    assert.equal((await request("POST", "/app_members", { body: { app: APP, email: "nobody@example.com" } })).status, 400);

    const deletedOwner = await request("DELETE", `/users/${users.builder!.id}`);
    assert.equal(deletedOwner.status, 409, "deleting the last owner of an app is refused");
    assert.match(deletedOwner.body.message, new RegExp(APP));

    ok(await request("DELETE", `/app_members/${added.id}`));
    const entries = await auditEntries({ app: APP, action: ["add_member", "remove_member"] });
    assert.ok(entries.length >= 4);
    assert.ok(entries.every((e) => e.user_email === ADMIN_EMAIL && e.app === APP));
  });

  test("8. CSRF: cookie mutations need the admin Origin and the custom header", async () => {
    const cookie = await adminLogin();
    const me = await request("GET", "/auth/me", { token: null, cookie });
    assert.equal(me.status, 200);
    assert.equal(me.body.email, ADMIN_EMAIL);
    const target = `/users/${users.collab!.id}`;
    const browser = { origin: ADMIN, "x-platform-admin": "1" };

    const noOrigin = await request("PUT", target, { token: null, cookie, headers: { "x-platform-admin": "1" }, body: { name: "x" } });
    assert.equal(noOrigin.status, 403);
    const foreign = await request("PUT", target, {
      token: null,
      cookie,
      headers: { origin: `http://${APP}.localhost:8100`, "x-platform-admin": "1" },
      body: { name: "x" },
    });
    assert.equal(foreign.status, 403, "an app frontend (same site) cannot act with the admin's session");
    const noHeader = await request("PUT", target, { token: null, cookie, headers: { origin: ADMIN }, body: { name: "x" } });
    assert.equal(noHeader.status, 403);
    const crossSiteRead = await request("GET", "/users", { token: null, cookie, headers: { "sec-fetch-site": "same-site" } });
    assert.equal(crossSiteRead.status, 403);
    const loginNoOrigin = await fetch(`${ADMIN}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: ADMIN_EMAIL, password: env.PLATFORM_ADMIN_PASSWORD }),
    });
    assert.equal(loginNoOrigin.status, 403, "login CSRF");
    await loginNoOrigin.body?.cancel();

    const allowed = await request("PUT", target, { token: null, cookie, headers: browser, body: { name: "Via cookie" } });
    assert.equal(allowed.status, 200, JSON.stringify(allowed.body));
    assert.equal(allowed.body.name, "Via cookie");

    const logout = await request("POST", "/auth/logout", { token: null, cookie, headers: browser });
    assert.equal(logout.status, 200);
    assert.equal((await request("GET", "/auth/me", { token: null, cookie })).status, 401, "session deleted");
  });

  test("9. stop and start through the API", async () => {
    const stopped = ok(await request("POST", `/apps/${APP}/stop`, { body: {} }));
    assert.equal(stopped.changed, true);
    assert.equal(stopped.data.status, "stopped");
    assert.equal(stopped.data.flags.stopped, true);
    const page = await fetch(`http://${APP}.localhost:8100/`);
    assert.equal(page.status, 503, "maintenance page");
    await page.body?.cancel();
    const rollback = await request("POST", `/apps/${APP}/rollback`, { body: { kind: "frontend" } });
    assert.equal(rollback.status, 409, "a stopped app refuses writes");
    assert.equal(rollback.body.code, "APP_STOPPED");

    const started = ok(await request("POST", `/apps/${APP}/start`, { body: {} }));
    assert.equal(started.data.status, "running");
    const served = await fetch(`http://${APP}.localhost:8100/`);
    assert.equal(served.status, 200);
    await served.body?.cancel();

    const entries = await auditEntries({ app: APP, action: ["stop_app", "start_app"] });
    assert.deepEqual(entries.map((e) => e.action), ["start_app", "stop_app"]);
    assert.ok(entries.every((e) => e.user_email === ADMIN_EMAIL));
  });

  test("10. dashboard", async () => {
    const stats = ok(await request("GET", "/dashboard"));
    assert.ok(stats.apps.total >= 1);
    assert.ok(stats.apps.by_status.running >= 1);
    assert.ok(stats.users.admins >= 1);
    assert.ok(stats.database.cluster_bytes > stats.database.app_databases_bytes);
    assert.ok(stats.host.memory_total > 0);
    assert.ok(stats.host.disk.total > 0);
    assert.ok(Array.isArray(stats.recent_failures));
  });

  test("10b. settings: read-only view of the values in effect and the overrides; CLI changes are audited", async () => {
    const key = "abandoned_after_days";
    const before = ok(await request("GET", "/settings"));
    const previous = before.overrides.find((o: { key: string }) => o.key === key)?.value as string | undefined;
    assert.equal(typeof before.effective.abandonedAfterDays, "number");
    assert.equal(before.effective.sso.client_secret, undefined, "no secret in the view");
    try {
      cli(["set-setting", key, "45"]);
      const set = ok(await request("GET", "/settings"));
      assert.equal(set.effective.abandonedAfterDays, 45);
      assert.deepEqual(
        (({ key, value, env }) => ({ key, value, env }))(set.overrides.find((o: { key: string }) => o.key === key)),
        { key, value: "45", env: "ABANDONED_AFTER_DAYS" },
      );
      const [audited] = await auditEntries({ action: "set_setting" });
      assert.deepEqual(audited.details, { key, value: "45", source: "cli" });
      cli(["unset-setting", key]);
      assert.ok(!ok(await request("GET", "/settings")).overrides.some((o: { key: string }) => o.key === key));
      assert.deepEqual((await auditEntries({ action: "unset_setting" }))[0].details, { key, source: "cli" });
    } finally {
      if (previous !== undefined) cli(["set-setting", key, previous]);
      else cli(["unset-setting", key]);
    }
  });

  test("11. delete the app through the API, then its owner", async () => {
    assert.equal((await request("DELETE", `/apps/${APP}`)).status, 405);
    const wrong = await request("POST", `/apps/${APP}/delete`, { body: { confirm: "nope", backup: false } });
    assert.equal(wrong.status, 400);
    const deleted = ok(await request("POST", `/apps/${APP}/delete`, { body: { confirm: APP, backup: false } }));
    assert.equal(deleted.deleted, true);
    assert.equal(deleted.backup_skipped, true);
    assert.equal((await request("GET", `/apps/${APP}`)).status, 404);
    const [entry] = await auditEntries({ app: APP, action: "delete_app" });
    assert.equal(entry.user_email, ADMIN_EMAIL);
    assert.equal(entry.details.backup_skipped, true);

    const removed = ok(await request("DELETE", `/users/${users.builder!.id}`));
    assert.equal(removed.email, BUILDER);
    assert.equal(psql(`select count(*) from users where email = '${BUILDER}'`), "0");
    assert.equal(psql(`select count(*) from tokens where user_id = '${users.builder!.id}'`), "0");
  });
});
