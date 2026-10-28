// End-to-end test of M6 email and app auth policy against the running "plat" stack (local install: SMTP to mailpit):
// sign-up confirmation (U1), password reset (U4), invitations by email (B5) and configure_auth (B6), on a disposable app.
// Every email is read from mailpit's API (test/mailpit.ts).
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createClient } from "@supabase/supabase-js";
import { cleanup, cli, psql, runId, waitForControlPlane } from "./disposable.ts";
import { confirmSignup, deleteMails, followLink, fragmentParams, mailLink, waitForMail } from "./mailpit.ts";

const ROOT = new URL("../../../", import.meta.url);
const env = Object.fromEntries(
  readFileSync(new URL("deploy/.env.local", ROOT), "utf8").split("\n").filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const MCP_URL = env.PLATFORM_URL ?? "http://api.localhost:8100/mcp";
const ADMIN_URL = "http://admin.localhost:8100";
const APP = `e2e-${runId()}-mail`;
const APP_URL = `http://${APP}.localhost:8100`;
const OWNER = `${APP}-owner@example.com`;
const COLLAB = `${APP}-collab@example.com`;
const PLATFORM_SENDER = "noreply@platform.localhost";
const PASSWORD = "password-123";
const options = { auth: { persistSession: false, autoRefreshToken: false } };
/** App users of this run: unique addresses, so that mailpit searches only see this run's emails. */
const user = (name: string, domain = "example.com") => `${APP}-${name}@${domain}`;

async function connect(token: string) {
  const client = new Client({ name: "auth-email-e2e", version: "0.0.0" });
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

async function refused(client: Client, name: string, args: Record<string, unknown>, pattern: RegExp) {
  const result = (await client.callTool({ name, arguments: args })) as ToolResult;
  assert.equal(result.isError, true, `${name} should be refused: ${result.content[0]?.text}`);
  assert.match(result.content[0]!.text, pattern);
}

describe("M6: email and app auth policy", () => {
  let admin: Client;
  let owner: Client;
  let collab: Client;
  let anonKey = "";
  const supabase = () => createClient(APP_URL, anonKey, options);

  before(async () => {
    await waitForControlPlane(MCP_URL);
    admin = await connect(env.PLATFORM_TOKEN);
    // created by the admin (cleanup deletes users before apps, CP-12); a builder owner and a collaborator
    anonKey = (await call(admin, "create_app", { name: "Mail e2e", slug: APP })).anon_key;
    owner = await connect(cli(["create-user", OWNER, "developer"]).trim());
    collab = await connect(cli(["create-user", COLLAB, "developer"]).trim());
    await call(admin, "add_member", { app: APP, email: OWNER, role: "owner" });
    await call(admin, "add_member", { app: APP, email: COLLAB, role: "collaborator" });
  });

  after(async () => {
    for (const client of [admin, owner, collab]) await client?.close();
    await deleteMails(`to:"${APP}"`).catch(() => undefined);
    await cleanup([APP], [OWNER, COLLAB]);
  });

  test("1. get_app shows the auth policy; the platform SMTP is in effect", async () => {
    const { auth } = await call(collab, "get_app", { app: APP });
    assert.deepEqual(auth, {
      ...auth,
      signup_enabled: true,
      email_confirmation: true,
      email_confirmation_effective: true,
      allowed_email_domains: [],
      redirect_urls: [],
      site_url: APP_URL,
      uri_allow_list: [`${APP_URL}/**`],
      smtp_configured: true,
      sender_name: "Mail e2e",
      sender_email: PLATFORM_SENDER,
      sender_overridden: false,
    });
    assert.doesNotMatch(JSON.stringify(auth), /password|mailpit|1025/, "no SMTP server detail for builders");
    const response = await fetch(`${ADMIN_URL}/api/apps/${APP}`, { headers: { authorization: `Bearer ${env.PLATFORM_TOKEN}` } });
    assert.deepEqual((await response.json()).auth, auth, "the same view in the admin console");
  });

  test("2. U1: a new user confirms their address by email before signing in", async () => {
    const email = user("u1");
    const signup = await supabase().auth.signUp({ email, password: PASSWORD });
    assert.ifError(signup.error);
    assert.equal(signup.data.session, null);
    assert.match((await supabase().auth.signInWithPassword({ email, password: PASSWORD })).error?.message ?? "", /not confirmed/i);
    const mail = await confirmSignup(email, APP_URL);
    assert.deepEqual(mail.From, { Name: "Mail e2e", Address: PLATFORM_SENDER }, "the app's name, the platform address");
    assert.ifError((await supabase().auth.signInWithPassword({ email, password: PASSWORD })).error);
  });

  test("3. U4: password reset by email, then a new password", async () => {
    const email = user("u1");
    const client = supabase();
    assert.ifError((await client.auth.resetPasswordForEmail(email, { redirectTo: `${APP_URL}/reset` })).error);
    const mail = await waitForMail(`to:"${email}" subject:"Reset your password"`);
    const link = mailLink(mail);
    assert.ok(link.startsWith(`${APP_URL}/auth/v1/verify?`), link);
    assert.equal(new URL(link).searchParams.get("redirect_to"), `${APP_URL}/reset`);
    // the link signs the user in on the app's reset page (recovery session in the fragment)
    const location = await followLink(link);
    assert.ok(location.startsWith(`${APP_URL}/reset#`), location);
    const params = fragmentParams(location);
    assert.equal(params.get("type"), "recovery");
    const session = await client.auth.setSession({
      access_token: params.get("access_token")!,
      refresh_token: params.get("refresh_token")!,
    });
    assert.ifError(session.error);
    assert.ifError((await client.auth.updateUser({ password: "new-password-456" })).error);
    assert.match((await supabase().auth.signInWithPassword({ email, password: PASSWORD })).error?.message ?? "", /invalid/i);
    assert.ifError((await supabase().auth.signInWithPassword({ email, password: "new-password-456" })).error);
    // a link used once no longer works
    const reused = await followLink(link);
    assert.match(reused, /error/);

    // a redirect outside the allow list falls back to the app's URL
    const other = user("u2");
    assert.ifError((await supabase().auth.signUp({ email: other, password: PASSWORD })).error);
    assert.ifError((await supabase().auth.resetPasswordForEmail(other, { redirectTo: "https://evil.example/steal" })).error);
    const fallback = mailLink(await waitForMail(`to:"${other}" subject:"Reset your password"`));
    assert.equal(new URL(fallback).searchParams.get("redirect_to"), APP_URL);
  });

  test("4. B5: invite_user emails the invitation, the link is never returned", async () => {
    const guest = user("guest");
    const invited = await call(collab, "invite_user", { app: APP, email: guest });
    assert.equal(invited.email_sent, true);
    assert.equal(invited.invite_link, undefined);
    assert.doesNotMatch(JSON.stringify(invited), /verify|token=/);
    assert.equal(invited.user.confirmed, false);
    const mail = await waitForMail(`to:"${guest}" subject:"invited"`);
    // the platform's template (app-mail.ts), not GoTrue's generic one
    assert.equal(mail.Subject, "You're invited to Mail e2e");
    assert.match(mail.HTML, /You have been invited to join <strong>Mail e2e<\/strong>/);
    const location = await followLink(mailLink(mail));
    assert.ok(location.startsWith(APP_URL), location);
    assert.equal(fragmentParams(location).get("type"), "invite");
    assert.equal((await call(collab, "list_auth_users", { app: APP, filter: guest })).users[0].confirmed, true);
    const audited = JSON.parse(psql(`select l.details from audit_log l join apps a on a.id = l.app_id
      where a.slug = '${APP}' and l.action = 'invite_user'`));
    assert.deepEqual(audited, { email: guest, user_id: invited.user.id, email_sent: true });
  });

  test("5. B6: configure_auth is for owners and admins, validated", async () => {
    await refused(collab, "configure_auth", { app: APP, signup_enabled: false }, /only an owner .* or an admin/);
    await refused(owner, "configure_auth", { app: APP, allowed_email_domains: ["not a domain"] }, /invalid email domain/);
    await refused(owner, "configure_auth", { app: APP, redirect_urls: ["javascript:alert(1)"] }, /invalid redirect URL/);
    await refused(owner, "configure_auth", { app: APP, redirect_urls: ["https://a.example,https://b.example"] }, /invalid redirect URL/);
    await refused(owner, "configure_auth", { app: APP, sender_email: "ceo@acme.example" }, /platform sender's domain/);
    const same = await call(owner, "configure_auth", { app: APP, signup_enabled: true });
    assert.equal(same.changed, false, "nothing to change: GoTrue is not restarted");
  });

  test("6. B6: sign-up disabled, then restricted to an email domain", async () => {
    const off = await call(owner, "configure_auth", { app: APP, signup_enabled: false });
    assert.equal(off.changed, true);
    assert.equal(off.auth.signup_enabled, false);
    assert.equal((await call(collab, "get_app", { app: APP })).auth.signup_enabled, false);
    assert.match((await supabase().auth.signUp({ email: user("nope"), password: PASSWORD })).error?.message ?? "", /signups not allowed/i);
    // invitations still create accounts
    assert.equal((await call(collab, "invite_user", { app: APP, email: user("guest2") })).email_sent, true);

    const restricted = await call(owner, "configure_auth", {
      app: APP,
      signup_enabled: true,
      allowed_email_domains: ["Allowed.test", "@allowed.test"],
    });
    assert.deepEqual(restricted.auth.allowed_email_domains, ["allowed.test"], "normalized");
    const refusedSignup = await supabase().auth.signUp({ email: user("outside"), password: PASSWORD });
    assert.match(refusedSignup.error?.message ?? "", /restricted to email addresses of: allowed\.test/);
    const inside = await supabase().auth.signUp({ email: user("inside", "allowed.test"), password: PASSWORD });
    assert.ifError(inside.error);
    await refused(collab, "invite_user", { app: APP, email: user("outside2") }, /restricted/);
    assert.equal((await call(collab, "invite_user", { app: APP, email: user("guest3", "allowed.test") })).email_sent, true);
    assert.equal((await call(collab, "list_auth_users", { app: APP, filter: "outside" })).total, 0);

    await call(owner, "configure_auth", { app: APP, allowed_email_domains: [] });
    assert.ifError((await supabase().auth.signUp({ email: user("anywhere"), password: PASSWORD })).error);
  });

  test("7. B6: redirect URLs and sender override", async () => {
    const result = await call(owner, "configure_auth", {
      app: APP,
      redirect_urls: ["http://localhost:5173/**"],
      sender_name: "Acme Support",
      sender_email: "support@platform.localhost",
    });
    assert.deepEqual(result.auth.uri_allow_list, [`${APP_URL}/**`, "http://localhost:5173/**"]);
    assert.equal(result.auth.sender_overridden, true);
    const email = user("u3");
    const signup = await supabase().auth.signUp({
      email,
      password: PASSWORD,
      options: { emailRedirectTo: "http://localhost:5173/welcome" },
    });
    assert.ifError(signup.error);
    const mail = await waitForMail(`to:"${email}" subject:"Confirm"`);
    assert.deepEqual(mail.From, { Name: "Acme Support", Address: "support@platform.localhost" });
    assert.equal(new URL(mailLink(mail)).searchParams.get("redirect_to"), "http://localhost:5173/welcome");

    // admins may use another domain; null goes back to the defaults
    assert.equal((await call(admin, "configure_auth", { app: APP, sender_email: "team@acme.example" })).auth.sender_email, "team@acme.example");
    const reset = await call(owner, "configure_auth", { app: APP, sender_name: null, sender_email: null, redirect_urls: [] });
    assert.equal(reset.auth.sender_name, "Mail e2e");
    assert.equal(reset.auth.sender_email, PLATFORM_SENDER);
    assert.deepEqual(reset.auth.uri_allow_list, [`${APP_URL}/**`]);
  });

  test("8. B6: without email confirmation, sign-up gives a session at once", async () => {
    const result = await call(owner, "configure_auth", { app: APP, email_confirmation: false });
    assert.equal(result.auth.email_confirmation_effective, false);
    const signup = await supabase().auth.signUp({ email: user("instant"), password: PASSWORD });
    assert.ifError(signup.error);
    assert.ok(signup.data.session, "auto-confirmed");
  });

  test("9. audited with the changes; refused on a stopped app", async () => {
    const entries = psql(`select string_agg(u.email || ':' || (select string_agg(k, ',' order by k)
        from jsonb_object_keys(l.details->'changes') k), ' ' order by l.id)
      from audit_log l join apps a on a.id = l.app_id join users u on u.id = l.user_id
      where a.slug = '${APP}' and l.action = 'configure_auth'`);
    assert.equal(entries, [
      `${OWNER}:signup_enabled`,
      `${OWNER}:allowed_email_domains,signup_enabled`,
      `${OWNER}:allowed_email_domains`,
      `${OWNER}:redirect_urls,sender_email,sender_name`,
      `${env.PLATFORM_ADMIN_EMAIL ?? "admin@example.com"}:sender_email`,
      `${OWNER}:redirect_urls,sender_email,sender_name`,
      `${OWNER}:email_confirmation`,
    ].join(" "));
    await call(owner, "stop_app", { app: APP });
    await refused(owner, "configure_auth", { app: APP, signup_enabled: false }, /APP_STOPPED/);
    assert.equal((await call(owner, "get_app", { app: APP })).auth.signup_enabled, true, "still readable");
  });
});
