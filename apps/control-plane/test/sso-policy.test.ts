// Unit tests of the company SSO checks (M6 part 2, src/sso-policy.ts): the IdP's email claims against the platform
// policy, the authorized party, PKCE, client authentication, the password login policy and the local redirect paths.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  basicAuth,
  checkAuthorizedParty,
  checkedEmail,
  passwordLoginRefused,
  pkceChallenge,
  safeNext,
  SsoError,
  tokenAuthMethod,
} from "../src/sso-policy.ts";

const policy = { requireVerifiedEmail: true, allowedDomains: ["example.com"] };
const reason = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof SsoError, String(error));
    return error.reason;
  }
  return "accepted";
};

test("email: required, verified unless the admin turned that off, within the allowed domains (exact, lowercased)", () => {
  assert.equal(checkedEmail({ email: " Alice@Example.COM ", email_verified: true }, policy), "alice@example.com");
  assert.equal(checkedEmail({ email: "alice@example.com", email_verified: "true" }, policy), "alice@example.com");
  assert.equal(reason(() => checkedEmail({ email_verified: true }, policy)), "no_email");
  assert.equal(reason(() => checkedEmail({ email: "not-an-email", email_verified: true }, policy)), "no_email");
  assert.equal(reason(() => checkedEmail({ email: "alice@example.com" }, policy)), "email_not_verified");
  assert.equal(reason(() => checkedEmail({ email: "alice@example.com", email_verified: false }, policy)), "email_not_verified");
  assert.equal(checkedEmail({ email: "alice@example.com" }, { ...policy, requireVerifiedEmail: false }), "alice@example.com");
  assert.equal(reason(() => checkedEmail({ email: "eve@evil.example.com", email_verified: true }, policy)), "domain_not_allowed");
  assert.equal(reason(() => checkedEmail({ email: "eve@example.com.evil.io", email_verified: true }, policy)), "domain_not_allowed");
  assert.equal(reason(() => checkedEmail({ email: "eve@evil.io@example.com", email_verified: true }, policy)), "no_email");
  assert.equal(checkedEmail({ email: "bob@anything.io", email_verified: true }, { ...policy, allowedDomains: [] }), "bob@anything.io");
});

test("authorized party: required to be us with several audiences, checked when present", () => {
  assert.equal(reason(() => checkAuthorizedParty({ aud: "platform" }, "platform")), "accepted");
  assert.equal(reason(() => checkAuthorizedParty({ aud: ["platform", "other"], azp: "platform" }, "platform")), "accepted");
  assert.equal(reason(() => checkAuthorizedParty({ aud: ["platform", "other"] }, "platform")), "azp_mismatch");
  assert.equal(reason(() => checkAuthorizedParty({ aud: "platform", azp: "other" }, "platform")), "azp_mismatch");
});

test("PKCE S256 (RFC 7636 appendix B) and client authentication", () => {
  assert.equal(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  assert.equal(tokenAuthMethod(undefined), "basic");
  assert.equal(tokenAuthMethod(["client_secret_post", "client_secret_basic"]), "basic");
  assert.equal(tokenAuthMethod(["client_secret_post"]), "post");
  assert.equal(reason(() => tokenAuthMethod(["private_key_jwt"])), "unsupported_client_auth");
  assert.equal(basicAuth("a:b", "p@ss word"), `Basic ${Buffer.from("a%3Ab:p%40ss%20word").toString("base64")}`);
});

test("password sign-in: only restricted while SSO is active with password_login=admins, never for admins", () => {
  assert.equal(passwordLoginRefused("developer", { passwordLogin: "admins" }, true), true);
  assert.equal(passwordLoginRefused("admin", { passwordLogin: "admins" }, true), false);
  assert.equal(passwordLoginRefused("developer", { passwordLogin: "admins" }, false), false);
  assert.equal(passwordLoginRefused("developer", { passwordLogin: "everyone" }, true), false);
});

test("next: local paths only", () => {
  assert.equal(safeNext("/project/demo", "/projects"), "/project/demo");
  for (const bad of ["https://evil.io/", "//evil.io/", "/\\evil.io", "javascript:alert(1)", "", undefined, null]) {
    assert.equal(safeNext(bad, "/projects"), "/projects", String(bad));
  }
});
