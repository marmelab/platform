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
  connectPage: "https://example.com/_platform/claude",
};
const PLUGIN = /claude plugin install platform --marketplace https:\/\/api\.example\.com\/plugin\/marketplace\.json\n/;

test("without Claude Code on the web: the plugin, Node and gh", () => {
  const { text } = welcomeMail(base);
  assert.match(text, /^- Build and deploy apps with Claude Code\. You need Node\.js 22\.18/m);
  assert.match(text, PLUGIN);
  assert.ok(!text.includes("claude.ai"));
  assert.ok(!text.includes(base.connectPage));
  assert.match(text, /password over a private channel/);
});

test("with Claude Code on the web: the connector's page, then the first session, the terminal as an alternative", () => {
  const webStart = "https://claude.ai/code?environment=Platform&prompt=Build%20me%20an%20app";
  const { text } = welcomeMail({ ...base, webStart });
  const connect = text.indexOf(`    ${base.connectPage}\n`);
  const web = text.indexOf(webStart);
  assert.ok(connect > 0 && connect < web, "the connector before the session");
  assert.ok(web < text.search(PLUGIN), "the browser path comes first");
  assert.match(text, /one click on claude\.ai Team or Enterprise, three steps on Pro or Max/);
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
