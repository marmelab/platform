// M5 spike checks on the two spike tenants, with supabase-js through m5-caddy (http://<t>.m5.localhost:8105).
// Usage: node scripts/test.ts   (after scripts/up.sh; needs *.localhost to resolve to 127.0.0.1)
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { keys, userToken } from "./lib.ts";

// supabase-js from the control plane's dev dependencies (the spike has no package.json of its own)
const require = createRequire(new URL("../../../apps/control-plane/package.json", import.meta.url));
const { createClient } = require("@supabase/supabase-js") as typeof import("@supabase/supabase-js");

const env = Object.fromEntries(
  readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n").filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
) as Record<string, string>;

const url = (t: string) => `http://${t}.m5.localhost:8105`;
const ownerSql = (t: string, sql: string) =>
  execFileSync("docker", ["exec", "-i", "-e", `PGPASSWORD=${env[`${t}_OWNER_PASSWORD`]}`, "plat-db", "psql", "-v",
    "ON_ERROR_STOP=1", "-q", "-h", "localhost", "-U", `app_${t}_owner`, "-d", `spike_${t}`, "-Atc", sql], {
    encoding: "utf8",
  }).trim();

const SCHEMA = `
create table if not exists public.notes (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid(),
  body text not null
);
alter table public.notes enable row level security;
grant select, insert on public.notes to authenticated;
drop policy if exists own_notes on public.notes;
create policy own_notes on public.notes for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
do $$ begin
  if not exists (select from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'notes') then
    alter publication supabase_realtime add table public.notes;
  end if;
end $$;
drop policy if exists own_files_read on storage.objects;
drop policy if exists own_files_write on storage.objects;
create policy own_files_read on storage.objects for select to authenticated
  using (bucket_id = 'files' and (storage.foldername(name))[1] = auth.uid()::text);
create policy own_files_write on storage.objects for insert to authenticated
  with check (bucket_id = 'files' and (storage.foldername(name))[1] = auth.uid()::text);
`;

const tenants = ["m5a", "m5b"] as const;
const clients = (t: string, token?: string) => {
  const { anon } = keys(t, env[`${t}_JWT_SECRET`]!);
  return createClient(url(t), anon, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: token ? { headers: { Authorization: `Bearer ${token}` } } : {},
    realtime: token ? { accessToken: async () => token } : {},
  });
};

test("owner role writes storage policies and the publication", () => {
  for (const t of tenants) ownerSql(t, SCHEMA);
});

test("storage: bucket, upload, download, RLS, cross-tenant", async () => {
  for (const t of tenants) {
    const { service } = keys(t, env[`${t}_JWT_SECRET`]!);
    const admin = createClient(url(t), service, { auth: { persistSession: false } });
    const created = await admin.storage.createBucket("files", { public: false });
    assert.ok(!created.error || /already exists/i.test(created.error.message), created.error?.message);
  }
  const secretA = env.m5a_JWT_SECRET!;
  const alice = userToken(secretA);
  const bob = userToken(secretA);
  const aliceClient = clients("m5a", alice.token);
  const path = `${alice.sub}/hello.txt`;
  const up = await aliceClient.storage.from("files").upload(path, new Blob(["hello m5"]), { upsert: true });
  assert.equal(up.error, null, up.error?.message);
  const down = await aliceClient.storage.from("files").download(path);
  assert.equal(down.error, null);
  assert.equal(await down.data!.text(), "hello m5");
  // RLS: bob can neither read alice's file nor write into her folder
  const bobClient = clients("m5a", bob.token);
  const bobRead = await bobClient.storage.from("files").download(path);
  assert.ok(bobRead.error, "bob must not read alice's file");
  const bobWrite = await bobClient.storage.from("files").upload(`${alice.sub}/evil.txt`, new Blob(["x"]));
  assert.ok(bobWrite.error, "bob must not write into alice's folder");
  // anon: nothing
  const anonRead = await clients("m5a").storage.from("files").download(path);
  assert.ok(anonRead.error);
  // cross-tenant: m5b's service key and a user token of m5b are refused on m5a
  const { service: serviceB } = keys("m5b", env.m5b_JWT_SECRET!);
  const crossAdmin = createClient(url("m5a"), serviceB, { auth: { persistSession: false } });
  const crossList = await crossAdmin.storage.listBuckets();
  assert.ok(crossList.error, "m5b's service key must be refused by m5a");
  const crossUser = clients("m5a", userToken(env.m5b_JWT_SECRET!, alice.sub).token);
  const crossRead = await crossUser.storage.from("files").download(path);
  assert.ok(crossRead.error, "a token signed by m5b with alice's sub must be refused by m5a");
  // the same path on m5b does not exist (separate buckets and files)
  const onB = await createClient(url("m5b"), keys("m5b", env.m5b_JWT_SECRET!).service, { auth: { persistSession: false } })
    .storage.from("files").download(path);
  assert.ok(onB.error);
});

test("realtime: postgres_changes, broadcast, cross-tenant", async (t) => {
  const opened: ReturnType<typeof createClient>[] = [];
  t.after(() => { for (const c of opened) c.realtime.disconnect(); });
  const user = userToken(env.m5a_JWT_SECRET!);
  const client = clients("m5a", user.token);
  opened.push(client);
  await client.realtime.setAuth(user.token);
  const received: unknown[] = [];
  const broadcasts: unknown[] = [];
  const channel = client.channel("room1")
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "notes" }, (payload) => received.push(payload))
    .on("broadcast", { event: "ping" }, (payload) => broadcasts.push(payload));
  const status = await new Promise<string>((resolve) => channel.subscribe((s, err) => {
    if (s !== "CHANNEL_ERROR" || err) resolve(err ? `${s}: ${err.message}` : s);
  }));
  assert.equal(status, "SUBSCRIBED");
  // postgres_changes subscription is ready once the server confirms it (system message)
  await new Promise((r) => setTimeout(r, 2500));
  // PostgREST is not part of the spike: insert as the user through SQL
  ownerSql("m5a", `set role authenticated; select set_config('request.jwt.claims', '{"sub":"${user.sub}","role":"authenticated"}', false), set_config('request.jwt.claim.sub', '${user.sub}', false); insert into public.notes (body) values ('rt')`);
  const other = clients("m5a", user.token);
  opened.push(other);
  await other.realtime.setAuth(user.token);
  const sender = other.channel("room1");
  await new Promise<void>((resolve) => sender.subscribe((s) => s === "SUBSCRIBED" && resolve()));
  await sender.send({ type: "broadcast", event: "ping", payload: { n: 1 } });
  const deadline = Date.now() + 10_000;
  while ((received.length === 0 || broadcasts.length === 0) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.equal(received.length, 1, "postgres_changes insert not received");
  assert.equal(broadcasts.length, 1, "broadcast not received");
  await client.removeAllChannels();
  await other.removeAllChannels();

  // m5b's anon key on m5a's realtime host: refused
  const cross = createClient(url("m5a"), keys("m5b", env.m5b_JWT_SECRET!).anon, { auth: { persistSession: false } });
  opened.push(cross);
  const crossStatus = await new Promise<string>((resolve) => {
    cross.channel("room1").subscribe((s, err) => resolve(err ? `${s}: ${err.message}` : s));
    setTimeout(() => resolve("timeout"), 8000);
  });
  assert.notEqual(crossStatus, "SUBSCRIBED", `cross-tenant subscription must fail (${crossStatus})`);
  await cross.removeAllChannels();
});
