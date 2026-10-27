// End-to-end test of the browser sign-in for Claude Code (journey B1, src/oauth.ts and src/platform-auth.ts) against
// the running "plat" stack: a simulated OAuth client does what Claude Code does (discovery from the 401 of /mcp,
// dynamic registration, authorization code with PKCE through the platform's login and consent pages, MCP calls,
// refresh), then the admin revokes the connection and disables the account. Also: deploy tokens restricted to one app
// (create_deploy_token, SEC-8) and PATs (Authorization and X-Platform-Token headers).
// Disposable resources: one builder (created through the admin API) and two apps it creates, deleted by cleanup().
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
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
const APP = `e2e-${ID}-oa`;
const OTHER_APP = `e2e-${ID}-ob`;
const BUILDER = `e2e-${ID}-oauth@example.com`;
const PASSWORD = randomBytes(18).toString("base64url");
const CLIENT_NAME = `Claude Code e2e ${ID}`;

const base64url = (buffer: Buffer) => buffer.toString("base64url");
const pkce = () => {
  const verifier = base64url(randomBytes(48));
  return { verifier, challenge: base64url(createHash("sha256").update(verifier).digest()) };
};
const callback = (port: number) => `http://localhost:${port}/callback`;

interface Metadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
  code_challenge_methods_supported: string[];
}

interface Tokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
}

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

/** One JSON-RPC call on /mcp (stateless server): the status, and the tool result or error. */
async function mcp(headers: Record<string, string>, method: string, params: Record<string, unknown> = {}) {
  const response = await fetch(MCP_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const text = await response.text();
  return { status: response.status, challenge: response.headers.get("www-authenticate"), body: text ? JSON.parse(text) : null };
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/** A tool's parsed result; throws on a tool error. */
async function tool(token: string, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const reply = await mcp(bearer(token), "tools/call", { name, arguments: args });
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  const result = reply.body.result;
  if (result.isError) throw new Error(`${name}: ${result.content[0].text}`);
  return JSON.parse(result.content[0].text);
}

async function toolError(token: string, name: string, args: Record<string, unknown> = {}) {
  const reply = await mcp(bearer(token), "tools/call", { name, arguments: args });
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  assert.ok(reply.body.result.isError, `${name} should fail`);
  return String(reply.body.result.content[0].text);
}

const form = (fields: Record<string, string>) => new URLSearchParams(fields);

async function tokenRequest(meta: Metadata, fields: Record<string, string>) {
  const response = await fetch(meta.token_endpoint, { method: "POST", body: form(fields) });
  return { status: response.status, headers: response.headers, body: await response.json() as any };
}

/** The browser: a cookie jar for the Studio host, and requests that never follow redirects. */
class Browser {
  cookie = "";

  async get(url: string) {
    return fetch(url, { redirect: "manual", headers: this.cookie ? { cookie: this.cookie } : {} });
  }

  async post(url: string, fields: Record<string, string>, origin = STUDIO) {
    const response = await fetch(url, {
      method: "POST",
      redirect: "manual",
      headers: { origin, "content-type": "application/x-www-form-urlencoded", ...(this.cookie ? { cookie: this.cookie } : {}) },
      body: form(fields),
    });
    const session = response.headers.getSetCookie().find((c) => c.startsWith("platform_session="));
    if (session) this.cookie = session.split(";")[0]!;
    return response;
  }
}

const location = (response: Response) => {
  assert.ok([302, 303].includes(response.status), `expected a redirect, got ${response.status}`);
  return new URL(response.headers.get("location")!, STUDIO).toString();
};

interface Client {
  client_id: string;
  redirect_uris: string[];
}

/**
 * The authorization request, up to the client's callback: Claude Code opens the authorization URL, the browser signs in
 * when needed and consents (unless the account already consented to this client). Returns the callback URL.
 */
async function authorize(meta: Metadata, client: Client, browser: Browser, options: {
  redirect: string;
  challenge: string;
  state?: string;
  decision?: "approve" | "deny";
  expectConsentPage?: boolean;
}) {
  const url = new URL(meta.authorization_endpoint);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: options.redirect,
    code_challenge: options.challenge,
    code_challenge_method: "S256",
    state: options.state ?? "state-1",
    resource: MCP_URL,
  }).toString();
  const consentUrl = location(await fetch(url, { redirect: "manual" }));
  assert.ok(consentUrl.startsWith(`${STUDIO}/_platform/oauth/consent?authorization_id=`), consentUrl);
  let consent = await browser.get(consentUrl);
  if (consent.status === 302 && consent.headers.get("location")!.startsWith("/_platform/login")) {
    const login = new URL(location(consent));
    assert.equal(login.searchParams.get("next"), consentUrl.slice(STUDIO.length));
    const page = await (await browser.get(login.toString())).text();
    assert.match(page, /Sign in to connect Claude Code/);
    const signedIn = await browser.post(`${STUDIO}/_platform/login`, {
      email: BUILDER,
      password: PASSWORD,
      next: login.searchParams.get("next")!,
    });
    assert.equal(location(signedIn), consentUrl);
    consent = await browser.get(consentUrl);
  }
  if (consent.status === 302) {
    assert.equal(options.expectConsentPage ?? true, false, "the consent page should have been shown");
    return location(consent);
  }
  assert.equal(consent.status, 200);
  assert.equal(options.expectConsentPage ?? true, true, "the consent should have been remembered");
  const html = await consent.text();
  assert.match(html, /Allow access to your apps\?/);
  assert.ok(html.includes(BUILDER), "the page names the account");
  assert.ok(html.includes(CLIENT_NAME), "the page names the client");
  const authorizationId = new URL(consentUrl).searchParams.get("authorization_id")!;
  // the decision is protected like the login form: a foreign origin is refused
  const forged = await browser.post(`${STUDIO}/_platform/oauth/consent`, { authorization_id: authorizationId, decision: "approve" }, "http://evil.example");
  assert.equal(forged.status, 403);
  return location(await browser.post(`${STUDIO}/_platform/oauth/consent`, {
    authorization_id: authorizationId,
    decision: options.decision ?? "approve",
  }));
}

const codeOf = (callbackUrl: string, redirect: string, state = "state-1") => {
  const url = new URL(callbackUrl);
  assert.equal(`${url.origin}${url.pathname}`, redirect);
  assert.equal(url.searchParams.get("state"), state);
  const code = url.searchParams.get("code");
  assert.ok(code, `no code in ${callbackUrl}`);
  return code;
};

/** Discovery, registration, authorization and code exchange: a fresh connection of the builder. */
async function connect(meta: Metadata, client: Client, browser: Browser, port: number, expectConsentPage = false) {
  const { verifier, challenge } = pkce();
  const redirect = callback(port);
  const code = codeOf(await authorize(meta, client, browser, { redirect, challenge, expectConsentPage }), redirect);
  const reply = await tokenRequest(meta, {
    grant_type: "authorization_code",
    code,
    client_id: client.client_id,
    redirect_uri: redirect,
    code_verifier: verifier,
    resource: MCP_URL,
  });
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  return reply.body as Tokens;
}

const sessionOf = (accessToken: string) =>
  JSON.parse(Buffer.from(accessToken.split(".")[1]!, "base64url").toString()).session_id as string;

async function connections() {
  const params = new URLSearchParams({ filter: JSON.stringify({ kind: "oauth", q: BUILDER }), range: JSON.stringify([0, 99]) });
  return (await admin("GET", `/tokens?${params}`)) as any[];
}

describe("OAuth e2e (browser sign-in for Claude Code)", () => {
  let meta: Metadata;
  let client: Client;
  let builderId: string;
  const browser = new Browser();
  let tokens: Tokens;
  /** Minted in test 6 from the connection that test 7 revokes. */
  let deployToken: string;

  before(async () => {
    await waitForControlPlane(MCP_URL);
    const user = await admin("POST", "/users", { email: BUILDER, role: "developer", password: PASSWORD, active: true });
    builderId = user.id;
  });

  after(async () => {
    await cleanup([APP, OTHER_APP], [BUILDER]);
    assert.equal(psql(`select count(*) from auth.users where email = '${BUILDER}'`), "0", "shadow user deleted with the account");
  });

  test("1. discovery: the 401 of /mcp points to the resource metadata, then to the authorization server", async () => {
    const unauthenticated = await mcp({}, "tools/list");
    assert.equal(unauthenticated.status, 401);
    const challenge = unauthenticated.challenge ?? "";
    const metadataUrl = /resource_metadata="([^"]+)"/.exec(challenge)?.[1];
    assert.ok(metadataUrl, challenge);
    assert.doesNotMatch(challenge, /invalid_token/, "no token was sent");
    const resource = await (await fetch(metadataUrl)).json() as { resource: string; authorization_servers: string[] };
    assert.equal(resource.resource, MCP_URL);
    const issuer = resource.authorization_servers[0]!;
    meta = await (await fetch(`${issuer}/.well-known/oauth-authorization-server`)).json() as Metadata;
    assert.equal(meta.issuer, issuer);
    assert.deepEqual(meta.code_challenge_methods_supported, ["S256"]);
    // local install (plain HTTP): Claude Code only sends token requests over HTTPS or to a loopback host
    assert.equal(new URL(meta.token_endpoint).hostname, "localhost");
    const invalid = await mcp(bearer("plat_not-a-token"), "tools/list");
    assert.equal(invalid.status, 401);
    assert.match(invalid.challenge ?? "", /error="invalid_token"/);
  });

  test("2. dynamic registration: native clients only", async () => {
    const register = (body: unknown) =>
      fetch(meta.registration_endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const refused = await register({ client_name: "web", redirect_uris: ["https://evil.example/callback"] });
    assert.equal(refused.status, 400);
    assert.equal((await refused.json() as any).error, "invalid_redirect_uri");
    const confidential = await register({ redirect_uris: [callback(41000)], token_endpoint_auth_method: "client_secret_basic" });
    assert.equal(confidential.status, 400);
    const created = await register({
      client_name: CLIENT_NAME,
      redirect_uris: [callback(41000)],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
    assert.equal(created.status, 201, await created.clone().text());
    client = await created.json() as Client;
    assert.ok(client.client_id);
    assert.equal((client as any).client_secret, undefined, "public client: no secret");
    // GoTrue's own dynamic registration is off: nothing on the internal network (a function, SEC-1) can register a
    // client with a redirect URI of its choice and bypass these checks
    const direct = execFileSync("docker", ["exec", "plat-control-plane", "node", "-e", `
      fetch("http://plat-oauth:9999/oauth/clients/register", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ redirect_uris: ["https://evil.example/callback"] }) }).then((r) => console.log(r.status))`], { encoding: "utf8" });
    assert.equal(direct.trim(), "403");
  });

  test("3. authorization requests: PKCE S256 only, registered loopback redirect only, the MCP endpoint as resource", async () => {
    const { challenge } = pkce();
    const request = (params: Record<string, string>) => {
      const url = new URL(meta.authorization_endpoint);
      url.search = new URLSearchParams({
        response_type: "code",
        client_id: client.client_id,
        redirect_uri: callback(41000),
        code_challenge: challenge,
        code_challenge_method: "S256",
        state: "s",
        ...params,
      }).toString();
      return fetch(url, { redirect: "manual" });
    };
    const errorOf = (response: Response) => new URL(response.headers.get("location")!).searchParams.get("error");
    assert.equal(errorOf(await request({ code_challenge_method: "plain" })), "invalid_request");
    assert.equal(errorOf(await request({ code_challenge: "" })), "invalid_request");
    assert.equal(errorOf(await request({ resource: "https://evil.example/mcp" })), "invalid_target");
    // never redirected: the redirect URI is not the client's
    const invalid: Record<string, string>[] = [
      { redirect_uri: "http://evil.example/callback" },
      { redirect_uri: "http://localhost:41000/other" },
      { client_id: "00000000-0000-0000-0000-000000000000" },
    ];
    for (const params of invalid) {
      const response = await request(params);
      assert.equal(response.status, 400, JSON.stringify(params));
      assert.equal(response.headers.get("location"), null);
    }
  });

  test("4. sign-in, consent, code exchange (single use, PKCE, 60 s), then MCP calls as the builder", async () => {
    // Claude Code picks another callback port than the registered one (RFC 8252 §7.3): accepted
    const redirect = callback(42000);
    const denied = pkce();
    const refusal = new URL(await authorize(meta, client, browser, { redirect, challenge: denied.challenge, decision: "deny" }));
    assert.equal(refusal.searchParams.get("error"), "access_denied");

    const { verifier, challenge } = pkce();
    const code = codeOf(await authorize(meta, client, browser, { redirect, challenge }), redirect);
    const exchange = (fields: Record<string, string>) =>
      tokenRequest(meta, { grant_type: "authorization_code", code, client_id: client.client_id, redirect_uri: redirect, code_verifier: verifier, ...fields });
    assert.equal((await exchange({ code_verifier: pkce().verifier })).body.error, "invalid_grant", "wrong PKCE verifier");
    assert.equal((await exchange({ redirect_uri: callback(43000) })).body.error, "invalid_grant", "other redirect URI");
    const reply = await exchange({});
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    assert.equal(reply.headers.get("cache-control"), "no-store");
    tokens = reply.body;
    assert.equal(tokens.token_type, "bearer");
    assert.ok(tokens.expires_in <= 3600 && tokens.expires_in > 3500, String(tokens.expires_in));
    assert.ok(tokens.refresh_token);
    assert.equal((await exchange({})).body.error, "invalid_grant", "a code is used once");

    const me = await tool(tokens.access_token, "whoami");
    assert.equal(me.email, BUILDER);
    assert.equal(me.credential, "oauth");

    // a code exchanged more than 60 s after the consent is refused (approved_at moved back instead of waiting)
    const late = pkce();
    const lateCode = codeOf(await authorize(meta, client, browser, { redirect, challenge: late.challenge, expectConsentPage: false }), redirect);
    psql(`update auth.oauth_authorizations set approved_at = now() - interval '2 minutes' where authorization_code = '${lateCode}'`);
    const expired = await tokenRequest(meta, {
      grant_type: "authorization_code",
      code: lateCode,
      client_id: client.client_id,
      redirect_uri: redirect,
      code_verifier: late.verifier,
    });
    assert.equal(expired.status, 400);
    assert.equal(expired.body.error, "invalid_grant");

    const [connection] = await connections();
    assert.equal(connection.kind, "oauth");
    assert.equal(connection.client_name, CLIENT_NAME);
    assert.equal(connection.status, "active");
    assert.ok(connection.last_used_at);
    const actions = psql(`select string_agg(distinct action, ',' order by action) from audit_log
      where user_id = '${builderId}' and action like 'oauth_%'`);
    assert.equal(actions, "oauth_authorize,oauth_connect");
  });

  test("5. refresh tokens rotate; reusing an old one revokes the whole family", async () => {
    const refresh = (token: string) => tokenRequest(meta, { grant_type: "refresh_token", refresh_token: token, client_id: client.client_id });
    const first = await refresh(tokens.refresh_token);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.notEqual(first.body.refresh_token, tokens.refresh_token);
    assert.equal(sessionOf(first.body.access_token), sessionOf(tokens.access_token), "same connection");
    assert.equal((await tool(first.body.access_token, "whoami")).email, BUILDER);
    const second = await refresh(first.body.refresh_token);
    assert.equal(second.status, 200, JSON.stringify(second.body));

    // GoTrue's tolerance: the parent of the current token returns the current one (concurrent refreshes, a lost answer)
    const lost = await refresh(first.body.refresh_token);
    assert.equal(lost.status, 200);
    assert.equal(lost.body.refresh_token, second.body.refresh_token, "no new branch");
    // any older token is a theft signal
    const reused = await refresh(tokens.refresh_token);
    assert.equal(reused.status, 400);
    assert.equal(reused.body.error, "invalid_grant");
    const current = await refresh(second.body.refresh_token);
    assert.equal(current.body.error, "invalid_grant", "the family is revoked");
  });

  test("6. deploy tokens: one app, the publishing tools, 15 minutes, revoked with their parent", async () => {
    tokens = await connect(meta, client, browser, 42000);
    for (const [slug, name] of [[APP, "OAuth e2e"], [OTHER_APP, "OAuth e2e other"]]) {
      await tool(tokens.access_token, "create_app", { name, slug });
    }
    const minted = await tool(tokens.access_token, "create_deploy_token", { app: APP });
    assert.equal(minted.app, APP);
    assert.match(minted.token, /^plat_dep_/);
    assert.ok(new Date(minted.expires_at).getTime() - Date.now() <= 15 * 60_000);
    const deploy = minted.token as string;

    assert.equal((await tool(deploy, "get_app", { app: APP })).slug, APP);
    assert.match(await toolError(deploy, "get_app", { app: OTHER_APP }), /not found/);
    const me = await tool(deploy, "whoami");
    assert.equal(me.credential, "deploy");
    assert.deepEqual(me.apps.map((a: { slug: string }) => a.slug), [APP]);
    const listed = (await mcp(bearer(deploy), "tools/list")).body.result.tools.map((t: { name: string }) => t.name).sort();
    assert.deepEqual(listed, ["apply_migrations", "begin_release", "create_deployment", "finalize_deployment", "finish_release", "get_app", "whoami"]);
    for (const name of ["execute_sql", "create_deploy_token", "set_secrets", "delete_app"]) {
      assert.match(await toolError(deploy, name, { app: APP }), /not found/, name);
    }
    // the dry run of `platform-deploy check`
    const dryRun = await tool(deploy, "apply_migrations", { app: APP, migrations: [], dry_run: true });
    assert.ok(dryRun);

    // expired
    const short = (await tool(tokens.access_token, "create_deploy_token", { app: APP })).token as string;
    psql(`update tokens set expires_at = now() - interval '1 second' where hash = encode(sha256('${short}'::bytea), 'hex')`);
    assert.equal((await mcp(bearer(short), "tools/list")).status, 401);
    deployToken = deploy;
  });

  test("7. the admin revokes the connection: refused at once, refresh refused, the next sign-in asks again", async () => {
    const [connection] = (await connections()).filter((t) => t.status === "active");
    assert.ok(connection);
    const revoked = await admin("DELETE", `/tokens/${connection.id}`);
    assert.equal(revoked.status, "revoked");
    const refused = await mcp(bearer(tokens.access_token), "tools/list");
    assert.equal(refused.status, 401);
    assert.match(refused.challenge ?? "", /resource_metadata=/);
    assert.equal((await mcp(bearer(deployToken), "tools/list")).status, 401, "its deploy tokens are revoked too");
    const refresh = await tokenRequest(meta, { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client.client_id });
    assert.equal(refresh.body.error, "invalid_grant");
    assert.equal(psql(`select count(*) from auth.sessions where user_id = '${builderId}'`), "0");
    assert.equal(psql(`select count(*) from audit_log where action = 'oauth_token_revoked' and details->>'email' = '${BUILDER}'`), "1");
    // consent revoked: the page is shown again
    tokens = await connect(meta, client, browser, 42000, true);
    assert.equal((await tool(tokens.access_token, "whoami")).email, BUILDER);
  });

  test("8. a disabled account is refused at once, its refresh too, and it cannot sign in again", async () => {
    await admin("PUT", `/users/${builderId}`, { active: false });
    assert.equal((await mcp(bearer(tokens.access_token), "tools/list")).status, 401);
    const refresh = await tokenRequest(meta, { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client.client_id });
    assert.equal(refresh.body.error, "invalid_grant");
    // the browser session is gone too: the login refuses the account
    const fresh = new Browser();
    const { challenge } = pkce();
    await assert.rejects(
      authorize(meta, client, fresh, { redirect: callback(42000), challenge }),
      /expected a redirect, got 401/,
    );
    await admin("PUT", `/users/${builderId}`, { active: true });
  });

  test("9. PATs keep working, in Authorization or in X-Platform-Token (the plugin's header)", async () => {
    const created = await admin("POST", "/tokens", { user_id: builderId, name: "e2e" });
    const pat = created.token as string;
    assert.equal((await tool(pat, "whoami")).credential, "pat");
    const viaHeader = await mcp({ "x-platform-token": pat }, "tools/call", { name: "whoami", arguments: {} });
    assert.equal(viaHeader.status, 200);
    assert.equal(JSON.parse(viaHeader.body.result.content[0].text).email, BUILDER);
    const empty = await mcp({ "x-platform-token": "" }, "tools/list");
    assert.equal(empty.status, 401, "an empty header (PLATFORM_TOKEN unset) falls back to OAuth");
    assert.doesNotMatch(empty.challenge ?? "", /invalid_token/);
    // a PAT minting a deploy token: same restrictions
    const deploy = (await tool(pat, "create_deploy_token", { app: APP })).token as string;
    assert.match(await toolError(deploy, "get_app", { app: OTHER_APP }), /not found/);
  });
});
