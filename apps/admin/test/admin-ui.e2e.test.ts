// Smoke test of the admin SPA (admin.localhost:8100) in Chromium (Playwright), against the running "plat" stack.
// Disposable resources: one builder (created through the admin API) and its app (created through MCP), deleted at the
// end of the run. SCREENSHOTS=1 also saves the main screens into apps/admin/screenshots/.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { cleanup, psql, runId, waitForControlPlane } from "../../control-plane/test/disposable.ts";

const ROOT = new URL("../../../", import.meta.url);
const env = Object.fromEntries(
  readFileSync(new URL("deploy/.env.local", ROOT), "utf8").split("\n").filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const MCP_URL = env.PLATFORM_URL ?? "http://api.localhost:8100/mcp";
const ADMIN = "http://admin.localhost:8100";
const ID = runId();
const APP = `e2e-${ID}-ui`;
const BUILDER = `e2e-${ID}-ui@example.com`;
const SCREENSHOTS = process.env.SCREENSHOTS === "1" ? new URL("../screenshots/", import.meta.url) : null;

async function api(method: string, path: string, body?: unknown) {
  const response = await fetch(`${ADMIN}/api${path}`, {
    method,
    headers: { authorization: `Bearer ${env.PLATFORM_TOKEN}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await response.json();
  assert.ok(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(json)}`);
  return json;
}

async function mcp(token: string, calls: [string, Record<string, unknown>][]) {
  const client = new Client({ name: "admin-ui-e2e", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(MCP_URL), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }));
  const results: any[] = [];
  try {
    for (const [name, args] of calls) {
      const result = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
      if (result.isError) throw new Error(`${name}: ${result.content[0]?.text}`);
      results.push(JSON.parse(result.content[0]!.text));
    }
  } finally {
    await client.close();
  }
  return results;
}

async function shot(page: Page, name: string, fullPage = false) {
  if (!SCREENSHOTS) return;
  mkdirSync(SCREENSHOTS, { recursive: true });
  // notifications of earlier actions would hide part of the screen: hidden, not removed (React still owns the nodes,
  // and removing them made the next re-render of the toaster crash the page)
  await page.evaluate(() =>
    document.querySelectorAll<HTMLElement>("[data-sonner-toast]").forEach((t) => (t.style.visibility = "hidden")));
  await page.waitForTimeout(300);
  await page.screenshot({ path: new URL(`${name}.png`, SCREENSHOTS).pathname, fullPage });
}

describe("admin SPA smoke test", () => {
  let browser: Browser;
  let page: Page;

  before(async () => {
    await waitForControlPlane(MCP_URL);
    assert.ok(env.PLATFORM_ADMIN_PASSWORD, "PLATFORM_ADMIN_PASSWORD in deploy/.env.local (install.sh)");
    const user = await api("POST", "/users", { email: BUILDER, name: "UI Builder", role: "developer" });
    const { token } = await api("POST", "/tokens", { user_id: user.id, name: "ui-e2e" });
    const [, release] = await mcp(token, [
      ["create_app", { name: "Admin UI demo", slug: APP }],
      ["begin_release", { app: APP, commit_sha: "b".repeat(40), reason: "ui e2e" }],
    ]);
    await mcp(token, [
      ["finish_release", { release_id: release.release_id, status: "succeeded" }],
      ["set_secrets", { app: APP, secrets: { STRIPE_KEY: "secret-value" } }],
    ]);
    // load: 12 real requests to the app's host, counted from Caddy's access log by a forced sample, on top of a
    // synthetic history of the past 7 days (hourly rows written directly, so that the charts have something to show)
    psql(`insert into app_metrics (app_id, hour, requests, responses_5xx)
      select a.id, h, (40 + 30 * sin(extract(epoch from h) / 20000))::int, (case when extract(hour from h) = 14 then 3 else 0 end)
        from apps a, generate_series(date_trunc('hour', now()) - interval '167 hours', date_trunc('hour', now()) - interval '1 hour',
          interval '1 hour') h
       where a.slug = '${APP}'`);
    for (let i = 0; i < 12; i++) await (await fetch(`http://${APP}.localhost:8100/`)).body?.cancel();
    for (let i = 0; i < 20; i++) {
      await api("POST", "/metrics/sample", {});
      if ((await api("GET", `/apps/${APP}`)).requests_24h >= 12) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    // a Claude Code connection (OAuth): the flow itself is covered by control-plane/test/oauth.e2e.test.ts
    psql(`insert into tokens (user_id, name, kind, oauth_session_id, oauth_client_id, last_used_at)
      values ('${user.id}', 'Claude Code (platform)', 'oauth', gen_random_uuid(), gen_random_uuid(), now())`);
    browser = await chromium.launch();
    page = await browser.newPage({ viewport: { width: 1680, height: 900 } });
  });

  after(async () => {
    await browser?.close();
    await cleanup([APP], [BUILDER]);
  });

  test("1. login", async () => {
    await page.goto(ADMIN);
    await page.getByLabel("Email").waitFor();
    await shot(page, "01-login");
    await page.getByLabel("Email").fill(env.PLATFORM_ADMIN_EMAIL ?? "admin@example.com");
    await page.getByLabel("Password").fill(env.PLATFORM_ADMIN_PASSWORD!);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.getByRole("heading", { name: "Dashboard" }).waitFor();
    await page.getByText("Postgres cluster").waitFor();
    await page.getByText("Requests, 24 h (all apps)").waitFor();
    await shot(page, "02-dashboard");
  });

  test("2. apps list shows the disposable app with its owner and flags", async () => {
    await page.goto(`${ADMIN}/#/apps`);
    await page.getByPlaceholder("Search slug, name, owner, repo").fill(APP);
    const row = page.getByRole("row").filter({ hasText: APP });
    await row.waitFor();
    assert.equal(await page.getByRole("row").filter({ hasText: APP }).count(), 1);
    await row.getByText(BUILDER, { exact: true }).waitFor();
    await row.getByText("deployed outside CI").waitFor();
    await row.getByText("bbbbbbb").waitFor();
    // load columns: requests of the last 24 h (synthetic history + the 12 real ones) and the 7-day sparkline
    const record = await api("GET", `/apps/${APP}`);
    assert.ok(record.requests_24h >= 12);
    await row.getByText(new Intl.NumberFormat("en-US").format(record.requests_24h)).first().waitFor();
    await row.getByRole("img", { name: new RegExp(`${APP} requests per day`) }).waitFor();
    await page.getByPlaceholder("Search slug, name, owner, repo").fill("");
    await page.getByRole("row").filter({ hasText: APP }).waitFor();
    await shot(page, "03-apps-list");
    await page.getByPlaceholder("Search slug, name, owner, repo").fill(APP);
  });

  test("3. app page: overview, stop and start", async () => {
    await page.getByRole("row").filter({ hasText: APP }).getByText("Admin UI demo").click();
    await page.waitForURL(new RegExp(`#/apps/${APP}/show`));
    const studio = page.getByRole("link", { name: "Open in Studio" });
    assert.equal(await studio.getAttribute("href"), `http://studio.localhost:8100/project/${APP}`);
    await page.getByText("gotrue: running").waitFor();
    const load = page.getByTestId("app-load");
    await load.getByRole("img", { name: /Requests per hour/ }).waitFor();
    await load.getByText("Table view").click();
    await load.getByRole("cell").first().waitFor();
    await load.getByText("Table view").click();
    // M6: the auth policy, read-only
    const auth = page.getByTestId("app-auth");
    await auth.getByText("Email confirmation").waitFor();
    await auth.getByText("required", { exact: true }).waitFor();
    await auth.getByText("Admin UI demo <noreply@platform.localhost>").waitFor();
    await shot(page, "04-app-overview", true);

    await page.getByRole("button", { name: "Stop" }).click();
    await page.getByRole("button", { name: "Confirm" }).click();
    await page.getByRole("button", { name: "Start" }).waitFor({ timeout: 60_000 });
    await page.getByText("stopped", { exact: true }).first().waitFor();
    const stopped = await api("GET", `/apps/${APP}`);
    assert.equal(stopped.status, "stopped");

    await page.getByRole("button", { name: "Start" }).click();
    await page.getByRole("button", { name: "Stop" }).waitFor({ timeout: 90_000 });
    const started = await api("GET", `/apps/${APP}`);
    assert.equal(started.status, "running");
  });

  test("4. app tabs: releases, members, secrets, audit", async () => {
    await page.getByRole("tab", { name: "Releases" }).click();
    await page.getByText("since previous").or(page.getByText("bbbbbbb").first()).first().waitFor();
    await shot(page, "05-app-releases");
    await page.getByRole("tab", { name: "Members" }).click();
    await page.getByRole("cell", { name: BUILDER }).waitFor();
    await shot(page, "06-app-members");
    await page.getByRole("tab", { name: "Secrets" }).click();
    await page.getByRole("cell", { name: "STRIPE_KEY" }).waitFor();
    assert.equal(await page.getByText("secret-value").count(), 0);
    await page.getByRole("tab", { name: "Audit" }).click();
    await page.getByRole("cell", { name: "start_app" }).first().waitFor();
    await shot(page, "07-app-audit");
  });

  test("4b. app backups: backup now, then restore it (typed confirmation)", async () => {
    await page.getByRole("tab", { name: "Backups" }).click();
    await page.getByText("No backup yet.").waitFor();
    await page.getByRole("button", { name: "Backup now" }).click();
    const row = page.getByRole("row").filter({ hasText: "manual" });
    await row.getByText("succeeded").waitFor({ timeout: 60_000 });
    await shot(page, "07b-app-backups");
    await row.getByRole("button", { name: "Restore…" }).click();
    const dialog = page.getByTestId("restore-dialog");
    const restore = dialog.getByRole("button", { name: "Restore" });
    assert.equal(await restore.isDisabled(), true, "disabled until the slug is typed");
    await dialog.getByLabel("Confirm slug").fill(APP);
    await restore.click();
    await page.getByText(`${APP} restored (data replaced)`).waitFor({ timeout: 120_000 });
    // the pre-restore backup taken by the restore is listed too
    await page.getByRole("row").filter({ hasText: "pre-restore" }).waitFor();
    assert.equal((await api("GET", `/apps/${APP}`)).status, "running");
    assert.equal(psql(`select count(*) from audit_log where action = 'restore_app' and details->>'slug' = '${APP}'`), "1");
  });

  test("5. users, tokens and audit log screens", async () => {
    await page.goto(`${ADMIN}/#/users`);
    await page.getByRole("cell", { name: BUILDER }).waitFor();
    await shot(page, "08-users");
    await page.getByRole("cell", { name: BUILDER }).click();
    await page.getByText("Audit (as actor)").waitFor();
    await shot(page, "09-user-edit");
    await page.goto(`${ADMIN}/#/tokens`);
    await page.getByRole("cell", { name: "ui-e2e" }).waitFor();
    await shot(page, "10-tokens");
    // Claude Code connections: type, client, last use, and revocation
    await page.getByRole("button", { name: "Claude Code" }).click();
    // PATs filtered out
    await page.getByRole("cell", { name: "ui-e2e" }).waitFor({ state: "detached" });
    const connection = page.getByRole("row").filter({ hasText: BUILDER });
    await connection.getByRole("cell", { name: "Claude Code connection" }).waitFor();
    await connection.getByRole("cell", { name: "Claude Code (platform)" }).waitFor();
    await shot(page, "10b-tokens-claude-code");
    await connection.getByRole("button", { name: "Revoke" }).click();
    await page.getByRole("button", { name: "Confirm" }).click();
    await connection.getByText("revoked").waitFor();
    await page.goto(`${ADMIN}/#/audit_log`);
    await page.getByRole("cell", { name: "stop_app" }).first().waitFor();
    await shot(page, "11-audit-log");
    await page.goto(`${ADMIN}/#/backups`);
    await page.getByTestId("backup-settings").waitFor();
    await page.getByRole("row").filter({ hasText: APP }).first().waitFor();
    await shot(page, "11b-backups");
  });

  test("6. company SSO: settings screen, then signing in with the mock IdP", async () => {
    const adminEmail = env.PLATFORM_ADMIN_EMAIL ?? "admin@example.com";
    const saved = psql("select coalesce(json_agg(json_build_object('key', key, 'value', value)), '[]') from settings where key like 'sso\\_%'");
    const link = psql(`select coalesce(sso_issuer, '') || '|' || coalesce(sso_subject, '') from users where email = '${adminEmail}'`);
    const context = await browser.newContext({ viewport: { width: 1680, height: 900 } });
    try {
      await page.goto(`${ADMIN}/#/sso`);
      await page.getByRole("heading", { name: "Company SSO" }).waitFor();
      await page.getByLabel("Issuer").fill("https://idp.sso.test:8443");
      await page.getByLabel("Discovery URL (optional)").fill("http://idp:8090/.well-known/openid-configuration");
      await page.getByLabel("Client ID").fill("platform");
      await page.getByLabel("Client secret").fill("platform-secret");
      await page.getByLabel("Button label").fill("Mock IdP");
      await page.getByLabel("Allowed email domains").fill("");
      if ((await page.getByTestId("sso-status").textContent()) === "off") await page.getByRole("switch", { name: "Enabled" }).click();
      await page.getByRole("button", { name: "Save" }).click();
      await page.getByText("SSO settings saved").waitFor();
      assert.equal(await page.getByTestId("sso-status").textContent(), "active");
      await page.getByText("/_platform/sso/callback").waitFor();
      await shot(page, "12-sso");

      // a fresh browser: the login page offers SSO, the mock IdP asks for an email, the console opens
      const fresh = await context.newPage();
      await fresh.goto(ADMIN);
      await fresh.getByRole("link", { name: "Sign in with Mock IdP" }).click();
      await fresh.getByRole("heading", { name: "Mock company IdP" }).waitFor();
      await fresh.getByLabel("Email", { exact: true }).fill(adminEmail);
      await fresh.getByRole("button", { name: "Sign in" }).click();
      await fresh.getByRole("heading", { name: "Dashboard" }).waitFor();
      assert.equal(psql(`select action from audit_log where user_id = (select id from users where email = '${adminEmail}')
        order by id desc limit 1`), "login_sso");

      // a builder is refused, with the reason on the login page
      const refused = await context.newPage();
      await context.clearCookies();
      await refused.goto(ADMIN);
      await refused.getByRole("link", { name: "Sign in with Mock IdP" }).click();
      await refused.getByLabel("Email", { exact: true }).fill(BUILDER);
      await refused.getByRole("button", { name: "Sign in" }).click();
      await refused.getByRole("alert").filter({ hasText: "reserved to platform admins" }).waitFor();
    } finally {
      await context.close();
      psql(`delete from settings where key like 'sso\\_%';
        insert into settings (key, value) select r->>'key', r->>'value' from json_array_elements('${saved.replaceAll("'", "''")}'::json) r`);
      const [issuer, subject] = link.split("|");
      psql(`update users set sso_issuer = nullif('${issuer}', ''), sso_subject = nullif('${subject}', '') where email = '${adminEmail}'`);
    }
  });
});
