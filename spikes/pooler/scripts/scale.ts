// Connection budget at N apps, on the running platform (deploy/install.sh): provisions N disposable apps through MCP,
// loads all of them at once (GoTrue sign-up and logins, PostgREST reads, a Storage upload, a Realtime client with a
// postgres_changes subscription and one insert), and prints the Postgres sessions by service at each phase. Works with
// or without the pooler (apps/control-plane/README.md, "Connection pooler"): with it, the pooler's own counts are printed too.
//
//   node spikes/pooler/scripts/scale.ts [N=20] [--keep] [--hold=<seconds after load, default 75>]
//
// *.localhost must resolve to 127.0.0.1 (macOS, systemd-resolved). Apps are named pl<run>-NN and deleted at the end
// (without backup) unless --keep.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(new URL("../../../apps/control-plane/package.json", import.meta.url));
const { Client } = require("@modelcontextprotocol/sdk/client/index.js") as typeof import("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = require("@modelcontextprotocol/sdk/client/streamableHttp.js") as
  typeof import("@modelcontextprotocol/sdk/client/streamableHttp.js");
const { createClient } = require("@supabase/supabase-js") as typeof import("@supabase/supabase-js");

const readEnv = (file: string) => Object.fromEntries(
  readFileSync(new URL(`../../../deploy/${file}`, import.meta.url), "utf8").split("\n").filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
) as Record<string, string>;
const local = readEnv(".env.local");
const secrets = readEnv(".env");

const args = process.argv.slice(2);
const N = Number(args.find((a) => /^\d+$/.test(a)) ?? 20);
const KEEP = args.includes("--keep");
const HOLD = Number(args.find((a) => a.startsWith("--hold="))?.slice(7) ?? 75);
const RUN = `pl${Date.now().toString(36).slice(-4)}${randomBytes(1).toString("hex")}`;
const slugs = Array.from({ length: N }, (_, i) => `${RUN}-${String(i + 1).padStart(2, "0")}`);
const url = (slug: string) => `http://${slug}.localhost:8100`;
const options = { auth: { persistSession: false, autoRefreshToken: false } };

const psql = (sql: string) => execFileSync("docker", ["exec", "plat-db", "psql", "-U", "supabase_admin", "-h", "localhost",
  "-d", "postgres", "-AtF", "\t", "-c", sql], { encoding: "utf8" }).trim();
const hasPooler = execFileSync("docker", ["ps", "-q", "-f", "name=^plat-pooler$"], { encoding: "utf8" }).trim() !== "";
const pooler = (sql: string) => execFileSync("docker", ["exec", "-e", `PGPASSWORD=${secrets.POOLER_ADMIN_PASSWORD}`,
  "plat-db", "psql", "-h", "pooler", "-p", "6432", "-U", "pooler_admin", "-d", "pgbouncer", "-AtF", "\t", "-c", sql],
{ encoding: "utf8" }).trim();

const SERVICE = `case when backend_type = 'walsender' then 'realtime (walsender)'
  when usename like 'app\\_%\\_authenticator' then 'postgrest' when usename like 'app\\_%\\_auth\\_admin' then 'gotrue'
  when usename like 'app\\_%\\_storage\\_admin' then 'storage' when usename like 'app\\_%\\_realtime' then 'realtime'
  when usename like 'app\\_%\\_owner' then 'owner' when usename = 'platform_pgrst_relay' then 'control plane (pgrst relay)'
  when usename = 'platform_pooler' then 'pooler (auth_query)'
  else coalesce(usename, '(background)') end`;

function snapshot(label: string) {
  const run = `datname like 'app\\_${RUN}\\_%'`;
  const rows = psql(`select ${SERVICE} as service, count(*) filter (where ${run}) as run_apps, count(*) as cluster
    from pg_stat_activity where pid <> pg_backend_pid() group by 1 order by 1`);
  const total = psql(`select count(*) filter (where backend_type in ('client backend', 'walsender')),
    count(*) filter (where (backend_type in ('client backend', 'walsender')) and ${run}),
    current_setting('max_connections') from pg_stat_activity where pid <> pg_backend_pid()`).split("\t");
  console.log(`\n### ${label}`);
  console.log(`client connections: ${total[0]} on the cluster (max_connections ${total[2]}), ${total[1]} to the ${N} run apps`);
  console.log("service\trun apps\tcluster");
  console.log(rows);
  const slots = psql(`select count(*), count(*) filter (where active) from pg_replication_slots`).split("\t");
  console.log(`replication slots: ${slots[0]} (${slots[1]} active)`);
  if (hasPooler) {
    // SHOW POOLS: cl_active cl_waiting ... sv_active sv_idle sv_used ...; summed over the run's databases
    const pools = pooler("show pools").split("\n").map((l) => l.split("\t"))
      .filter((c) => c[0]?.startsWith(`app_${RUN}_`));
    const sum = (i: number) => pools.reduce((s, c) => s + Number(c[i] ?? 0), 0);
    console.log(`pooler (run apps): clients active ${sum(2)} waiting ${sum(3)}; servers active ${sum(6)} idle ${sum(9)} used ${sum(10)}`);
  }
}

async function call(client: InstanceType<typeof Client>, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args }) as { isError?: boolean; content: { text: string }[] };
  if (result.isError) throw new Error(`${name}: ${result.content[0]?.text}`);
  return JSON.parse(result.content[0]!.text);
}

const MIGRATION = {
  version: "20260301000001",
  name: "items",
  sql: `create table public.items (id bigint generated always as identity primary key, body text not null);
alter table public.items enable row level security;
create policy "read" on public.items for select to anon, authenticated using (true);
alter publication supabase_realtime add table public.items;`,
};

const mcp = new Client({ name: "scale", version: "0" });
await mcp.connect(new StreamableHTTPClientTransport(new URL(local.PLATFORM_URL ?? "http://api.localhost:8100/mcp"), {
  requestInit: { headers: { Authorization: `Bearer ${local.PLATFORM_TOKEN}` } },
}));

console.log(`# scale: ${N} apps (${RUN}-NN), pooler: ${hasPooler ? "yes" : "no"}, ${new Date().toISOString()}`);
snapshot("before provisioning");
const keys = new Map<string, { anon: string; service: string }>();
const started = Date.now();
for (const slug of slugs) {
  await call(mcp, "create_app", { name: slug, slug });
  const app = await call(mcp, "get_app", { app: slug });
  await call(mcp, "apply_migrations", { app: slug, migrations: [MIGRATION] });
  const service: string = JSON.parse(execFileSync("docker", ["exec", "plat-control-plane", "node", "-e",
    `import("./src/apps.ts").then(async (m) => { const db = await import("./src/db.ts");
      const app = await db.one("select * from apps where slug = $1", ["${slug}"]);
      console.log(JSON.stringify(m.appSecrets(app).service_role_key)); process.exit(0); })`], { encoding: "utf8" }).trim());
  keys.set(slug, { anon: app.anon_key, service });
}
console.log(`\nprovisioned ${N} apps in ${Math.round((Date.now() - started) / 1000)} s`);
await new Promise((r) => setTimeout(r, 20_000));
snapshot("IDLE, 20 s after provisioning (nothing served yet)");

async function load(slug: string) {
  const { anon, service } = keys.get(slug)!;
  const base = url(slug);
  const email = `u${randomBytes(4).toString("hex")}@${slug}.test`;
  const json = { apikey: anon, "content-type": "application/json" };
  const signup = await fetch(`${base}/auth/v1/signup`, { method: "POST", headers: json,
    body: JSON.stringify({ email, password: "password-123" }) });
  if (!signup.ok) console.log(`${slug} signup: ${signup.status}`);
  await signup.body?.cancel();
  const logins = Array.from({ length: 3 }, () => fetch(`${base}/auth/v1/token?grant_type=password`, { method: "POST",
    headers: json, body: JSON.stringify({ email, password: "password-123" }) }).then((r) => r.body?.cancel()));
  let failures = 0;
  const rest = Array.from({ length: 8 }, async () => {
    for (let i = 0; i < 25; i++) {
      const r = await fetch(`${base}/rest/v1/items?select=*`, { headers: { apikey: anon } });
      if (!r.ok) failures++;
      await r.body?.cancel();
    }
  });
  const admin = createClient(base, service, options);
  const storage = (async () => {
    const bucket = await admin.storage.createBucket("scale", { public: false });
    if (bucket.error) console.log(`${slug} bucket: ${bucket.error.message}`);
    const up = await admin.storage.from("scale").upload(`f-${Date.now()}.bin`, new Blob([Buffer.alloc(100_000, 1)]));
    if (up.error) console.log(`${slug} upload: ${up.error.message}`);
    const list = await admin.storage.from("scale").list();
    if (list.error) console.log(`${slug} list: ${list.error.message}`);
  })();
  const client = createClient(base, anon, options);
  let received = 0;
  const status = await new Promise<string>((resolve) => {
    client.channel("room").on("postgres_changes", { event: "INSERT", schema: "public", table: "items" }, () => received++)
      .subscribe((s) => s !== "CLOSED" && resolve(s));
    setTimeout(() => resolve("timeout"), 20_000);
  });
  if (status !== "SUBSCRIBED") console.log(`${slug} realtime: ${status}`);
  await Promise.all([...logins, ...rest, storage]);
  if (failures) console.log(`${slug}: ${failures} REST failures`);
  return { client, received: () => received, admin };
}

const loading = Promise.all(slugs.map(load));
await new Promise((r) => setTimeout(r, 4000));
snapshot("UNDER LOAD (all apps at once, 4 s in)");
const sessions = await loading;
// one insert per app (service role through PostgREST): delivered to the app's realtime client
await Promise.all(sessions.map(({ admin }) => admin.from("items").insert({ body: "x" })));
await new Promise((r) => setTimeout(r, 3000));
const delivered = sessions.filter((s) => s.received() > 0).length;
console.log(`\npostgres_changes delivered on ${delivered}/${N} apps`);
snapshot("right after load, one realtime client per app still connected");
for (const { client } of sessions) client.removeAllChannels();
for (const { client } of sessions) client.realtime.disconnect();
await new Promise((r) => setTimeout(r, HOLD * 1000));
snapshot(`${HOLD} s after load, realtime clients gone (Realtime keeps a tenant ~12 min)`);
console.log("\n" + execFileSync("docker", ["stats", "--no-stream", "--format", "{{.Name}}\t{{.MemUsage}}",
  "plat-db", "plat-storage", "plat-realtime", ...(hasPooler ? ["plat-pooler"] : [])], { encoding: "utf8" }).trim());
await mcp.close();

if (!KEEP) {
  for (const slug of slugs) {
    execFileSync("docker", ["exec", "plat-control-plane", "node", "src/cli.ts", "delete-app", slug, "--no-backup"]);
  }
  console.log(`\ndeleted ${N} apps`);
  snapshot("after deleting the run's apps");
}
process.exit(0);
