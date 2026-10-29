// The welcome email of a new account (src/welcome-mail.ts): Claude Code on the web first when the platform has a
// claude.ai environment, the terminal path otherwise; never a password.
import assert from "node:assert/strict";
import { test } from "node:test";
import { welcomeMail } from "../src/welcome-mail.ts";

const base = {
  email: "dana@example.com",
  role: "developer" as const,
  apiUrl: "https://api.example.com",
  studioUrl: "https://example.com",
  adminUrl: "https://admin.example.com",
  sso: null,
  webStart: null,
};
const PLUGIN = /claude plugin install platform --marketplace https:\/\/api\.example\.com\/plugin\/marketplace\.json\n/;

test("without Claude Code on the web: the plugin, Node and gh", () => {
  const { text } = welcomeMail(base);
  assert.match(text, /^- Build and deploy apps with Claude Code\. You need Node\.js 22\.18/m);
  assert.match(text, PLUGIN);
  assert.ok(!text.includes("claude.ai"));
  assert.match(text, /password over a private channel/);
});

test("with Claude Code on the web: the connector and the first session first, the terminal as an alternative", () => {
  const webStart = "https://claude.ai/code?environment=Platform&repositories=acme%2Fplatform-starter";
  const { text } = welcomeMail({ ...base, webStart });
  const web = text.indexOf(webStart);
  assert.ok(web > 0 && web < text.search(PLUGIN), "the browser path comes first");
  assert.match(text, /Settings, then Connectors, choose Platform, then Connect/);
  assert.match(text, /^- Or with Claude Code on your computer, with Node\.js 22\.18/m);
});

test("company SSO: Studio sign-in, and no password line when SSO is the only way in", () => {
  const { text } = welcomeMail({ ...base, sso: { name: "Okta", passwordToo: false } });
  assert.match(text, /\(sign in with Okta\)\./);
  assert.ok(!text.includes("password"));
  const admin = welcomeMail({ ...base, role: "admin", sso: { name: "Okta", passwordToo: true } }).text;
  assert.match(admin, /as an admin\./);
  assert.match(admin, /^- Administration console: https:\/\/admin\.example\.com$/m);
  assert.match(admin, /password over a private channel/);
});
