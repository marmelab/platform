// End-to-end test of the company SSO (M6 part 2) against the running "plat" stack and its mock OIDC provider
// (compose service idp, profile sso-test, deploy/idp/mock-idp.ts): platform login with SSO on Studio and on the admin
// console (A7), refusals (domain, unknown user, unverified email, state, nonce, signature, audience, subject), the
// password policy, and an app's users signing in with the company SSO through its GoTrue (U2, supabase-js).
// The SSO settings are snapshotted and restored at the end of the run (TECH_DEBT TT-5).
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createClient } from "@supabase/supabase-js";
import { cleanup, cli, psql, runId, waitForControlPlane } from "./disposable.ts";

const ROOT = new URL("../../../", import.meta.url);
const env = Object.fromEntries(
  readFileSync(new URL("deploy/.env.local", ROOT), "utf8").split("\n").filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const MCP_URL = env.PLATFORM_URL ?? "http://api.localhost:8100/mcp";
const STUDIO = "http://studio.localhost:8100";
const ADMIN = "http://admin.localhost:8100";
const RUN = runId();
const DOMAIN = "sso.example.com";
const APP = `e2e-${RUN}-sso`;
const APP_URL = `http://${APP}.localhost:8100`;
const BUILDER = `e2e-${RUN}-builder@${DOMAIN}`;
const ADMIN_USER = `e2e-${RUN}-admin@${DOMAIN}`;
const NEWCOMER = `e2e-${RUN}-newcomer@${DOMAIN}`;
const BUILDER_PASSWORD = "builder-password-123";
const ISSUER = "https://idp.sso.test:8443";

const SSO_CONFIG = {
  enabled: true,
  name: "Mock IdP",
  issuer: ISSUER,
  // the control plane reads it on the plat network; the apps' GoTrue use the issuer (HTTPS, plat-sso-test network)
  discovery_url: "http://idp:8090/.well-known/openid-configuration",
  client_id: "platform",
  client_secret: "platform-secret",
  allowed_domains: [DOMAIN],
  require_verified_email: true,
  auto_create: "off",
  password_login: "everyone",
};

async function adminApi(method: string, path: string, body?: unknown) {
  const response = await fetch(`${ADMIN}/api${path}`, {
    method,
    headers: { authorization: `Bearer ${env.PLATFORM_TOKEN}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : null };
}

async function connect(token: string) {
  const client = new Client({ name: "sso-e2e", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(MCP_URL), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }));
  return client;
}

type ToolResult = { isError?: boolean; content: { text: string }[] };

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const result = (await client.callTool({ name, arguments: args })) as ToolResult;
  if (result.isError) throw new Error(`${name} failed: ${result.content[0]?.text}`);
  return JSON.parse(result.content[0]!.text);
}

const get = (url: string, headers: Record<string, string> = {}) => fetch(url, { headers, redirect: "manual" });
const cookieOf = (response: Response, name: string) =>
  response.headers.getSetCookie().find((c) => c.startsWith(`${name}=`) && !c.startsWith(`${name}=;`))?.split(";")[0];

interface IdpLogin {
  email: string;
  sub?: string;
  verified?: boolean;
  tamper?: "nonce" | "aud" | "iss" | "signature" | "expired";
}

/**
 * The browser's side of an SSO login: start on the platform (pending-login cookie and redirect to the IdP), the IdP's
 * authorization endpoint (the mock signs in `email` at once), then the platform's callback with the cookie.
 */
async function ssoLogin(via: "studio" | "admin", login: IdpLogin, { state, dropCookie = false }: { state?: string; dropCookie?: boolean } = {}) {
  const start = await get(via === "studio" ? `${STUDIO}/_platform/sso/start?next=/projects` : `${ADMIN}/api/auth/sso/start`);
  assert.equal(start.status, 302, `start: ${await start.text()}`);
  const pending = cookieOf(start, "platform_sso");
  assert.ok(pending, "pending-login cookie");
  assert.match(start.headers.getSetCookie().join(), /HttpOnly/i);
  const authorize = new URL(start.headers.get("location")!);
  assert.equal(authorize.origin, "http://localhost:8090");
  assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
  assert.ok(authorize.searchParams.get("nonce"));
  authorize.searchParams.set("login_email", login.email);
  if (login.sub) authorize.searchParams.set("login_sub", login.sub);
  if (login.verified === false) authorize.searchParams.set("login_email_verified", "false");
  if (login.tamper) authorize.searchParams.set("tamper", login.tamper);
  const idp = await get(authorize.toString());
  assert.equal(idp.status, 302);
  const callback = new URL(idp.headers.get("location")!);
  if (state !== undefined) callback.searchParams.set("state", state);
  const done = await get(callback.toString(), dropCookie ? {} : { cookie: pending! });
  return { response: done, session: cookieOf(done, "platform_session"), body: await done.text() };
}

const lastAudit = (action: string, email: string) =>
  psql(`select coalesce(details->>'reason', '') || '|' || coalesce(details->>'linked', '') || '|' || coalesce(details->>'created', '')
          from audit_log where action = '${action}' and (details->>'email' = '${email}'
            or user_id = (select id from users where email = '${email}'))
         order by id desc limit 1`);

describe("M6 part 2: company SSO", () => {
  let saved = "";
  let admin: Client;
  let builder: Client;
  let builderToken = "";

  before(async () => {
    await waitForControlPlane(MCP_URL);
    saved = psql("select coalesce(json_agg(json_build_object('key', key, 'value', value)), '[]') from settings where key like 'sso\\_%'");
    const put = await adminApi("PUT", "/sso", SSO_CONFIG);
    assert.equal(put.status, 200, JSON.stringify(put.json));
    builderToken = cli(["create-user", BUILDER, "developer"]).trim();
    cli(["set-password", BUILDER], BUILDER_PASSWORD);
    cli(["create-user", ADMIN_USER, "admin"]);
    admin = await connect(env.PLATFORM_TOKEN);
    builder = await connect(builderToken);
  });

  after(async () => {
    for (const client of [admin, builder]) await client?.close();
    psql(`delete from settings where key like 'sso\\_%';
      insert into settings (key, value) select r->>'key', r->>'value' from json_array_elements('${saved.replaceAll("'", "''")}'::json) r`);
    await cleanup([APP], [BUILDER, ADMIN_USER, NEWCOMER]);
  });

  test("1. admin API: SSO settings without the secret; a wrong issuer is refused and nothing changes", async () => {
    const { status, json } = await adminApi("GET", "/sso");
    assert.equal(status, 200);
    assert.equal(json.active, true);
    assert.equal(json.client_secret_set, true);
    assert.equal(JSON.stringify(json).includes("platform-secret"), false, "the client secret is never returned");
    assert.equal(json.redirect_uris.studio, `${STUDIO}/_platform/sso/callback`);
    assert.equal(json.redirect_uris.admin, `${ADMIN}/api/auth/sso/callback`);

    const wrong = await adminApi("PUT", "/sso", { issuer: "https://idp.sso.test:8443/other" });
    assert.equal(wrong.status, 400);
    assert.match(wrong.json.message, /issuer/);
    assert.equal((await adminApi("GET", "/sso")).json.issuer, ISSUER, "settings restored after a refused change");
    assert.equal((await adminApi("PUT", "/sso", { enabled: true, client_id: "" })).status, 400);

    const builderView = await fetch(`${ADMIN}/api/sso`, { headers: { authorization: `Bearer ${builderToken}` } });
    assert.equal(builderView.status, 403, "admins only");
    const audit = psql("select details->'changes'->>'sso_client_secret' from audit_log where action = 'update_sso' order by id desc limit 1");
    assert.equal(audit, "(changed)", "the audit log does not hold the secret");
  });

  test("2. Studio: the login page offers SSO; a builder signs in with it, linked by email then by subject", async () => {
    const page = await (await get(`${STUDIO}/_platform/login`)).text();
    assert.match(page, /Sign in with Mock IdP/);
    assert.match(page, /href="\/_platform\/sso\/start\?next=/);

    const first = await ssoLogin("studio", { email: BUILDER });
    assert.equal(first.response.status, 303, first.body);
    assert.equal(first.response.headers.get("location"), "/projects");
    assert.ok(first.session, "session cookie");
    assert.equal(lastAudit("login_sso", BUILDER), "|true|false", "linked by email at the first login");
    const projects = await get(`${STUDIO}/api/platform/projects`, { cookie: first.session!, "sec-fetch-site": "same-origin" });
    assert.equal(projects.status, 200, "the SSO session opens Studio");

    const second = await ssoLogin("studio", { email: BUILDER.toUpperCase() });
    assert.equal(second.response.status, 303, second.body);
    assert.equal(lastAudit("login_sso", BUILDER), "|false|false", "found by its subject afterwards");
  });

  test("3. admin console: an admin signs in with SSO; a builder is refused", async () => {
    const options = await (await get(`${ADMIN}/api/auth/sso`)).json();
    assert.deepEqual(options, { enabled: true, name: "Mock IdP", password_login: "everyone" });

    const ok = await ssoLogin("admin", { email: ADMIN_USER });
    assert.equal(ok.response.status, 303, ok.body);
    assert.equal(ok.response.headers.get("location"), "/");
    assert.ok(ok.session);
    assert.match(ok.response.headers.getSetCookie().join(), /SameSite=Strict/i);
    const me = await get(`${ADMIN}/api/auth/me`, { cookie: ok.session!, "sec-fetch-site": "same-origin" });
    assert.equal((await me.json()).email, ADMIN_USER);

    const refused = await ssoLogin("admin", { email: BUILDER });
    assert.equal(refused.response.status, 303);
    assert.match(decodeURIComponent(refused.response.headers.get("location")!), /\?sso_error=This console is reserved to platform admins/);
    assert.equal(refused.session, undefined);
  });

  test("4. refused: wrong domain, unverified email, unknown user (JIT off), then JIT creates a developer", async () => {
    const outsider = `e2e-${RUN}@other.example.org`;
    const domain = await ssoLogin("studio", { email: outsider });
    assert.equal(domain.response.status, 403);
    assert.match(domain.body, /restricted to sso\.example\.com/);
    assert.equal(domain.session, undefined);
    assert.equal(lastAudit("login_sso_refused", outsider), "domain_not_allowed||");

    const unverified = await ssoLogin("studio", { email: BUILDER, verified: false });
    assert.equal(unverified.response.status, 403);
    assert.equal(lastAudit("login_sso_refused", BUILDER), "email_not_verified||");

    const unknown = await ssoLogin("studio", { email: NEWCOMER });
    assert.equal(unknown.response.status, 403);
    assert.match(unknown.body, /no platform account/);
    assert.equal(psql(`select count(*) from users where email = '${NEWCOMER}'`), "0");
    assert.equal(lastAudit("login_sso_refused", NEWCOMER), "unknown_user||");

    assert.equal((await adminApi("PUT", "/sso", { auto_create: "developer" })).status, 200);
    try {
      const viaAdmin = await ssoLogin("admin", { email: NEWCOMER });
      assert.match(decodeURIComponent(viaAdmin.response.headers.get("location")!), /no platform account/, "never created from the admin console");
      const created = await ssoLogin("studio", { email: NEWCOMER });
      assert.equal(created.response.status, 303, created.body);
      assert.equal(psql(`select role || ' ' || (sso_subject is not null) || ' ' || (password_hash is null) from users where email = '${NEWCOMER}'`), "developer true true");
      assert.equal(lastAudit("login_sso", NEWCOMER), "|false|true");
    } finally {
      await adminApi("PUT", "/sso", { auto_create: "off" });
    }
  });

  test("5. refused: state tampered or missing, nonce, signature, audience, issuer, expiry", async () => {
    const state = await ssoLogin("studio", { email: BUILDER }, { state: "forged-state" });
    assert.equal(state.response.status, 403);
    assert.match(state.body, /state/);
    assert.equal(state.session, undefined);

    const noCookie = await ssoLogin("studio", { email: BUILDER }, { dropCookie: true });
    assert.equal(noCookie.response.status, 403);
    assert.match(noCookie.body, /expired or was started in another browser/);

    for (const [tamper, reason] of [["nonce", "nonce_mismatch"], ["signature", "invalid_id_token"], ["aud", "invalid_id_token"],
      ["iss", "invalid_id_token"], ["expired", "invalid_id_token"]] as const) {
      const result = await ssoLogin("studio", { email: BUILDER, tamper });
      assert.equal(result.response.status, 403, `${tamper}: ${result.body}`);
      assert.equal(result.session, undefined, tamper);
      assert.equal(psql(`select details->>'reason' from audit_log where action = 'login_sso_refused' order by id desc limit 1`), reason, tamper);
    }

    // a code can only be used once: replaying the callback (with its pending-login cookie) fails
    const start = await get(`${STUDIO}/_platform/sso/start`);
    const authorize = new URL(start.headers.get("location")!);
    authorize.searchParams.set("login_email", BUILDER);
    const callback = (await get(authorize.toString())).headers.get("location")!;
    const cookie = cookieOf(start, "platform_sso")!;
    assert.equal((await get(callback, { cookie })).status, 303);
    assert.equal((await get(callback, { cookie })).status, 403);
  });

  test("6. another IdP subject for a linked email is refused until an admin unlinks the account", async () => {
    const other = await ssoLogin("studio", { email: BUILDER, sub: `someone-else-${RUN}` });
    assert.equal(other.response.status, 403);
    assert.match(other.body, /linked to another identity/);
    const id = psql(`select id from users where email = '${BUILDER}'`);
    assert.equal((await adminApi("GET", `/users/${id}`)).json.sso_linked, true);
    const unlink = await adminApi("PUT", `/users/${id}`, { sso_linked: false });
    assert.equal(unlink.json.sso_linked, false);
    const relinked = await ssoLogin("studio", { email: BUILDER, sub: `someone-else-${RUN}` });
    assert.equal(relinked.response.status, 303);
    assert.equal(psql(`select sso_subject from users where email = '${BUILDER}'`), `someone-else-${RUN}`);
    assert.equal(psql("select action from audit_log where action = 'unlink_sso' order by id desc limit 1"), "unlink_sso");
  });

  test("7. password sign-in for admins only: builders are refused, admins keep it, PATs are unaffected", async () => {
    const login = (email: string, password: string) =>
      fetch(`${STUDIO}/_platform/login`, {
        method: "POST",
        redirect: "manual",
        headers: { origin: STUDIO, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ email, password, next: "/projects" }),
      });
    assert.equal((await login(BUILDER, BUILDER_PASSWORD)).status, 303, "allowed by default");
    assert.equal((await adminApi("PUT", "/sso", { password_login: "admins" })).status, 200);
    try {
      const refused = await login(BUILDER, BUILDER_PASSWORD);
      assert.equal(refused.status, 403);
      assert.match(await refused.text(), /reserved to admins: sign in with Mock IdP/);
      assert.equal(refused.headers.getSetCookie().length, 0);
      assert.equal((await login(BUILDER, "wrong-password-123")).status, 401, "a wrong password tells nothing more");
      assert.equal((await login(env.PLATFORM_ADMIN_EMAIL, env.PLATFORM_ADMIN_PASSWORD)).status, 303, "break-glass admin password");
      assert.match(await (await get(`${STUDIO}/_platform/login`)).text(), /Password sign-in is reserved to platform admins/);
      assert.equal((await call(builder, "whoami")).email, BUILDER, "the builder's PAT still works");
    } finally {
      await adminApi("PUT", "/sso", { password_login: "everyone" });
    }
  });

  test("8. app users sign in with the company SSO (configure_auth sso, supabase-js signInWithOAuth)", async () => {
    const { anon_key: anonKey } = await call(admin, "create_app", { name: "SSO e2e", slug: APP });
    await call(admin, "add_member", { app: APP, email: BUILDER, role: "owner" });
    const configured = await call(builder, "configure_auth", { app: APP, sso: { provider: "company" } });
    assert.equal(configured.auth.sso.effective, true);
    assert.equal(configured.auth.sso.gotrue_provider, "custom:company");
    assert.equal(configured.auth.sso.callback_url, `${APP_URL}/auth/v1/callback`);
    assert.deepEqual((await call(builder, "get_app", { app: APP })).auth.sso, configured.auth.sso);
    const db = `app_${APP.replace(/-/g, "_")}`;
    assert.equal(psql("select identifier || ' ' || issuer || ' ' || client_id from auth.custom_oauth_providers", db),
      `custom:company ${ISSUER} platform`);
    assert.equal(psql(`select has_table_privilege('${db}_owner', 'auth.custom_oauth_providers', 'select')`, db), "f",
      "Studio and execute_sql (owner role) cannot read the provider's client secret");

    const storage = new Map<string, string>();
    const supabase = createClient(APP_URL, anonKey, {
      auth: {
        flowType: "pkce",
        persistSession: true,
        autoRefreshToken: false,
        storage: {
          getItem: (key: string) => storage.get(key) ?? null,
          setItem: (key: string, value: string) => void storage.set(key, value),
          removeItem: (key: string) => void storage.delete(key),
        },
      },
    });
    /** The browser: GoTrue's authorize, the IdP, then GoTrue's callback, which redirects to the app. */
    const signIn = async (email: string) => {
      const { data, error } = await supabase.auth.signInWithOAuth({
        provider: "custom:company" as never,
        options: { redirectTo: `${APP_URL}/`, skipBrowserRedirect: true },
      });
      assert.equal(error, null);
      const toIdp = await get(data.url!);
      assert.equal(toIdp.status, 302, await toIdp.text());
      const authorize = new URL(toIdp.headers.get("location")!);
      assert.equal(authorize.origin, "http://localhost:8090");
      authorize.searchParams.set("login_email", email);
      const toCallback = await get(authorize.toString());
      const callback = toCallback.headers.get("location")!;
      assert.ok(callback.startsWith(`${APP_URL}/auth/v1/callback?`), callback);
      const toApp = await get(callback);
      assert.equal(toApp.status, 302, await toApp.text());
      return new URL(toApp.headers.get("location")!);
    };

    const back = await signIn(`e2e-${RUN}-appuser@${DOMAIN}`);
    const code = back.searchParams.get("code");
    assert.ok(code, `code in ${back}`);
    const { data: session, error } = await supabase.auth.exchangeCodeForSession(code);
    assert.equal(error, null);
    assert.equal(session.user?.email, `e2e-${RUN}-appuser@${DOMAIN}`);
    assert.equal(session.user?.app_metadata.provider, "custom:company");

    // the app's allowed email domains also apply to SSO accounts (before-user-created hook)
    await call(builder, "configure_auth", { app: APP, allowed_email_domains: ["example.net"] });
    const refused = await signIn(`e2e-${RUN}-other@${DOMAIN}`);
    assert.equal(refused.searchParams.get("code"), null);
    assert.match(refused.searchParams.get("error_description") ?? "", /restricted to email addresses of: example\.net/);

    // turning the platform's SSO off removes the app's provider; configure_auth then refuses to enable it
    const off = await adminApi("PUT", "/sso", { enabled: false });
    assert.equal(off.json.apps_sync.failed.length, 0);
    assert.equal(psql("select count(*) from auth.custom_oauth_providers", db), "0");
    assert.equal((await call(builder, "get_app", { app: APP })).auth.sso.effective, false);
    const refusedOn = (await builder.callTool({ name: "configure_auth", arguments: { app: APP, sso: { provider: "company" } } })) as ToolResult;
    assert.equal(refusedOn.isError, true);
    assert.match(refusedOn.content[0]!.text, /no company SSO/);
    assert.equal((await call(builder, "configure_auth", { app: APP, sso: null })).auth.sso, null);
    assert.equal((await adminApi("PUT", "/sso", { enabled: true })).status, 200);
  });
});
