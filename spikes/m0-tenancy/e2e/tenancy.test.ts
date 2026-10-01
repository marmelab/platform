import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import pg from "pg";

const ROOT = new URL("..", import.meta.url);
const PG_PORT = 54320;

type App = {
  id: string;
  url: string;
  database: string;
  anonKey: string;
  serviceRoleKey: string;
  authenticatorPassword: string;
  authAdminPassword: string;
};

const readEnv = (path: string): Record<string, string> =>
  Object.fromEntries(
    readFileSync(new URL(path, ROOT), "utf8")
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );

const loadApp = (id: string): App => {
  const env = readEnv(`apps/${id}/.env`);
  return {
    id,
    url: `http://${id}.localhost:8080`,
    database: `app_${id}`,
    anonKey: env.ANON_KEY,
    serviceRoleKey: env.SERVICE_ROLE_KEY,
    authenticatorPassword: env.AUTHENTICATOR_PASSWORD,
    authAdminPassword: env.AUTH_ADMIN_PASSWORD,
  };
};

const postgresPassword = readEnv(".env").POSTGRES_PASSWORD;
const app1 = loadApp("app1");
const app2 = loadApp("app2");

const client = (app: App, key = app.anonKey) =>
  createClient(app.url, key, { auth: { persistSession: false, autoRefreshToken: false } });

const connect = async (user: string, password: string, database: string) => {
  const c = new pg.Client({ host: "127.0.0.1", port: PG_PORT, user, password, database });
  await c.connect();
  return c;
};

const connectError = async (user: string, password: string, database: string) => {
  try {
    const c = await connect(user, password, database);
    await c.end();
    return undefined;
  } catch (error) {
    return error as Error & { code?: string };
  }
};

const MIGRATION_VERSION = "20261001000000";

// Same contract as the future apply_migrations: run once, tracked in the CLI table.
const applyDemoMigration = async (app: App) => {
  const c = await connect("postgres", postgresPassword, app.database);
  try {
    const sql = readFileSync(new URL("sql/demo-todos.sql", ROOT), "utf8");
    await c.query("begin");
    const done = await c.query("select 1 from supabase_migrations.schema_migrations where version = $1", [
      MIGRATION_VERSION,
    ]);
    if (done.rowCount === 0) {
      await c.query(sql);
      await c.query(
        "insert into supabase_migrations.schema_migrations (version, name, statements) values ($1, $2, $3)",
        [MIGRATION_VERSION, "demo_todos", [sql]],
      );
    }
    await c.query("commit");
  } catch (error) {
    await c.query("rollback");
    throw error;
  } finally {
    await c.end();
  }
};

const waitForTable = async (supabase: SupabaseClient) => {
  for (let i = 0; i < 50; i++) {
    const { error } = await supabase.from("todos").select("id").limit(1);
    if (!error) return i;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("todos never appeared in the PostgREST schema cache");
};

const run = Date.now();
const credentials = (app: App, who: string) => ({ email: `${who}-${run}@${app.id}.test`, password: `pw-${run}-${who}!` });

type Session = { client: SupabaseClient; accessToken: string; userId: string };

const signUpAndLogin = async (app: App, who: string): Promise<Session> => {
  const creds = credentials(app, who);
  const signUp = await client(app).auth.signUp(creds);
  assert.ifError(signUp.error);
  assert.ok(signUp.data.session, "autoconfirm should return a session on signup");

  const supabase = client(app);
  const login = await supabase.auth.signInWithPassword(creds);
  assert.ifError(login.error);
  assert.ok(login.data.session);
  return { client: supabase, accessToken: login.data.session.access_token, userId: login.data.user.id };
};

const rawRest = (app: App, path: string, token: string, apikey = app.anonKey) =>
  fetch(`${app.url}/rest/v1/${path}`, { headers: { apikey, Authorization: `Bearer ${token}` } });

describe("M0 tenancy", () => {
  let alice: Session; // app1
  let bob: Session; // app1
  let carol: Session; // app2

  before(async () => {
    await applyDemoMigration(app1);
    await applyDemoMigration(app2);
    for (const app of [app1, app2]) {
      const polls = await waitForTable(client(app));
      console.log(`[${app.id}] todos visible in schema cache after ${polls} retries (auto reload via pgrst NOTIFY)`);
    }
  });

  test("same-origin routing: static site, /auth/v1 and /rest/v1 on each app host", async () => {
    for (const app of [app1, app2]) {
      const page = await fetch(`${app.url}/some/spa/route`);
      assert.equal(page.status, 200);
      assert.match(await page.text(), new RegExp(`<h1>${app.id}</h1>`));

      const health = await fetch(`${app.url}/auth/v1/health`);
      assert.equal(health.status, 200);

      const rest = await fetch(`${app.url}/rest/v1/`, { headers: { apikey: app.anonKey } });
      assert.equal(rest.status, 200);
    }
  });

  test("signup + login on both apps", async () => {
    alice = await signUpAndLogin(app1, "alice");
    bob = await signUpAndLogin(app1, "bob");
    carol = await signUpAndLogin(app2, "carol");
  });

  test("CRUD under RLS", async () => {
    const insert = await alice.client.from("todos").insert({ title: "alice todo" }).select().single();
    assert.ifError(insert.error);
    assert.equal(insert.data.user_id, alice.userId);

    const update = await alice.client.from("todos").update({ done: true }).eq("id", insert.data.id).select().single();
    assert.ifError(update.error);
    assert.equal(update.data.done, true);

    const mine = await alice.client.from("todos").select();
    assert.ifError(mine.error);
    assert.deepEqual(
      mine.data.map((t) => t.title),
      ["alice todo"],
    );

    const bobView = await bob.client.from("todos").select();
    assert.ifError(bobView.error);
    assert.equal(bobView.data.length, 0, "bob must not see alice's todos");

    const bobUpdate = await bob.client.from("todos").update({ title: "hacked" }).eq("id", insert.data.id).select();
    assert.equal(bobUpdate.data?.length ?? 0, 0, "bob cannot update alice's todo");

    const spoof = await bob.client.from("todos").insert({ title: "spoof", user_id: alice.userId });
    assert.equal(spoof.error?.code, "42501", "RLS with check must reject spoofed user_id");

    const anon = await client(app1).from("todos").select();
    assert.ifError(anon.error);
    assert.equal(anon.data.length, 0);

    const anonInsert = await client(app1).from("todos").insert({ title: "anon" });
    assert.ok(anonInsert.error, "anon insert must fail");

    const carolInsert = await carol.client.from("todos").insert({ title: "carol todo" }).select().single();
    assert.ifError(carolInsert.error);

    const del = await alice.client.from("todos").delete().eq("id", insert.data.id).select();
    assert.ifError(del.error);
    assert.equal(del.data.length, 1);
    await alice.client.from("todos").insert({ title: "alice keeps this one" });
  });

  test("app1 data is invisible from app2 (and vice versa) even with service_role", async () => {
    const admin1 = client(app1, app1.serviceRoleKey);
    const admin2 = client(app2, app2.serviceRoleKey);

    const todos1 = await admin1.from("todos").select("title");
    assert.ifError(todos1.error);
    assert.ok(todos1.data.every((t) => !t.title.startsWith("carol")));

    const todos2 = await admin2.from("todos").select("title");
    assert.ifError(todos2.error);
    assert.ok(todos2.data.every((t) => !t.title.startsWith("alice")));

    const users1 = await admin1.auth.admin.listUsers();
    assert.ifError(users1.error);
    const emails1 = users1.data.users.map((u) => u.email);
    assert.ok(emails1.includes(credentials(app1, "alice").email));
    assert.ok(!emails1.includes(credentials(app2, "carol").email));

    const crossLogin = await client(app2).auth.signInWithPassword(credentials(app1, "alice"));
    assert.ok(crossLogin.error, "alice (app1) cannot log into app2");
  });

  test("app1 JWTs are rejected by app2", async () => {
    const userToken = await rawRest(app2, "todos?select=*", alice.accessToken, app2.anonKey);
    assert.equal(userToken.status, 401);
    const body = await userToken.json();
    console.log(`[app2] PostgREST with app1 user JWT -> ${userToken.status} ${body.code} ${body.message}`);

    const anonKey = await rawRest(app2, "todos?select=*", app1.anonKey, app1.anonKey);
    assert.equal(anonKey.status, 401);

    const serviceKey = await rawRest(app2, "todos?select=*", app1.serviceRoleKey, app1.serviceRoleKey);
    assert.equal(serviceKey.status, 401);

    const user = await client(app2).auth.getUser(alice.accessToken);
    assert.ok(user.error, "GoTrue app2 must reject a token signed by app1");
    console.log(`[app2] GoTrue /user with app1 JWT -> ${user.error.status} ${user.error.message}`);

    const adminUsers = await client(app2, app1.serviceRoleKey).auth.admin.listUsers();
    assert.ok(adminUsers.error, "GoTrue app2 admin API must reject app1 service_role");
  });

  describe("per-app Postgres LOGIN roles", () => {
    const opened: pg.Client[] = [];
    after(async () => Promise.all(opened.map((c) => c.end())));

    test("each role connects to its own database only", async () => {
      opened.push(await connect("app_app1_authenticator", app1.authenticatorPassword, "app_app1"));
      opened.push(await connect("app_app1_auth_admin", app1.authAdminPassword, "app_app1"));

      const denied = [
        ["app_app1_authenticator", app1.authenticatorPassword, "app_app2"],
        ["app_app1_auth_admin", app1.authAdminPassword, "app_app2"],
        ["app_app2_authenticator", app2.authenticatorPassword, "app_app1"],
        ["app_app1_authenticator", app1.authenticatorPassword, "postgres"],
        ["app_app1_authenticator", app1.authenticatorPassword, "template1"],
      ];
      for (const [user, password, database] of denied) {
        const error = await connectError(user, password, database);
        assert.ok(error, `${user} must not connect to ${database}`);
        assert.equal(error.code, "42501", `${user} -> ${database}: ${error.message}`);
      }
      const templateError = await connectError("app_app1_authenticator", app1.authenticatorPassword, "template_supabase");
      assert.ok(templateError, "template_supabase must not accept connections");
    });

    test("authenticator can only switch to the API roles", async () => {
      const c = await connect("app_app1_authenticator", app1.authenticatorPassword, "app_app1");
      opened.push(c);
      await c.query("set role authenticated");
      await c.query("reset role");
      await assert.rejects(c.query("set role postgres"), /permission denied/);
      await assert.rejects(c.query("set role app_app2_authenticator"), /permission denied/);
      await assert.rejects(c.query("select * from auth.users"), /permission denied/);
    });
  });
});
