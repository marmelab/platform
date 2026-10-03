// M5 exit criterion: file upload and realtime subscription work on 2 apps, isolated from each other.
// Two disposable apps provisioned through MCP, used with supabase-js as an app's frontend would: Storage (bucket,
// policies, upload, download, RLS, cross-app keys), Realtime (postgres_changes, broadcast, cross-app keys), then stop
// (writes refused, websockets closed), start, and delete (the final backup contains the files).
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as tar from "tar";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createClient, type RealtimeChannel, type SupabaseClient } from "@supabase/supabase-js";
import { cleanup, psql, runId, waitForControlPlane } from "./disposable.ts";

const ROOT = new URL("../../../", import.meta.url);
const env = Object.fromEntries(
  readFileSync(new URL("deploy/.env.local", ROOT), "utf8")
    .split("\n")
    .filter((line) => line.includes("="))
    .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
);
const MCP_URL = env.PLATFORM_URL ?? "http://api.localhost:8100/mcp";
const RUN = runId();
const A = `e2e-${RUN}-sa`;
const B = `e2e-${RUN}-sb`;
const url = (slug: string) => `http://${slug}.localhost:8100`;
const options = { auth: { persistSession: false, autoRefreshToken: false } };

type ToolResult = { isError?: boolean; content: { type: string; text: string }[] };
async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const result = (await client.callTool({ name, arguments: args })) as ToolResult;
  const text = result.content[0]?.text ?? "";
  if (result.isError) throw new Error(`${name} failed: ${text}`);
  return JSON.parse(text);
}

const NOTES = {
  version: "20260201000001",
  name: "notes_and_files",
  sql: `
create table public.notes (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  body text not null
);
alter table public.notes enable row level security;
create policy "own notes" on public.notes for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
alter publication supabase_realtime add table public.notes;

-- private bucket, one folder per user
insert into storage.buckets (id, name, public) values ('files', 'files', false);
create policy "read own files" on storage.objects for select to authenticated
  using (bucket_id = 'files' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "write own files" on storage.objects for insert to authenticated
  with check (bucket_id = 'files' and (storage.foldername(name))[1] = auth.uid()::text);
`,
};

/**
 * Edge function using the app's service role (SUPABASE_URL is the internal gateway, http://caddy:8180/<slug>):
 * setup creates a private bucket and a file; cross calls another app's Storage with this app's service key.
 */
const SVC = `
Deno.serve(async (req) => {
  const params = new URL(req.url).searchParams;
  const base = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const headers = { apikey: key, authorization: "Bearer " + key };
  if (params.get("op") === "setup") {
    const bucket = await fetch(base + "/storage/v1/bucket", {
      method: "POST", headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ id: "files", name: "files", public: false }),
    });
    const object = await fetch(base + "/storage/v1/object/files/b-only.txt", {
      method: "POST", headers: { ...headers, "content-type": "text/plain" }, body: "app B",
    });
    const list = await fetch(base + "/storage/v1/bucket", { headers });
    return Response.json({ bucket: bucket.status, object: object.status, buckets: await list.json() });
  }
  const other = base.replace(/[^/]+$/, params.get("target"));
  const list = await fetch(other + "/storage/v1/bucket", { headers });
  const download = await fetch(other + "/storage/v1/object/files/" + params.get("path"), { headers });
  return Response.json({ list: list.status, download: download.status });
});
`;

async function deployFunction(admin: Client, slug: string) {
  const project = mkdtempSync(join(tmpdir(), "plat-m5-"));
  mkdirSync(join(project, "supabase/functions/svc"), { recursive: true });
  writeFileSync(join(project, "supabase/functions/svc/index.ts"), SVC);
  writeFileSync(join(project, "supabase/config.toml"), "[functions.svc]\nverify_jwt = false\n");
  const file = join(project, "bundle.tgz");
  await tar.c({ gzip: true, cwd: project, file, portable: true }, ["supabase"]);
  const created = await call(admin, "create_deployment", { app: slug, kind: "functions" });
  const put = await fetch(created.upload_url, { method: "PUT", body: new Blob([readFileSync(file)]) });
  assert.equal(put.status, 200, await put.text());
  await call(admin, "finalize_deployment", { deployment_id: created.deployment_id });
}

const svc = async (slug: string, query: string) => {
  const response = await fetch(`${url(slug)}/functions/v1/svc?${query}`);
  assert.equal(response.status, 200);
  return response.json() as Promise<any>;
};

async function signUp(slug: string, anonKey: string, name: string) {
  const client = createClient(url(slug), anonKey, options);
  const { data, error } = await client.auth.signUp({ email: `${name}-${RUN}@example.com`, password: "password-123" });
  assert.ifError(error);
  assert.ok(data.session && data.user);
  client.realtime.setAuth(data.session.access_token);
  return { client, id: data.user.id, token: data.session.access_token };
}

/** Subscribes and resolves with the first terminal status (SUBSCRIBED, CHANNEL_ERROR, TIMED_OUT, CLOSED). */
function subscribe(channel: RealtimeChannel, timeoutMs = 15_000) {
  return new Promise<string>((resolve) => {
    const timer = setTimeout(() => resolve("NO_ANSWER"), timeoutMs);
    channel.subscribe((status, error) => {
      clearTimeout(timer);
      resolve(error ? `${status}: ${error.message}` : status);
    });
  });
}

async function until(check: () => boolean, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
  return check();
}

describe("M5: Storage and Realtime on two apps", () => {
  let admin: Client;
  const apps: Record<string, { anon_key: string }> = {};
  const clients: SupabaseClient[] = [];
  let alice: Awaited<ReturnType<typeof signUp>>;
  let bob: Awaited<ReturnType<typeof signUp>>;
  let carol: Awaited<ReturnType<typeof signUp>>;
  const path = () => `${alice.id}/hello.txt`;

  before(async () => {
    await waitForControlPlane(MCP_URL);
    admin = new Client({ name: "e2e-m5", version: "0.0.0" });
    await admin.connect(new StreamableHTTPClientTransport(new URL(MCP_URL), {
      requestInit: { headers: { Authorization: `Bearer ${env.PLATFORM_TOKEN}` } },
    }));
  });

  after(async () => {
    for (const client of clients) client.realtime.disconnect();
    await admin?.close();
    await cleanup([A, B], []);
  });

  test("1. create two apps; get_app needs nothing new (same URL and anon key)", async () => {
    for (const slug of [A, B]) {
      const app = await call(admin, "create_app", { name: slug, slug });
      assert.equal(app.status, "running");
      assert.equal(app.supabase_url, url(slug));
      apps[slug] = app;
      // registered in both services, Storage's migrations run in the app database as the app's storage role
      assert.equal(psql(`select count(*) from tenants where id = '${slug}'`, "platform_storage"), "1");
      assert.equal(psql(`select count(*) from _realtime.tenants where external_id = '${slug}'`, "platform_realtime"), "1");
      const db = `app_${slug.replaceAll("-", "_")}`;
      assert.equal(psql("select pg_get_userbyid(relowner) from pg_class where oid = 'storage.objects'::regclass", db),
        `${db}_storage_admin`);
      assert.ok(Number(psql("select count(*) from realtime.schema_migrations", db)) > 50);
    }
  });

  test("2. bucket and storage policies by migration (app A), bucket by the service role (app B)", async () => {
    const applied = await call(admin, "apply_migrations", { app: A, migrations: [NOTES] });
    assert.deepEqual(applied.applied, [NOTES.version]);
    // the service role key never leaves the platform: B's edge function uses it (through the internal gateway)
    for (const slug of [A, B]) await deployFunction(admin, slug);
    const setup = await svc(B, "op=setup");
    assert.equal(setup.bucket, 200);
    assert.equal(setup.object, 200);
    assert.deepEqual(setup.buckets.map((b: { id: string }) => b.id), ["files"]);
  });

  test("3. upload and download as an app user, RLS denies the other user and anon", async () => {
    alice = await signUp(A, apps[A]!.anon_key, "alice");
    bob = await signUp(A, apps[A]!.anon_key, "bob");
    carol = await signUp(B, apps[B]!.anon_key, "carol");
    clients.push(alice.client, bob.client, carol.client);

    const up = await alice.client.storage.from("files").upload(path(), new Blob(["hello from alice"]), {
      contentType: "text/plain",
    });
    assert.ifError(up.error);
    const down = await alice.client.storage.from("files").download(path());
    assert.ifError(down.error);
    assert.equal(await down.data!.text(), "hello from alice");
    assert.deepEqual((await alice.client.storage.from("files").list(alice.id)).data?.map((f) => f.name), ["hello.txt"]);

    assert.ok((await bob.client.storage.from("files").download(path())).error, "bob reads alice's file");
    assert.deepEqual((await bob.client.storage.from("files").list(alice.id)).data, []);
    assert.ok((await bob.client.storage.from("files").upload(`${alice.id}/evil.txt`, new Blob(["x"]))).error,
      "bob writes into alice's folder");
    const anon = createClient(url(A), apps[A]!.anon_key, options);
    assert.ok((await anon.storage.from("files").download(path())).error, "anon reads alice's file");
  });

  test("4. cross-app isolation: the other app's keys and users are refused by Storage", async () => {
    // each app's service key on the other app's Storage (from their edge functions, through the internal gateway)
    const bOnA = await svc(B, `target=${A}&path=${path()}`);
    assert.ok(bOnA.list >= 400 && bOnA.download >= 400, `A's Storage accepts B's service key: ${JSON.stringify(bOnA)}`);
    const aOnB = await svc(A, `target=${B}&path=b-only.txt`);
    assert.ok(aOnB.list >= 400 && aOnB.download >= 400, `B's Storage accepts A's service key: ${JSON.stringify(aOnB)}`);
    const aOnA = await svc(A, `target=${A}&path=${path()}`);
    assert.deepEqual(aOnA, { list: 200, download: 200 }, "the function reads its own app's Storage");
    // B's user on A's host
    const carolOnA = createClient(url(A), apps[A]!.anon_key, {
      ...options,
      global: { headers: { Authorization: `Bearer ${carol.token}` } },
    });
    assert.ok((await carolOnA.storage.from("files").download(path())).error, "A's Storage accepts B's user token");
    // a forged X-Forwarded-Host is replaced by Caddy: the tenant always comes from the host
    const control = await fetch(`${url(B)}/storage/v1/object/list/files`, {
      method: "POST",
      headers: { apikey: apps[B]!.anon_key, authorization: `Bearer ${carol.token}`, "content-type": "application/json" },
      body: JSON.stringify({ prefix: "" }),
    });
    assert.equal(control.status, 200, "carol lists B's bucket on B's host");
    await control.body?.cancel();
    const forged = await fetch(`${url(A)}/storage/v1/object/list/files`, {
      method: "POST",
      headers: {
        apikey: apps[B]!.anon_key,
        authorization: `Bearer ${carol.token}`,
        "content-type": "application/json",
        "x-forwarded-host": B,
      },
      body: JSON.stringify({ prefix: "" }),
    });
    assert.ok(forged.status >= 400, `X-Forwarded-Host from the client selected the tenant: HTTP ${forged.status}`);
    await forged.body?.cancel();
    // the Realtime and Storage management APIs are not reachable through the app host
    for (const p of ["/realtime/v1/api/tenants", "/storage/v1/tenants", "/storage/v1/metrics", "/realtime/v1/metrics"]) {
      const response = await fetch(`${url(A)}${p}`);
      assert.ok([400, 401, 403, 404].includes(response.status), `${p}: HTTP ${response.status}`);
      await response.body?.cancel();
    }
  });

  test("5. realtime: postgres_changes insert and broadcast; the other app's key is refused", async () => {
    const changes: { new: { body?: string } }[] = [];
    const pings: unknown[] = [];
    const channel = alice.client.channel("room")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "notes" }, (p) => changes.push(p as never))
      .on("broadcast", { event: "ping" }, (p) => pings.push(p));
    assert.equal(await subscribe(channel), "SUBSCRIBED");
    // the postgres_changes subscription is ready once Realtime confirms it (system message)
    const ready = await new Promise<boolean>((resolve) => {
      channel.on("system", {}, (p: { extension?: string; status?: string }) => {
        if (p.extension === "postgres_changes") resolve(p.status === "ok");
      });
      setTimeout(() => resolve(true), 5000);
    });
    assert.ok(ready);

    const inserted = await alice.client.from("notes").insert({ body: `hi ${RUN}` }).select().single();
    assert.ifError(inserted.error);
    // bob's insert is not visible to alice (RLS applies to postgres_changes)
    assert.ifError((await bob.client.from("notes").insert({ body: "bob's" })).error);
    assert.ok(await until(() => changes.length >= 1), "postgres_changes insert not received");
    await new Promise((resolve) => setTimeout(resolve, 1000));
    assert.deepEqual(changes.map((c) => c.new.body), [`hi ${RUN}`]);

    const sender = bob.client.channel("room");
    assert.equal(await subscribe(sender), "SUBSCRIBED");
    assert.equal(await sender.send({ type: "broadcast", event: "ping", payload: { from: "bob" } }), "ok");
    assert.ok(await until(() => pings.length === 1), "broadcast not received");
    await alice.client.removeChannel(channel);
    await bob.client.removeChannel(sender);

    // B's anon key and B's user on A's realtime: refused (JWT signed with another secret)
    const crossAnon = createClient(url(A), apps[B]!.anon_key, options);
    clients.push(crossAnon);
    const anonStatus = await subscribe(crossAnon.channel("room"), 8000);
    // the websocket itself is refused (apikey checked at connection)
    assert.match(anonStatus, /^CHANNEL_ERROR/);
    const crossUser = createClient(url(A), apps[A]!.anon_key, options);
    clients.push(crossUser);
    crossUser.realtime.setAuth(carol.token);
    const userStatus = await subscribe(crossUser.channel("room"), 8000);
    assert.match(userStatus, /^CHANNEL_ERROR: JwtSignatureError/);
  });

  test("5b. broadcast from database works on both apps at once (patched Realtime: a slot per tenant)", async () => {
    const dbs = [A, B].map((slug) => `app_${slug.replaceAll("-", "_")}`);
    const received: Record<string, unknown[]> = { [A]: [], [B]: [] };
    const channels: [SupabaseClient, RealtimeChannel][] = [];
    for (const [slug, user] of [[A, alice], [B, carol]] as const) {
      const channel = user.client.channel(`db-${RUN}`)
        .on("broadcast", { event: "changed" }, (p) => received[slug]!.push(p.payload));
      assert.equal(await subscribe(channel), "SUBSCRIBED");
      channels.push([user.client, channel]);
    }
    // each tenant streams realtime.messages through its own walsender and temporary slot
    const slots = () => psql(`select string_agg(s.slot_name, ' ' order by d.datname) from pg_replication_slots s
      join pg_database d on d.oid = s.datoid where s.active and s.slot_name like 'supabase_realtime_messages_replication_slot_%'
      and d.datname in ('${dbs[0]}', '${dbs[1]}')`, "postgres").split(" ").filter(Boolean);
    assert.ok(await until(() => slots().length === 2, 30_000), `broadcast changes slots: ${slots().join(", ")}`);
    assert.notEqual(slots()[0], slots()[1]);

    for (const [slug, db] of [[A, dbs[0]], [B, dbs[1]]] as const) {
      psql(`select realtime.send(jsonb_build_object('app', '${slug}'), 'changed', 'db-${RUN}', false)`, db);
    }
    assert.ok(await until(() => received[A]!.length > 0 && received[B]!.length > 0, 15_000),
      `broadcast from database: A ${received[A]!.length}, B ${received[B]!.length}`);
    // each app gets its own message only (Realtime adds the message id)
    assert.deepEqual(received[A]!.map((p) => (p as { app: string }).app), [A]);
    assert.deepEqual(received[B]!.map((p) => (p as { app: string }).app), [B]);
    for (const [client, channel] of channels) await client.removeChannel(channel);
  });

  test("6. stop: uploads refused, realtime closed; start: back", async () => {
    const statuses: string[] = [];
    const channel = alice.client.channel("watch");
    channel.subscribe((status) => statuses.push(status));
    assert.ok(await until(() => statuses.includes("SUBSCRIBED")));

    await call(admin, "stop_app", { app: A });
    const refused = await alice.client.storage.from("files").upload(`${alice.id}/after-stop.txt`, new Blob(["x"]));
    assert.ok(refused.error, "upload accepted on a stopped app");
    const raw = await fetch(`${url(A)}/storage/v1/object/files/${alice.id}/x.txt`, {
      method: "POST",
      headers: { apikey: apps[A]!.anon_key, authorization: `Bearer ${alice.token}` },
      body: "x",
    });
    assert.equal(raw.status, 503);
    assert.equal((await raw.json()).code, "APP_STOPPED");
    assert.ok(await until(() => statuses.some((s) => s !== "SUBSCRIBED"), 15_000), `realtime still open: ${statuses}`);
    const ws = await fetch(`${url(A)}/realtime/v1/websocket?apikey=${apps[A]!.anon_key}&vsn=1.0.0`);
    assert.equal(ws.status, 503);
    await ws.body?.cancel();
    await alice.client.removeChannel(channel);
    // app B is not affected
    const onB = await carol.client.storage.from("files").list();
    assert.ifError(onB.error);

    await call(admin, "start_app", { app: A });
    const down = await alice.client.storage.from("files").download(path());
    assert.ifError(down.error);
    assert.equal(await down.data!.text(), "hello from alice");
    const again = alice.client.channel("again");
    assert.equal(await subscribe(again), "SUBSCRIBED");
    await alice.client.removeChannel(again);
  });

  test("7. delete: the final backup contains the files; tenants and files are gone", async () => {
    for (const client of clients) client.realtime.disconnect();
    const deleted = await call(admin, "delete_app", { app: A, confirm: A });
    const inCp = (...args: string[]) => execFileSync("docker", ["exec", "plat-control-plane", ...args]).toString();
    assert.ok(inCp("ls", deleted.backup).split("\n").includes("storage.tar.gz"));
    const listing = inCp("tar", "-tzf", `${deleted.backup}/storage.tar.gz`);
    assert.match(listing, new RegExp(`^${A}/files/${alice.id}/hello.txt/`, "m"));
    const manifest = JSON.parse(inCp("cat", `${deleted.backup}/manifest.json`));
    assert.ok(manifest.files["storage.tar.gz"] > 0);
    const dump = execFileSync("docker", ["exec", "plat-control-plane", "cat", `${deleted.backup}/database.dump`]);
    const restore = execFileSync("docker", ["exec", "-i", "plat-db", "pg_restore", "--list"], { input: dump, encoding: "utf8" });
    assert.match(restore, /TABLE DATA storage objects /);
    assert.equal(psql(`select count(*) from tenants where id = '${A}'`, "platform_storage"), "0");
    assert.equal(psql(`select count(*) from _realtime.tenants where external_id = '${A}'`, "platform_realtime"), "0");
    // the postgres_changes slot (realtime_<id>_) and the broadcast changes slot went with the app's sessions
    assert.equal(psql(`select count(*) from pg_replication_slots where slot_name like 'realtime_${A.replaceAll("-", "_")}%'
      or datoid not in (select oid from pg_database)`, "postgres"), "0");
    // B still works
    assert.ifError((await carol.client.storage.from("files").list()).error);
    inCp("rm", "-rf", deleted.backup);
  });
});
