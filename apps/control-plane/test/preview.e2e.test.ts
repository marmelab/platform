// End-to-end test of the preview tunnel's rules (ARCHITECTURE §3.10, src/previews.ts) against the running "plat"
// stack. Without frpc: a request let through reaches frps, whose 404 page says that no session opened the subdomain.
// Disposable resources: three builders (created through the admin API) and an app, deleted by cleanup().
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { cleanup, psql, runId, waitForControlPlane } from "./disposable.ts";

const ROOT = new URL("../../../", import.meta.url);
const env = Object.fromEntries(
  readFileSync(new URL("deploy/.env.local", ROOT), "utf8").split("\n").filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const MCP_URL = env.PLATFORM_URL ?? "http://api.localhost:8100/mcp";
const ADMIN = "http://admin.localhost:8100";
const STUDIO = "http://localhost:8100";
const ID = runId();
const APP = `e2e-${ID}-pv`;
const PREVIEW = `http://preview-${APP}.localhost:8100`;
const OWNER = `e2e-${ID}-pv-owner@example.com`;
const COLLAB = `e2e-${ID}-pv-collab@example.com`;
const OUTSIDER = `e2e-${ID}-pv-out@example.com`;
const PASSWORD = randomBytes(18).toString("base64url");

async function admin(method: string, path: string, body?: unknown) {
  const response = await fetch(`${ADMIN}/api${path}`, {
    method,
    headers: {
      authorization: `Bearer ${env.PLATFORM_TOKEN}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await response.json().catch(() => null);
  assert.ok(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(json)}`);
  return json;
}

async function builder(email: string) {
  const user = await admin("POST", "/users", { email, role: "developer", password: PASSWORD, active: true });
  return { id: user.id as string, pat: (await admin("POST", "/tokens", { user_id: user.id, name: "e2e" })).token as string };
}

async function mcp(token: string, method: string, params: Record<string, unknown> = {}) {
  const response = await fetch(MCP_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

/** A tool's result: parsed, or the error text with `error: true`. */
async function call(token: string, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const reply = await mcp(token, "tools/call", { name, arguments: args });
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  const result = reply.body.result;
  return result.isError ? { error: true, text: String(result.content[0].text) } : JSON.parse(result.content[0].text);
}

/** The frps server plugin, called as frps calls it (internal listener). */
function plugin(op: string, content: Record<string, unknown>): { reject: boolean } {
  return JSON.parse(execFileSync("docker", [
    "exec",
    "-i",
    "plat-control-plane",
    "node",
    "-e",
    `fetch("http://127.0.0.1:3001/frp/plugin", { method: "POST", body: require("node:fs").readFileSync(0) })
      .then((r) => r.text()).then(console.log)`,
  ], { input: JSON.stringify({ version: "0.1.0", op, content }), encoding: "utf8" }));
}
const heartbeat = (token: string) => !plugin("Ping", { user: { metas: { token } } }).reject;

class Browser {
  cookie = "";

  get(url: string) {
    return fetch(url, { redirect: "manual", headers: { accept: "text/html", ...(this.cookie ? { cookie: this.cookie } : {}) } });
  }

  async signIn(email: string) {
    const response = await fetch(`${STUDIO}/_platform/login`, {
      method: "POST",
      redirect: "manual",
      headers: { origin: STUDIO, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email, password: PASSWORD, next: "/" }),
    });
    assert.equal(response.status, 303);
    this.cookie = response.headers.getSetCookie().find((c) => c.startsWith("platform_session="))!.split(";")[0]!;
  }
}

const location = (response: Response) => {
  assert.ok([302, 303].includes(response.status), `expected a redirect, got ${response.status}`);
  return new URL(response.headers.get("location")!, STUDIO);
};

describe("Preview tunnel e2e", () => {
  let owner: { id: string; pat: string };
  let collab: { id: string; pat: string };

  before(async () => {
    await waitForControlPlane(MCP_URL);
    owner = await builder(OWNER);
    collab = await builder(COLLAB);
    await builder(OUTSIDER);
    await call(owner.pat, "create_app", { name: "Preview e2e", slug: APP });
    await call(owner.pat, "add_member", { app: APP, email: COLLAB });
  });

  after(async () => {
    await cleanup([APP], [OWNER, COLLAB, OUTSIDER]);
  });

  test("1. preview tokens: any member, one app, audited; the MCP endpoint refuses them, a deploy token mints none", async () => {
    const minted = await call(collab.pat, "create_preview_token", { app: APP });
    assert.match(minted.token, /^plat_prv_/);
    assert.equal(minted.url, PREVIEW);
    assert.ok(new Date(minted.expires_at).getTime() - Date.now() <= 12 * 3600_000);
    assert.equal((await mcp(minted.token, "tools/list")).status, 401);
    const deploy = (await call(owner.pat, "create_deploy_token", { app: APP })).token;
    assert.match((await call(deploy, "create_preview_token", { app: APP })).text, /not found/);
    assert.equal(psql(`select count(*) from audit_log a join apps p on p.id = a.app_id
      where a.action = 'create_preview_token' and p.slug = '${APP}'`), "1");
  });

  test("2. frps's plugin: preview-<its app> only, checked again at each heartbeat", async () => {
    const first = (await call(owner.pat, "create_preview_token", { app: APP })).token;
    assert.equal(plugin("Login", { metas: { token: first } }).reject, false);
    assert.equal(plugin("Login", { metas: { token: "plat_prv_unknown" } }).reject, true);
    const proxy = (subdomain: string) =>
      plugin("NewProxy", { user: { metas: { token: first } }, proxy_type: "http", subdomain }).reject;
    assert.equal(proxy(`preview-${APP}`), false);
    assert.equal(proxy(`preview-${APP}x`), true, "another app's preview");
    assert.equal(proxy(APP), true, "the app's own host");
    assert.equal(heartbeat(first), true);

    // one tunnel per app: a new token voids the builder's former ones
    const second = (await call(owner.pat, "create_preview_token", { app: APP })).token;
    assert.equal(heartbeat(first), false);
    assert.equal(heartbeat(second), true);
    psql(`update tokens set expires_at = now() - interval '1 second' where hash = encode(sha256('${second}'::bytea), 'hex')`);
    assert.equal(heartbeat(second), false, "expired");

    // revoked with the credential that minted it
    const parent = await admin("POST", "/tokens", { user_id: owner.id, name: "e2e parent" });
    const child = (await call(parent.token, "create_preview_token", { app: APP })).token;
    assert.equal(heartbeat(child), true);
    await admin("DELETE", `/tokens/${parent.id}`);
    assert.equal(heartbeat(child), false, "parent revoked");

    // a builder removed from the app loses the tunnel
    const collabs = (await call(collab.pat, "create_preview_token", { app: APP })).token;
    assert.equal(heartbeat(collabs), true);
    await call(owner.pat, "remove_member", { app: APP, email: COLLAB });
    assert.equal(heartbeat(collabs), false, "removed from the app");
    await call(owner.pat, "add_member", { app: APP, email: COLLAB });
  });

  test("3. the preview host: the app's members only, through the platform's login, the membership checked at each request", async () => {
    // not signed in: a page goes to Studio's sign-in, anything else is refused
    const start = location(await fetch(`${PREVIEW}/tasks?done=1`, { redirect: "manual", headers: { accept: "text/html" } }));
    assert.equal(`${start.origin}${start.pathname}`, `${STUDIO}/_platform/preview`);
    assert.equal(start.searchParams.get("app"), APP);
    assert.equal(start.searchParams.get("next"), "/tasks?done=1");
    assert.equal((await fetch(`${PREVIEW}/rest/v1/tasks`, { redirect: "manual" })).status, 401);

    const browser = new Browser();
    const login = location(await browser.get(start.toString()));
    assert.equal(login.pathname, "/_platform/login");
    assert.match(await (await browser.get(login.toString())).text(), /Sign in to see the preview/);
    await browser.signIn(COLLAB);
    const ticketUrl = location(await browser.get(start.toString()));
    assert.equal(ticketUrl.origin, PREVIEW);
    assert.equal(ticketUrl.pathname, "/_platform/preview");

    // a forged ticket is refused; the real one is traded for the preview host's pass
    const ticket = ticketUrl.searchParams.get("ticket")!;
    const forged = new URL(ticketUrl);
    forged.searchParams.set("ticket", `${ticket.slice(0, -1)}${ticket.endsWith("A") ? "B" : "A"}`);
    assert.equal((await fetch(forged, { redirect: "manual" })).status, 403);
    const traded = await fetch(ticketUrl, { redirect: "manual" });
    assert.equal(traded.status, 303);
    assert.equal(traded.headers.get("location"), "/tasks?done=1");
    const pass = traded.headers.getSetCookie().find((c) => c.startsWith("platform_preview="))!;
    assert.match(pass, /HttpOnly/i);
    assert.doesNotMatch(pass, /Domain=/i, "a cookie of the preview host only");
    const cookie = pass.split(";")[0]!;

    // let through to frps: no session opened the subdomain
    const through = await fetch(`${PREVIEW}/tasks`, { redirect: "manual", headers: { cookie } });
    assert.equal(through.status, 404);
    assert.match(await through.text(), /frp/);

    // removed from the app: the pass opens nothing
    await call(owner.pat, "remove_member", { app: APP, email: COLLAB });
    assert.equal((await fetch(`${PREVIEW}/tasks`, { redirect: "manual", headers: { cookie } })).status, 401);
    await call(owner.pat, "add_member", { app: APP, email: COLLAB });

    // signed in, but not a member: Studio gives no ticket
    const outsider = new Browser();
    await outsider.signIn(OUTSIDER);
    const refused = await outsider.get(start.toString());
    assert.equal(refused.status, 403);
    assert.match(await refused.text(), /is not a member of/);
  });
});
