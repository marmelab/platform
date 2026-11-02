// Unit tests of the OAuth front's rules (journey B1, src/oauth-policy.ts) and of the token scopes (SEC-8,
// src/token-scopes.ts): native clients only in registration, claude.ai's callback for the connector's confidential
// client only, loopback port changes (RFC 8252), Basic client credentials, PKCE S256 only, the resource indicator, the
// 60 s code lifetime, the tools of a deploy token, and what a preview token opens in the preview tunnel. The flows themselves (single-use code, PKCE verification, refresh rotation and reuse,
// revocation) run against GoTrue in test/oauth.e2e.test.ts.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  basicCredentials,
  checkAuthorizeRequest,
  clientAllowed,
  CODE_TTL_SECONDS,
  codeFresh,
  CLAUDE_AI_REDIRECT,
  errorRedirect,
  isAllowedRedirect,
  isLoopbackRedirect,
  MAX_LOOPBACK_REDIRECTS,
  OAuthError,
  redirectsToRegister,
  sameLoopbackExceptPort,
  sanitizeRegistration,
} from "../src/oauth-policy.ts";
import { frpDecision, frpToken, scopeTools, toolAllowed } from "../src/token-scopes.ts";

const error = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof OAuthError, String(e));
    return e.error;
  }
  return "accepted";
};

test("redirect URIs: plain HTTP on the loopback interface, canonical, without fragment or credentials", () => {
  for (const uri of ["http://localhost:53987/callback", "http://127.0.0.1:8080/cb", "http://[::1]:3000/callback", "http://localhost/callback"]) {
    assert.ok(isLoopbackRedirect(uri), uri);
  }
  for (const uri of [
    "https://localhost:53987/callback", // native clients listen in plain HTTP; anything else is a web client
    "http://evil.example/callback",
    "http://localhost.evil.example/callback",
    "http://127.0.0.2/callback",
    "http://api.localhost:8100/callback",
    "http://user:pw@localhost:1234/callback",
    "http://localhost:1234/callback#frag",
    "http://LOCALHOST:1234/callback", // not canonical: GoTrue compares strings
    "http://localhost:1234",
    "myapp://callback",
    "not a url",
  ]) {
    assert.equal(isLoopbackRedirect(uri), false, uri);
  }
});

test("a native client may pick another port at each sign-in (RFC 8252 §7.3), nothing else may change", () => {
  assert.ok(sameLoopbackExceptPort("http://localhost:1111/callback", "http://localhost:2222/callback"));
  assert.equal(sameLoopbackExceptPort("http://localhost:1111/callback", "http://127.0.0.1:2222/callback"), false);
  assert.equal(sameLoopbackExceptPort("http://localhost:1111/callback", "http://localhost:2222/other"), false);
  assert.equal(sameLoopbackExceptPort("http://localhost:1111/callback", "http://localhost:2222/callback?x=1"), false);

  const registered = ["http://localhost:1111/callback"];
  assert.equal(redirectsToRegister(registered, "http://localhost:1111/callback"), null);
  assert.deepEqual(redirectsToRegister(registered, "http://localhost:2222/callback"), [
    "http://localhost:1111/callback",
    "http://localhost:2222/callback",
  ]);
  assert.equal(error(() => redirectsToRegister(registered, "http://evil.example/callback")), "invalid_request");
  assert.equal(error(() => redirectsToRegister(registered, "http://localhost:2222/elsewhere")), "invalid_request");

  // the list stays bounded: the oldest ports go first
  const many = Array.from({ length: MAX_LOOPBACK_REDIRECTS }, (_, i) => `http://localhost:${1000 + i}/callback`);
  const next = redirectsToRegister(many, "http://localhost:9999/callback")!;
  assert.equal(next.length, MAX_LOOPBACK_REDIRECTS);
  assert.equal(next.at(-1), "http://localhost:9999/callback");
  assert.ok(!next.includes("http://localhost:1000/callback"));
});

test("claude.ai's callback is the connector's confidential client's only redirect, and only it may use it", () => {
  assert.ok(isAllowedRedirect("http://localhost:53987/callback", "public"));
  assert.ok(isAllowedRedirect(CLAUDE_AI_REDIRECT, "confidential"));
  // anyone can make a claude.ai account and register a client: a public client never reaches claude.ai's callback
  assert.equal(isAllowedRedirect(CLAUDE_AI_REDIRECT, "public"), false);
  assert.equal(isAllowedRedirect("http://localhost:53987/callback", "confidential"), false);
  for (const uri of [
    "https://claude.ai/api/mcp/auth_callback/",
    "https://claude.ai/api/mcp/auth_callback?x=1",
    "http://claude.ai/api/mcp/auth_callback",
    "https://claude.ai.evil.example/api/mcp/auth_callback",
    "https://claude.ai/elsewhere",
  ]) {
    assert.equal(isAllowedRedirect(uri, "confidential"), false, uri);
  }
  assert.equal(error(() => sanitizeRegistration({ client_name: "Claude", redirect_uris: [CLAUDE_AI_REDIRECT] })), "invalid_redirect_uri");
  // an exact match needs no new registration; port changes stay a loopback thing
  assert.equal(redirectsToRegister([CLAUDE_AI_REDIRECT], CLAUDE_AI_REDIRECT), null);
  assert.equal(error(() => redirectsToRegister(["http://localhost:1/callback"], CLAUDE_AI_REDIRECT)), "invalid_request");
});

test("a builder's own connector signs in that builder only; the organization's anyone; an unlisted confidential client nobody", () => {
  const [alice, bob] = ["alice-id", "bob-id"];
  assert.ok(clientAllowed({ client_type: "public", connector: false, owner: null }, alice), "Claude Code");
  assert.ok(clientAllowed({ client_type: "confidential", connector: true, owner: null }, alice), "the organization's");
  assert.ok(clientAllowed({ client_type: "confidential", connector: true, owner: alice }, alice), "alice's, for alice");
  // alice's secret, leaked or misused, signs in nobody but alice
  assert.equal(clientAllowed({ client_type: "confidential", connector: true, owner: alice }, bob), false);
  // a deleted builder's client (row gone with the account)
  assert.equal(clientAllowed({ client_type: "confidential", connector: false, owner: null }, alice), false);
});

test("Basic client credentials (client_secret_basic): form-urlencoded parts, then base64", () => {
  const basic = (value: string) => `Basic ${Buffer.from(value).toString("base64")}`;
  assert.deepEqual(basicCredentials(basic("0b6c4c1e-2f3a-4d5e-8f90-1a2b3c4d5e6f:s3cr%3At+x")), {
    client_id: "0b6c4c1e-2f3a-4d5e-8f90-1a2b3c4d5e6f",
    client_secret: "s3cr:t x",
  });
  assert.deepEqual(basicCredentials(basic("id:")), { client_id: "id", client_secret: "" });
  for (const header of [undefined, "", "Bearer abc", basic("no-colon"), "Basic not*base64", basic("id:%E0%A4%A")]) {
    assert.equal(basicCredentials(header), null, String(header));
  }
});

test("dynamic registration: public native clients only, other metadata dropped", () => {
  const claudeCode = {
    client_name: "Claude Code (platform)",
    redirect_uris: ["http://localhost:53987/callback"],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    scope: "openid email",
    jwks_uri: "https://evil.example/jwks",
  };
  assert.deepEqual(sanitizeRegistration(claudeCode), {
    redirect_uris: ["http://localhost:53987/callback"],
    client_name: "Claude Code (platform)",
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
  });
  assert.deepEqual(sanitizeRegistration({ redirect_uris: ["http://127.0.0.1:1/cb"] }).grant_types, ["authorization_code", "refresh_token"]);
  assert.equal(sanitizeRegistration({ redirect_uris: ["http://127.0.0.1:1/cb"], client_name: "x".repeat(500) }).client_name?.length, 100);
  assert.equal(sanitizeRegistration({ redirect_uris: ["http://127.0.0.1:1/cb"], client_uri: "javascript:alert(1)" }).client_uri, undefined);

  assert.equal(error(() => sanitizeRegistration(null)), "invalid_redirect_uri");
  assert.equal(error(() => sanitizeRegistration({ redirect_uris: [] })), "invalid_redirect_uri");
  assert.equal(error(() => sanitizeRegistration({ redirect_uris: ["https://app.example/callback"] })), "invalid_redirect_uri");
  assert.equal(error(() => sanitizeRegistration({ redirect_uris: ["http://localhost:1/cb", "https://evil.example/cb"] })), "invalid_redirect_uri");
  assert.equal(
    error(() => sanitizeRegistration({ redirect_uris: ["http://localhost:1/cb"], token_endpoint_auth_method: "client_secret_basic" })),
    "invalid_client_metadata",
  );
  assert.equal(
    error(() => sanitizeRegistration({ redirect_uris: ["http://localhost:1/cb"], grant_types: ["client_credentials"] })),
    "invalid_client_metadata",
  );
});

test("authorization requests: code flow with PKCE S256 only, and the MCP endpoint as the only resource", () => {
  const resource = "https://api.example.com/mcp";
  const verifier = "a".repeat(64);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const valid = { response_type: "code", code_challenge: challenge, code_challenge_method: "S256", resource };
  assert.equal(error(() => checkAuthorizeRequest(valid, resource)), "accepted");
  assert.equal(error(() => checkAuthorizeRequest({ ...valid, resource: undefined }, resource)), "accepted");
  assert.equal(error(() => checkAuthorizeRequest({ ...valid, response_type: "token" }, resource)), "unsupported_response_type");
  assert.equal(error(() => checkAuthorizeRequest({ ...valid, code_challenge_method: "plain" }, resource)), "invalid_request");
  assert.equal(error(() => checkAuthorizeRequest({ ...valid, code_challenge_method: undefined }, resource)), "invalid_request");
  assert.equal(error(() => checkAuthorizeRequest({ ...valid, code_challenge: undefined }, resource)), "invalid_request");
  assert.equal(error(() => checkAuthorizeRequest({ ...valid, code_challenge: "short" }, resource)), "invalid_request");
  assert.equal(error(() => checkAuthorizeRequest({ ...valid, code_challenge: `${challenge}+/=` }, resource)), "invalid_request");
  assert.equal(error(() => checkAuthorizeRequest({ ...valid, resource: "https://evil.example/mcp" }, resource)), "invalid_target");

  const redirect = new URL(errorRedirect("http://localhost:1/callback", new OAuthError("invalid_request", "no PKCE"), "xyz"));
  assert.equal(redirect.origin + redirect.pathname, "http://localhost:1/callback");
  assert.deepEqual(Object.fromEntries(redirect.searchParams), { error: "invalid_request", error_description: "no PKCE", state: "xyz" });
});

test(`authorization codes are exchanged within ${CODE_TTL_SECONDS} s of the consent`, () => {
  const approved = new Date("2026-10-06T10:00:00Z");
  assert.ok(codeFresh(approved, new Date("2026-10-06T10:00:59Z")));
  assert.ok(codeFresh(approved, new Date("2026-10-06T10:01:00Z")));
  assert.equal(codeFresh(approved, new Date("2026-10-06T10:01:01Z")), false);
  assert.equal(codeFresh(null, approved), false);
});

test("token scopes: none means every tool, deploy means what platform-deploy calls", () => {
  assert.equal(scopeTools([]), null);
  assert.deepEqual(scopeTools(["unknown"]), []);
  const deploy = scopeTools(["deploy"])!;
  for (const tool of ["get_app", "apply_migrations", "begin_release", "create_deployment", "finalize_deployment", "finish_release"]) {
    assert.ok(deploy.includes(tool), tool);
  }
  for (const tool of ["execute_sql", "create_deploy_token", "set_secrets", "add_member", "delete_app", "create_app"]) {
    assert.equal(deploy.includes(tool), false, tool);
  }
  const user = (tools: string[] | null) => ({ token: { id: "t", kind: "deploy" as const, appIds: null, tools } });
  assert.ok(toolAllowed({}, "delete_app"));
  assert.ok(toolAllowed(user(null), "delete_app"));
  assert.ok(toolAllowed(user(deploy), "get_app"));
  assert.equal(toolAllowed(user(deploy), "execute_sql"), false);
});

const login = { op: "Login", content: { metas: { token: "plat_prv_x" } } };
const proxy = (content: Record<string, unknown>) => ({
  op: "NewProxy",
  content: { user: { metas: { token: "plat_prv_x" } }, proxy_type: "http", subdomain: "preview-notes", ...content },
});
const ping = { op: "Ping", content: { user: { metas: { token: "plat_prv_x" } }, timestamp: 0 } };

test("preview tunnel: frpc's token, in metas at login and user.metas afterwards", () => {
  assert.equal(frpToken(login), "plat_prv_x");
  assert.equal(frpToken(proxy({})), "plat_prv_x");
  assert.equal(frpToken(ping), "plat_prv_x");
  assert.equal(frpToken({ op: "Login", content: { user: { metas: { token: "elsewhere" } } } }), "");
  assert.equal(frpToken({}), "");
});

test("a preview token logs in and opens an http proxy on preview-<its app> only, checked again at each heartbeat", () => {
  assert.deepEqual(frpDecision(login, "notes"), { reject: false, unchange: true });
  assert.deepEqual(frpDecision(proxy({}), "notes"), { reject: false, unchange: true });
  assert.deepEqual(frpDecision(ping, "notes"), { reject: false, unchange: true });

  for (const [request, slug] of [
    [login, null],
    [proxy({}), null],
    // expired, revoked, account disabled or builder removed from the app since the login: the tunnel drops
    [ping, null],
    [proxy({ subdomain: "preview-other" }), "notes"],
    [proxy({ subdomain: "notes" }), "notes"],
    [proxy({ subdomain: undefined }), "notes"],
    [proxy({ proxy_type: "tcp", remote_port: 2222 }), "notes"],
    [proxy({ proxy_type: "https" }), "notes"],
    [proxy({ custom_domains: ["evil.example"] }), "notes"],
    [{ op: "NewUserConn", content: {} }, "notes"],
  ] as const) {
    assert.equal(frpDecision(request, slug).reject, true, JSON.stringify([request, slug]));
  }
});
