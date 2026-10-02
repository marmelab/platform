// End-to-end test of Studio for app builders against the running "plat" stack (deploy/install.sh).
// Needs the apps "demo" and "todo-app" (control plane e2e and the todo-app example).
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { request } from "node:http";

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
const cli = (args: string[], input?: string) =>
  execFileSync("docker", ["exec", "-i", "plat-control-plane", "node", "src/cli.ts", ...args], { input, encoding: "utf8" });
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
    alice: { email: `alice@example.com`, password: randomBytes(18).toString("base64url") },
    bob: { email: `bob@example.com`, password: randomBytes(18).toString("base64url") },
  };
  let alice = "";
  let bob = "";
  let admin = "";
  let projects: { ref: string; service_key: string; internal_url: string }[] = [];

  before(async () => {
    for (const [name, user] of Object.entries(users)) {
      cli(["create-user", user.email, "developer", "studio-e2e"]);
      cli(["set-password", user.email], user.password);
      cli(["add-member", name === "alice" ? "demo" : "todo-app", user.email, "developer"]);
    }
    alice = await login(users.alice.email, users.alice.password);
    bob = await login(users.bob.email, users.bob.password);
    admin = await login(local.PLATFORM_ADMIN_EMAIL!, local.PLATFORM_ADMIN_PASSWORD!);
    const internal = inNetwork("http://localhost:3001/internal/studio/projects", {
      headers: { authorization: `Bearer ${secrets.PLATFORM_STUDIO_CONFIG_TOKEN}` },
    });
    projects = JSON.parse(internal.body);
  });

  after(async () => {
    await raw("POST", "/_platform/logout", { cookie: bob });
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
    assert.equal((await raw("POST", "/api/platform/pg-meta/demo/query", {}, { query: "select 1" })).status, 401);
    const page = await raw("GET", "/project/demo/editor", { accept: "text/html" });
    assert.equal(page.status, 302);
    assert.equal(page.headers.location, "/_platform/login?next=%2Fproject%2Fdemo%2Feditor");
    assert.equal((await raw("GET", "/api/platform/projects", { cookie: "platform_session=sess_forged" })).status, 401);
  });

  test("2. project lists are filtered", async () => {
    assert.deepEqual(await projectRefs(alice), ["demo"]);
    assert.deepEqual(await projectRefs(bob), ["todo-app"]);
    const all = await projectRefs(admin);
    assert.ok(all.includes("demo") && all.includes("todo-app"), all.join());
    const orgProjects = await raw("GET", "/api/platform/organizations/default-org-slug/projects", { cookie: alice });
    assert.ok(!orgProjects.body.includes("todo-app"));
    const profile = JSON.parse((await raw("GET", "/api/platform/profile", { cookie: alice })).body);
    assert.equal(profile.primary_email, users.alice.email);
  });

  test("3. alice queries demo through pg-meta (own database, owner role)", async () => {
    const reply = await sql(alice, "demo", "select current_user as u, current_database() as d");
    assert.equal(reply.status, 200, reply.body);
    assert.deepEqual(JSON.parse(reply.body), [{ u: "app_demo_owner", d: "app_demo" }]);
    // proxy routes (fixed fork bug): the table list comes from demo, not from pg-meta's default database
    const tables = await raw("GET", "/api/platform/pg-meta/demo/tables?included_schemas=public", { cookie: alice });
    assert.equal(tables.status, 200, tables.body);
    assert.ok((JSON.parse(tables.body) as { name: string }[]).some((t) => t.name === "todos"), tables.body);
    const users = await sql(alice, "demo", "select count(*)::int as n from auth.users");
    assert.equal(users.status, 200, users.body);
  });

  test("4. alice cannot reach todo-app", async () => {
    const deny = async (label: string, reply: Promise<Reply>) => {
      const { status, body } = await reply;
      assert.ok(status === 403 || status === 400, `${label}: ${status} ${body}`);
    };
    await deny("url", sql(alice, "todo-app", "select 1"));
    await deny("forged X-Platform-Apps", sql(alice, "todo-app", "select 1", { "x-platform-apps": "demo,todo-app", "x-platform-role": "admin" }));
    await deny("encoded ref", sql(alice, "todo%2Dapp", "select 1"));
    await deny("encoded ref 2", sql(alice, "%74odo-app", "select 1"));
    await deny("case", sql(alice, "TODO-APP", "select 1"));
    await deny("dot-dot", raw("POST", "/api/platform/pg-meta/demo/../todo-app/query", { cookie: alice }, { query: "select 1" }));
    await deny("encoded dot-dot", raw("POST", "/api/platform/pg-meta/demo/%2e%2e/todo-app/query", { cookie: alice }, { query: "select 1" }));
    await deny("upper-case prefix", raw("POST", "/API/platform/pg-meta/todo-app/query", { cookie: alice }, { query: "select 1" }));
    await deny("page", raw("GET", "/project/todo-app/editor", { cookie: alice, accept: "text/html" }));
    await deny("auth route", raw("POST", "/api/platform/auth/todo-app/users", { cookie: alice }, { email: `x${RUN}@example.com` }));
    await deny("types", raw("GET", "/api/v1/projects/todo-app/types/typescript", { cookie: alice }));
    await deny("bob on demo", sql(bob, "demo", "select 1"));
  });

  test("5. Studio's own guard (behind Caddy) checks the signed identity", () => {
    const now = Math.floor(Date.now() / 1000);
    const sign = (user: string, role: string, apps: string, ts = now) =>
      `t=${ts},s=${createHmac("sha256", secrets.PLATFORM_STUDIO_HEADER_SECRET!).update(`${user}\n${role}\n${apps}\n${ts}`).digest("hex")}`;
    const call = (headers: Record<string, string>, ref = "todo-app") =>
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
    assert.equal(call({ ...identity("demo"), "x-platform-apps": "demo,todo-app" }), 401, "apps changed after signing");
    assert.equal(call(identity("demo", sign(users.alice.email, "developer", "demo", now - 3600))), 401, "expired");
    assert.equal(call(identity("demo")), 403, "foreign ref");
    assert.equal(call(identity("demo"), "demo"), 200, "own ref");
  });

  test("6. fork features are refused, admins included", async () => {
    for (const cookie of [alice, admin]) {
      assert.equal((await raw("POST", "/api/self-hosted/bootstrap", { cookie }, { email: "a@b.c", password: "x" })).status, 403);
      assert.equal((await raw("POST", "/api/platform/projects/import", { cookie }, { name: "x" })).status, 403);
      assert.equal((await raw("POST", "/api/platform/projects", { cookie }, { name: "x" })).status, 403);
      assert.equal((await raw("DELETE", "/api/platform/projects/demo", { cookie })).status, 403);
      assert.equal((await raw("POST", "/api/platform/projects/demo/failover", { cookie })).status, 403);
    }
  });

  test("7. the admin sees and queries every app", async () => {
    for (const ref of ["demo", "todo-app"]) {
      const reply = await sql(admin, ref, "select current_database() as d");
      assert.equal(reply.status, 200, reply.body);
      assert.deepEqual(JSON.parse(reply.body), [{ d: `app_${ref.replace("-", "_")}` }]);
    }
  });

  test("8. an auth user created from Studio lands in demo's GoTrue only", async () => {
    const email = `studio-${RUN}@example.com`;
    const created = await raw("POST", "/api/platform/auth/demo/users", { cookie: alice }, {
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
    assert.equal(find("demo")?.id, id);
    assert.equal(find("todo-app"), undefined);
    const listed = await sql(alice, "demo", `select id from auth.users where email = '${email}'`);
    assert.deepEqual(JSON.parse(listed.body), [{ id }]);

    const removed = await raw("DELETE", `/api/platform/auth/demo/users/${id}`, { cookie: alice });
    assert.equal(removed.status, 200, removed.body);
    assert.equal(find("demo"), undefined);
  });

  test("9. storage targets the project and fails cleanly (no Storage before M5)", async () => {
    const reply = await raw("GET", "/api/platform/storage/demo/buckets", { cookie: alice });
    assert.ok(reply.status >= 400 && reply.status < 600, `${reply.status} ${reply.body}`);
    assert.doesNotThrow(() => JSON.parse(reply.body));
    assert.equal((await raw("GET", "/api/platform/storage/todo-app/buckets", { cookie: alice })).status, 403);
  });

  test("10. logout ends the session", async () => {
    const out = await raw("POST", "/_platform/logout", { cookie: alice });
    assert.equal(out.status, 303);
    assert.equal((await raw("GET", "/api/platform/projects", { cookie: alice })).status, 401);
  });
});
