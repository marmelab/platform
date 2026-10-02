// Holds one realtime client per tenant (postgres_changes + broadcast subscription) for N seconds, then prints the
// replication slots, the Postgres sessions of the services and the containers' memory.
// Usage: node scripts/hold.ts <seconds> m5a m5b ...
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { keys, userToken } from "./lib.ts";

const require = createRequire(new URL("../../../apps/control-plane/package.json", import.meta.url));
const { createClient } = require("@supabase/supabase-js") as typeof import("@supabase/supabase-js");
const env = Object.fromEntries(
  readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n").filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
) as Record<string, string>;
const [seconds, ...tenants] = process.argv.slice(2);
const clients = [];
// storage traffic first: one bucket and a 100 KB upload per tenant, then a download
for (const t of tenants) {
  const admin = createClient(`http://${t}.m5.localhost:8105`, keys(t, env[`${t}_JWT_SECRET`]!).service, {
    auth: { persistSession: false },
  });
  await admin.storage.createBucket("scale", { public: false });
  const up = await admin.storage.from("scale").upload(`f-${Date.now()}.bin`, new Blob([Buffer.alloc(100_000, 1)]));
  if (up.error) console.log(`${t} upload: ${up.error.message}`);
  const list = await admin.storage.from("scale").list();
  if (list.error) console.log(`${t} list: ${list.error.message}`);
}
for (const t of tenants) {
  const user = userToken(env[`${t}_JWT_SECRET`]!);
  const client = createClient(`http://${t}.m5.localhost:8105`, keys(t, env[`${t}_JWT_SECRET`]!).anon, {
    auth: { persistSession: false },
    realtime: { accessToken: async () => user.token },
  });
  await client.realtime.setAuth(user.token);
  const status = await new Promise<string>((resolve) => {
    client.channel("room").on("postgres_changes", { event: "*", schema: "public" }, () => {})
      .on("broadcast", { event: "x" }, () => {}).subscribe((s, e) => (s !== "CHANNEL_ERROR" || e) && resolve(s));
    setTimeout(() => resolve("timeout"), 15000);
  });
  if (status !== "SUBSCRIBED") console.log(`${t}: ${status}`);
  clients.push(client);
}
await new Promise((r) => setTimeout(r, Number(seconds) * 1000));
const psql = (sql: string) => execFileSync("docker", ["exec", "plat-db", "psql", "-U", "supabase_admin", "-h", "localhost",
  "-d", "postgres", "-Atc", sql], { encoding: "utf8" }).trim();
console.log("slots:", psql("select count(*), count(*) filter (where active), string_agg(slot_name, ' ' order by slot_name) from pg_replication_slots"));
console.log("wal senders:", psql("select count(*) from pg_stat_replication"));
console.log("sessions by service:\n" + psql(`select case when usename like 'app_%_realtime' then 'realtime (tenants)'
  when usename like 'app_%_storage_admin' then 'storage (tenants)' else usename end, application_name, count(*)
  from pg_stat_activity where usename like 'app_%_realtime' or usename like 'app_%_storage_admin' or usename like 'spike_%'
  group by 1, 2 order by 1, 2`));
console.log(execFileSync("docker", ["stats", "--no-stream", "--format", "{{.Name}} {{.MemUsage}} {{.CPUPerc}}", "m5-storage",
  "m5-realtime"], { encoding: "utf8" }).trim());
for (const c of clients) c.realtime.disconnect();
