// Connection pooler (README.md, "Connection pooler"): PostgREST and Storage reach the app database through PgBouncer in
// transaction mode, only the pooled app roles can log in through it, PostgREST's schema cache follows DDL made outside
// migrations (relay of the "pgrst" notifications), stop/start's read-only default applies to pooled connections, and
// delete_app removes the app's pooler entry.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createClient } from "@supabase/supabase-js";
import { cleanup, psql, runId, waitForControlPlane } from "./disposable.ts";

const ROOT = new URL("../../../", import.meta.url);
const readEnv = (file: string) => Object.fromEntries(
  readFileSync(new URL(file, ROOT), "utf8").split("\n").filter((line) => line.includes("="))
    .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
) as Record<string, string>;
const env = readEnv("deploy/.env.local");
const secrets = readEnv("deploy/.env");
const MCP_URL = env.PLATFORM_URL ?? "http://api.localhost:8100/mcp";
const RUN = runId();
const P = `e2e-${RUN}-pool`;
const DB = `app_${P.replaceAll("-", "_")}`;
const url = `http://${P}.localhost:8100`;
const options = { auth: { persistSession: false, autoRefreshToken: false } };

type ToolResult = { isError?: boolean; content: { type: string; text: string }[] };
async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const result = (await client.callTool({ name, arguments: args })) as ToolResult;
  const text = result.content[0]?.text ?? "";
  if (result.isError) throw new Error(`${name} failed: ${text}`);
  return JSON.parse(text);
}

/** psql through the pooler (from the db container, on the platform network). Throws on a refused login. */
const viaPooler = (user: string, password: string, database: string, sql: string) =>
  execFileSync("docker", ["exec", "-e", `PGPASSWORD=${password}`, "plat-db", "psql", "-h", "pooler", "-p", "6432",
    "-U", user, "-d", database, "-tAc", sql], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const poolerAdmin = (sql: string) => viaPooler("pooler_admin", secrets.POOLER_ADMIN_PASSWORD!, "pgbouncer", sql);

/** The app's role passwords, as the control plane stores them (encrypted in the platform database). */
const appPasswords = (slug: string): Record<string, string> => JSON.parse(execFileSync("docker", ["exec",
  "plat-control-plane", "node", "--input-type=module", "-e",
  `import { one } from "./src/db.ts"; import { appSecrets } from "./src/apps.ts";
   const app = await one("select * from apps where slug = $1", [${JSON.stringify(slug)}]);
   console.log(JSON.stringify(appSecrets(app).passwords)); process.exit(0);`], { encoding: "utf8" }));

async function until(check: () => boolean | Promise<boolean>, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return check();
}

describe("Connection pooler", () => {
  let admin: Client;
  let anonKey: string;
  let passwords: Record<string, string>;

  before(async () => {
    await waitForControlPlane(MCP_URL);
    admin = new Client({ name: "e2e-pooler", version: "0.0.0" });
    await admin.connect(new StreamableHTTPClientTransport(new URL(MCP_URL), {
      requestInit: { headers: { Authorization: `Bearer ${env.PLATFORM_TOKEN}` } },
    }));
  });

  after(async () => {
    await admin?.close();
    await cleanup([P], []);
  });

  test("1. create_app adds a pooler entry; PostgREST and Storage connect through the pooler", async () => {
    const app = await call(admin, "create_app", { name: P, slug: P });
    anonKey = app.anon_key;
    passwords = appPasswords(P);
    assert.match(poolerAdmin("show databases"), new RegExp(`^${DB}\\|db\\|5432\\|${DB}\\|`, "m"));

    const rest = await fetch(`${url}/rest/v1/`, { headers: { apikey: anonKey } });
    assert.equal(rest.status, 200);
    await rest.body?.cancel();
    const buckets = await createClient(url, anonKey, options).storage.listBuckets();
    assert.ifError(buckets.error);
    // PostgREST's sessions all come from the pooler's address; Storage's requests too (its migrations, run when the
    // tenant is registered, use a direct connection)
    const poolerIp = execFileSync("docker", ["inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}",
      "plat-pooler"], { encoding: "utf8" }).trim();
    const from = (role: string) => psql(`select string_agg(distinct host(client_addr), ',') from pg_stat_activity
      where datname = '${DB}' and usename = '${DB}_${role}'`, "postgres").split(",");
    assert.deepEqual(from("authenticator"), [poolerIp]);
    assert.ok(from("storage_admin").includes(poolerIp), `storage sessions from ${from("storage_admin")}`);
  });

  test("2. only the pooled app roles log in through the pooler", () => {
    assert.equal(viaPooler(`${DB}_authenticator`, passwords.authenticator!, DB, "select current_user"),
      `${DB}_authenticator`);
    assert.equal(viaPooler(`${DB}_storage_admin`, passwords.storageAdmin!, DB, "select current_user"),
      `${DB}_storage_admin`);
    for (const [user, password] of [[`${DB}_owner`, passwords.owner!], [`${DB}_realtime`, passwords.realtime!],
      ["supabase_admin", secrets.POSTGRES_PASSWORD!]]) {
      assert.throws(() => viaPooler(user!, password!, DB, "select 1"), /authentication failed|password/i, user);
    }
    // a wrong password is refused too
    assert.throws(() => viaPooler(`${DB}_authenticator`, "0".repeat(32), DB, "select 1"), /authentication failed/);
  });

  test("3. DDL outside migrations reaches PostgREST's schema cache (pgrst relay)", async () => {
    const get = () => fetch(`${url}/rest/v1/pooled_notes?select=*`, { headers: { apikey: anonKey } })
      .then(async (r) => (await r.body?.cancel(), r.status));
    assert.equal(await get(), 404);
    await call(admin, "execute_sql", {
      app: P,
      write: true,
      sql: `create table public.pooled_notes (id int primary key);
        alter table public.pooled_notes enable row level security;
        create policy "read" on public.pooled_notes for select to anon using (true)`,
    });
    assert.ok(await until(async () => (await get()) === 200), "PostgREST did not reload its schema cache");
  });

  test("4. stop: pooled sessions are read-only; start: read-write again", async () => {
    const readOnly = () =>
      viaPooler(`${DB}_authenticator`, passwords.authenticator!, DB, "show default_transaction_read_only");
    assert.equal(readOnly(), "off");
    await call(admin, "stop_app", { app: P });
    // the pooler's server connections opened before the stop were terminated: the new ones get the database default
    assert.equal(readOnly(), "on");
    assert.throws(() => viaPooler(`${DB}_authenticator`, passwords.authenticator!, DB,
      "create temporary table t (id int)"), /read-only transaction/);
    await call(admin, "start_app", { app: P });
    // and the ones opened while stopped are terminated on start
    assert.equal(readOnly(), "off");
    const rest = await fetch(`${url}/rest/v1/pooled_notes?select=*`, { headers: { apikey: anonKey } });
    assert.equal(rest.status, 200);
    await rest.body?.cancel();
  });

  test("5. delete_app removes the pooler entry", async () => {
    await call(admin, "delete_app", { app: P, confirm: P, backup: false });
    assert.doesNotMatch(poolerAdmin("show databases"), new RegExp(`^${DB}\\|`, "m"));
    const entries = execFileSync("docker", ["exec", "plat-control-plane", "cat", "/data/pooler/databases.ini"],
      { encoding: "utf8" });
    assert.ok(!entries.includes(DB));
  });
});
