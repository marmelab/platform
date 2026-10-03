// Unit tests of the app auth policy (M6): the GoTrue environment with and without the platform SMTP, the hook SQL.
import assert from "node:assert/strict";
import { test } from "node:test";
import { authEnv, authHookSql, authView, DEFAULT_AUTH, DOMAIN_RE, REDIRECT_URL_RE } from "../src/auth-policy.ts";
import type { SmtpSettings } from "../src/settings.ts";

const app = { slug: "demo", name: "Demo app", url: "https://demo.apps.example.com" };
const smtp: SmtpSettings = {
  host: "smtp.example.com",
  port: 587,
  user: "relay",
  password: "s3cret",
  senderEmail: "noreply@example.com",
  senderName: "Platform",
};

test("without SMTP: users are auto-confirmed, no SMTP variable, links on the app's /auth/v1", () => {
  const env = authEnv(app, DEFAULT_AUTH, null);
  assert.equal(env.GOTRUE_MAILER_AUTOCONFIRM, "true");
  assert.equal(env.GOTRUE_DISABLE_SIGNUP, "false");
  assert.equal(env.GOTRUE_SITE_URL, app.url);
  assert.equal(env.GOTRUE_URI_ALLOW_LIST, `${app.url}/**`);
  for (const kind of ["INVITE", "CONFIRMATION", "RECOVERY", "EMAIL_CHANGE"]) {
    assert.equal(env[`GOTRUE_MAILER_URLPATHS_${kind}`], "/auth/v1/verify");
  }
  assert.deepEqual(Object.keys(env).filter((k) => k.startsWith("GOTRUE_SMTP_") || k.includes("HOOK")), []);
  const view = authView(app, DEFAULT_AUTH, null);
  assert.equal(view.email_confirmation, true);
  assert.equal(view.email_confirmation_effective, false);
  assert.equal(view.smtp_configured, false);
  assert.equal(view.sender_email, null);
});

test("with SMTP: confirmation required, the app's name as sender, the platform address", () => {
  const env = authEnv(app, DEFAULT_AUTH, smtp);
  assert.equal(env.GOTRUE_MAILER_AUTOCONFIRM, "false");
  assert.equal(env.GOTRUE_SMTP_HOST, "smtp.example.com");
  assert.equal(env.GOTRUE_SMTP_PORT, "587");
  assert.equal(env.GOTRUE_SMTP_USER, "relay");
  assert.equal(env.GOTRUE_SMTP_PASS, "s3cret");
  assert.equal(env.GOTRUE_SMTP_ADMIN_EMAIL, "noreply@example.com");
  assert.equal(env.GOTRUE_SMTP_SENDER_NAME, "Demo app");
  const view = authView(app, DEFAULT_AUTH, smtp);
  assert.equal(view.email_confirmation_effective, true);
  assert.ok(!JSON.stringify(view).includes("s3cret"), "no SMTP secret in the view");
});

test("the builder's policy: sign-up off, no confirmation, redirect URLs, sender override, allowed domains", () => {
  const auth = {
    ...DEFAULT_AUTH,
    signup_enabled: false,
    email_confirmation: false,
    redirect_urls: ["http://localhost:5173/**"],
    sender_name: "Acme Support\r\nBcc: x@evil.test",
    sender_email: "support@example.com",
    allowed_email_domains: ["example.com", "acme.test"],
  };
  const env = authEnv(app, auth, smtp);
  assert.equal(env.GOTRUE_DISABLE_SIGNUP, "true");
  assert.equal(env.GOTRUE_MAILER_AUTOCONFIRM, "true");
  assert.equal(env.GOTRUE_URI_ALLOW_LIST, `${app.url}/**,http://localhost:5173/**`);
  assert.equal(env.GOTRUE_SMTP_ADMIN_EMAIL, "support@example.com");
  assert.equal(env.GOTRUE_SMTP_SENDER_NAME, "Acme Support Bcc: x@evil.test", "no header injection");
  assert.equal(env.GOTRUE_HOOK_BEFORE_USER_CREATED_ENABLED, "true");
  assert.equal(env.GOTRUE_HOOK_BEFORE_USER_CREATED_URI, "pg-functions://postgres/_platform/before_user_created");
});

test("hook SQL: domains only from the validated pattern", () => {
  const sql = authHookSql("app_demo_auth_admin", ["example.com", "acme.test"]).join(";\n");
  assert.match(sql, /array\['example\.com', 'acme\.test'\]::text\[\]/);
  assert.match(sql, /grant execute on function _platform\.before_user_created\(jsonb\) to app_demo_auth_admin/);
  assert.match(authHookSql("app_demo_auth_admin", []).join(";"), /array\[\]::text\[\]/);
  assert.throws(() => authHookSql("app_demo_auth_admin", ["x'; drop table users; --"]), /unsafe domain/);
  for (const bad of ["", "localhost", "-a.com", "a..com", "a.com'", "exa mple.com"]) assert.ok(!DOMAIN_RE.test(bad), bad);
  for (const good of ["example.com", "mail.example.co.uk", "acme.test"]) assert.ok(DOMAIN_RE.test(good), good);
});

test("redirect URLs: http(s), globs, no comma", () => {
  for (const good of ["http://localhost:5173/**", "https://app.example.com/auth/callback", "https://*.example.com"]) {
    assert.ok(REDIRECT_URL_RE.test(good), good);
  }
  for (const bad of ["javascript:alert(1)", "ftp://x", "https://a.com,https://b.com", "https://a .com", "//a.com"]) {
    assert.ok(!REDIRECT_URL_RE.test(bad), bad);
  }
});
