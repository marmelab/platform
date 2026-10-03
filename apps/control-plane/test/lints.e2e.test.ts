// Security linter (M7 part 2, TECH_DEBT CP-4): each rule of packages/sql/lints.sql and lints_storage.sql on a
// disposable app, through apply_migrations' dry run (the path CI and the deploy skill use), with a counterpart that must
// not be flagged; then the stored results (lint_runs): a committed batch records its lints with its release, accepted
// ERRORs are marked, a change made outside releases shows up after a run (admin API, CLI), in the apps list flags and
// on the dashboard.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { cleanup, cli, psql, runId, waitForControlPlane } from "./disposable.ts";

const ROOT = new URL("../../../", import.meta.url);
const env = Object.fromEntries(
  readFileSync(new URL("deploy/.env.local", ROOT), "utf8").split("\n").filter((line) => line.includes("="))
    .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
) as Record<string, string>;
const MCP_URL = env.PLATFORM_URL ?? "http://api.localhost:8100/mcp";
const ADMIN = new URL(MCP_URL).origin.replace("://api.", "://admin.");
const RUN = runId();
const P = `e2e-${RUN}-lint`;
const DB = `app_${P.replaceAll("-", "_")}`;
const OWNER = `${DB}_owner`;

interface Lint {
  name: string;
  level: string;
  object: string;
  detail: string;
  accepted?: boolean;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const result = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
  if (result.isError) throw new Error(`${name} failed: ${result.content[0]?.text}`);
  return JSON.parse(result.content[0]!.text);
}

async function adminApi(method: string, path: string, body?: unknown) {
  const response = await fetch(`${ADMIN}/api${path}`, {
    method,
    headers: { authorization: `Bearer ${env.PLATFORM_TOKEN}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await response.json();
  assert.equal(response.status, 200, JSON.stringify(json));
  return json;
}

const has = (lints: Lint[], name: string, object: string) => lints.some((l) => l.name === name && l.object === object);

/**
 * Objects the owner role cannot create (a foreign table needs a foreign server): created as supabase_admin in a
 * transaction, then the rules run as the owner role, then everything is rolled back.
 */
function lintsAsOwnerWith(setupSql: string): Lint[] {
  const rules = readFileSync(new URL("packages/sql/lints.sql", ROOT), "utf8");
  const out = execFileSync("docker", ["exec", "-i", "plat-db", "psql", "-U", "supabase_admin", "-d", DB, "-v", "ON_ERROR_STOP=1",
    "-At", "-F", "\t", "-q"], {
    input: `begin;\n${setupSql}\nset local role ${OWNER};\n${rules.trimEnd().replace(/;?$/, ";")}\nrollback;\n`,
    encoding: "utf8",
  });
  return out.split("\n").filter(Boolean).map((line) => {
    const [name, level, object, detail] = line.split("\t");
    return { name: name!, level: level!, object: object!, detail: detail! };
  });
}

describe("Security linter", () => {
  let admin: Client;
  let version = 20261003000000;
  /** apply_migrations dry run of one migration: every lint after it. */
  const dryRun = async (sql: string): Promise<Lint[]> => {
    const result = await call(admin, "apply_migrations", {
      app: P, dry_run: true, migrations: [{ version: String(version++), name: "probe", sql }],
    });
    assert.equal(result.status, "dry_run");
    return result.lints;
  };

  before(async () => {
    await waitForControlPlane(MCP_URL);
    admin = new Client({ name: "e2e-lints", version: "0.0.0" });
    await admin.connect(new StreamableHTTPClientTransport(new URL(MCP_URL), {
      requestInit: { headers: { Authorization: `Bearer ${env.PLATFORM_TOKEN}` } },
    }));
    await call(admin, "create_app", { name: P, slug: P });
  });

  after(async () => {
    await admin?.close();
    await cleanup([P], []);
  });

  test("1. a fresh app has no lint", async () => {
    const lints = await dryRun("select 1");
    assert.deepEqual(lints, []);
  });

  test("2. rls_disabled_in_public counts write grants too", async () => {
    const lints = await dryRun(`
      create table public.write_only (id int primary key);
      revoke select on public.write_only from anon, authenticated;
      create table public.private_table (id int primary key);
      revoke all on public.private_table from anon, authenticated;`);
    assert.ok(has(lints, "rls_disabled_in_public", "public.write_only"), JSON.stringify(lints));
    assert.ok(!has(lints, "rls_disabled_in_public", "public.private_table"));
  });

  test("3. auth_users_exposed: a view of auth.users readable through the API", async () => {
    const lints = await dryRun(`
      create view public.users_exposed as select id, email from auth.users;
      create view public.users_invoker with (security_invoker = on) as select id from auth.users;`);
    const exposed = lints.find((l) => l.name === "auth_users_exposed" && l.object === "public.users_exposed");
    assert.equal(exposed?.level, "ERROR", JSON.stringify(lints));
    // security_invoker, and auth.users has RLS on the platform (Studio's platform_owner_read policy)
    assert.ok(!has(lints, "auth_users_exposed", "public.users_invoker"));
    assert.ok(has(lints, "security_definer_view", "public.users_exposed"));
  });

  test("4. security definer functions executable by anon or authenticated", async () => {
    const lints = await dryRun(`
      create function public.sd_anon() returns int language sql security definer set search_path = '' as 'select 1';
      create function public.sd_auth() returns int language sql security definer set search_path = '' as 'select 2';
      revoke execute on function public.sd_auth() from public, anon;
      create function public.sd_none() returns int language sql security definer set search_path = '' as 'select 3';
      revoke execute on function public.sd_none() from public, anon, authenticated;
      create function public.sd_trigger() returns trigger language plpgsql security definer set search_path = ''
        as 'begin return new; end';
      create function public.invoker() returns int language sql set search_path = '' as 'select 4';`);
    assert.ok(has(lints, "anon_security_definer_function_executable", "public.sd_anon()"), JSON.stringify(lints));
    assert.ok(!has(lints, "authenticated_security_definer_function_executable", "public.sd_anon()"));
    assert.ok(has(lints, "authenticated_security_definer_function_executable", "public.sd_auth()"));
    assert.ok(!has(lints, "anon_security_definer_function_executable", "public.sd_auth()"));
    for (const fn of ["public.sd_none()", "public.sd_trigger()", "public.invoker()"]) {
      assert.ok(!lints.some((l) => l.object === fn), `${fn}: ${JSON.stringify(lints)}`);
    }
  });

  test("5. extension_in_public", async () => {
    const lints = await dryRun("create extension citext schema public; create extension hstore schema extensions;");
    assert.equal(lints.find((l) => l.name === "extension_in_public")?.object, "citext", JSON.stringify(lints));
    assert.ok(!has(lints, "extension_in_public", "hstore"));
  });

  test("6. materialized_view_in_api", async () => {
    const lints = await dryRun(`
      create materialized view public.mv_exposed as select 1 as x;
      create materialized view public.mv_private as select 1 as x;
      revoke all on public.mv_private from anon, authenticated;`);
    assert.ok(has(lints, "materialized_view_in_api", "public.mv_exposed"), JSON.stringify(lints));
    assert.ok(!has(lints, "materialized_view_in_api", "public.mv_private"));
  });

  test("7. foreign_table_in_api (foreign server created as supabase_admin)", () => {
    const lints = lintsAsOwnerWith(`
      create extension if not exists postgres_fdw schema extensions;
      create server lint_probe foreign data wrapper postgres_fdw options (dbname 'none');
      create foreign table public.ft_exposed (id int) server lint_probe;
      grant select on public.ft_exposed to anon;
      create foreign table public.ft_private (id int) server lint_probe;
      revoke all on public.ft_private from anon, authenticated;`);
    assert.ok(has(lints, "foreign_table_in_api", "public.ft_exposed"), JSON.stringify(lints));
    assert.ok(!has(lints, "foreign_table_in_api", "public.ft_private"));
  });

  test("8. rls_references_user_metadata and rls_policy_always_true", async () => {
    const lints = await dryRun(`
      create table public.docs (id int primary key, owner uuid);
      alter table public.docs enable row level security;
      create policy by_metadata on public.docs for select to authenticated
        using ((auth.jwt() -> 'user_metadata' ->> 'role') = 'admin');
      create policy by_app_metadata on public.docs for select to authenticated
        using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');
      create policy read_all on public.docs for select to anon using (true);
      create policy update_all on public.docs for update to authenticated using (true);
      create policy insert_all on public.docs for insert to authenticated with check (true);
      create policy delete_own on public.docs for delete to authenticated using (owner = auth.uid());`);
    const metadata = lints.find((l) => l.name === "rls_references_user_metadata");
    assert.equal(metadata?.object, "public.docs policy by_metadata", JSON.stringify(lints));
    assert.equal(metadata?.level, "ERROR");
    assert.equal(lints.filter((l) => l.name === "rls_references_user_metadata").length, 1);
    const alwaysTrue = lints.filter((l) => l.name === "rls_policy_always_true").map((l) => l.object).sort();
    assert.deepEqual(alwaysTrue, ["public.docs policy insert_all", "public.docs policy update_all"]);
  });

  test("9. unindexed_foreign_keys (WARN) and no_primary_key (INFO)", async () => {
    const lints = await dryRun(`
      create table public.parent (id int primary key);
      create table public.child (id int primary key, parent_id int references public.parent (id));
      create table public.child_indexed (id int primary key, parent_id int references public.parent (id));
      create index on public.child_indexed (parent_id);
      create table public.no_pk (x int);
      alter table public.child enable row level security;
      alter table public.child_indexed enable row level security;
      alter table public.parent enable row level security;
      alter table public.no_pk enable row level security;`);
    const fk = lints.find((l) => l.name === "unindexed_foreign_keys");
    assert.equal(fk?.object, "public.child child_parent_id_fkey", JSON.stringify(lints));
    assert.equal(fk?.level, "WARN");
    assert.ok(!lints.some((l) => l.name === "unindexed_foreign_keys" && l.object.startsWith("public.child_indexed")));
    assert.equal(lints.find((l) => l.name === "no_primary_key")?.object, "public.no_pk");
  });

  test("10. public_bucket_allows_listing", async () => {
    const lints = await dryRun(`
      insert into storage.buckets (id, name, public) values ('pub-list', 'pub-list', true), ('pub-ok', 'pub-ok', true),
        ('private', 'private', false);
      create policy "list pub" on storage.objects for select to public using (bucket_id = 'pub-list');
      create policy "list private" on storage.objects for select to authenticated using (bucket_id = 'private');`);
    const listing = lints.filter((l) => l.name === "public_bucket_allows_listing").map((l) => l.object);
    assert.deepEqual(listing, ["storage bucket pub-list"], JSON.stringify(lints));
  });

  test("11. results stored per release, accepted ERRORs marked, drift outside releases caught by a run", async () => {
    // a committed batch with an accepted ERROR: its lints are recorded with its release
    const applied = await call(admin, "apply_migrations", {
      app: P,
      migrations: [{
        version: "20261003100000",
        name: "notes",
        sql: `create table public.notes (id int primary key, body text);
              alter table public.notes enable row level security;
              create policy by_metadata on public.notes for select to authenticated
                using ((auth.jwt() -> 'user_metadata' ->> 'role') = 'admin');`,
      }],
      accept_lints: [{ name: "rls_references_user_metadata", object: "public.notes policy by_metadata" }],
    });
    assert.equal(applied.status, "applied");
    const stored = psql(`select r.source || ' ' || (r.release_id = '${applied.release_id}') || ' ' || r.errors
      from lint_runs r join apps a on a.id = r.app_id where a.slug = '${P}' order by r.ran_at desc limit 1`);
    assert.equal(stored, "migrations true 1");
    let lints = await adminApi("GET", `/apps/${P}/lints`);
    assert.equal(lints.latest.errors, 1);
    assert.equal(lints.latest.unaccepted_errors, 0);
    assert.equal(lints.latest.lints.find((l: Lint) => l.name === "rls_references_user_metadata")?.accepted, true);
    let app = await adminApi("GET", `/apps/${P}`);
    assert.equal(app.flags.lint_errors, 0);

    // a table without RLS created outside releases (execute_sql): seen by the next run
    await call(admin, "execute_sql", { app: P, write: true, sql: "create table public.leak (id int primary key)" });
    lints = await adminApi("POST", `/apps/${P}/lint`, {});
    assert.equal(lints.latest.source, "manual");
    assert.equal(lints.latest.unaccepted_errors, 1);
    assert.ok(lints.latest.lints.some((l: Lint) => l.name === "rls_disabled_in_public" && l.object === "public.leak" && !l.accepted));
    app = await adminApi("GET", `/apps/${P}`);
    assert.equal(app.flags.lint_errors, 1);
    const flagged = await adminApi("GET", `/apps?filter=${encodeURIComponent(JSON.stringify({ lint_errors: true }))}&range=[0,999]`);
    assert.ok(flagged.some((a: { slug: string }) => a.slug === P));
    const dashboard = await adminApi("GET", "/dashboard");
    assert.ok(dashboard.lints.apps_with_errors.some((a: { app: string; errors: number }) => a.app === P && a.errors === 1));
    assert.match(dashboard.version.version, /^\d+\.\d+\.\d+|dev$/);
    assert.equal(psql(`select count(*) from audit_log l join apps a on a.id = l.app_id where a.slug = '${P}' and l.action = 'lint_app'`), "1");

    // the CLI (deploy/upgrade.sh): a run recorded as "upgrade"
    await call(admin, "execute_sql", { app: P, write: true, sql: "alter table public.leak enable row level security" });
    const out = cli(["lint-apps", "--source", "upgrade", P]);
    assert.match(out, new RegExp(`^${P}: 1 errors \\(0 not accepted\\)`, "m"));
    lints = await adminApi("GET", `/apps/${P}/lints`);
    assert.equal(lints.latest.source, "upgrade");
    assert.ok(lints.history.length >= 3);
    app = await adminApi("GET", `/apps/${P}`);
    assert.equal(app.flags.lint_errors, 0);
  });
});
