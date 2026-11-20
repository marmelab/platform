import assert from "node:assert/strict";
import { test } from "node:test";
import { welcomeMail } from "../src/welcome-mail.ts";

const start = "https://claude.ai/code?environment=Platform&prompt=Build%20me%20an%20app";
const connectPage = "https://example.com/_platform/claude";
const base = {
  role: "developer" as const,
  apiUrl: "https://api.example.com",
  studioUrl: "https://example.com",
  adminUrl: "https://admin.example.com",
  sso: null,
  claude: { organization: true, start, connectPage },
};
const PLUGIN = "claude plugin install platform --marketplace https://api.example.com/plugin/marketplace.json";
/** The HTML without its tags' attributes: what the reader sees. */
const visible = (html: string) => html.replace(/<[^>]*>/g, " ");

test("organization connector: its steps, then the first session; the Connect Claude page is not needed", () => {
  const { text, html } = welcomeMail(base);
  assert.match(text, /^\d\. On claude\.ai, open Customize > Connectors\.\n\d\. Choose Platform\.\n\d\. Click Connect\.$/m);
  assert.match(text, /^\d\. Start building: https:\/\/claude\.ai\/code\?environment=Platform&prompt=Build%20me%20an%20app$/m);
  assert.ok(!text.includes(connectPage) && !html.includes(connectPage));
  assert.ok(html.includes(`href="${start.replaceAll("&", "&#38;")}"`), "the button links the session");
});

test("personal connectors: the Connect Claude page first, then the first session", () => {
  const { text } = welcomeMail({ ...base, claude: { ...base.claude, organization: false } });
  const page = text.indexOf(`Open the Connect Claude page: ${connectPage}`);
  assert.ok(page > 0 && page < text.indexOf(`Start building: ${start}`));
  assert.ok(!text.includes("Customize > Connectors"));
});

test("the plan is never named; links show their label, not their URL", () => {
  for (const organization of [true, false]) {
    const { text, html } = welcomeMail({ ...base, claude: { ...base.claude, organization } });
    assert.doesNotMatch(text, /Team|Enterprise|Pro\b|Max\b/);
    const seen = visible(html);
    for (const url of [start, connectPage, base.studioUrl]) assert.ok(!seen.includes(url), url);
    assert.match(seen, /Start building/);
    assert.match(seen, /Open Studio/);
    assert.ok(seen.includes(PLUGIN), "a command to copy stays visible");
  }
});

test("Claude Code on the computer comes last, as advanced usage", () => {
  const { text } = welcomeMail(base);
  const advanced = text.indexOf("ADVANCED: CLAUDE CODE ON YOUR COMPUTER");
  assert.ok(advanced > text.indexOf("BUILD YOUR FIRST APP") && advanced > text.indexOf("SEE YOUR APPS' DATA"));
  assert.ok(text.indexOf(PLUGIN) > advanced);
  assert.match(text, /^- Node\.js 22\.18 or later\.$/m);
});

test("sign-in: the company account with SSO (never the IdP's name), the password line only when one applies", () => {
  const password = welcomeMail(base).text;
  assert.match(password, /^\d\. Sign in with your email and password\.$/m);
  assert.match(password, /never sent by email/);
  const sso = welcomeMail({ ...base, sso: { passwordToo: false } }).text;
  assert.match(sso, /^\d\. Sign in with your company account\.$/m);
  assert.match(sso, /In the browser that opens, sign in with your company account\./);
  assert.ok(!sso.includes("password"));
  assert.match(welcomeMail({ ...base, sso: { passwordToo: true } }).text, /never sent by email/);
});

test("admins: the admin console; without Claude Code on the web, no build section", () => {
  const builder = welcomeMail(base).text;
  assert.ok(!builder.includes(base.adminUrl));
  const admin = welcomeMail({ ...base, role: "admin", claude: null }).text;
  assert.match(admin, /^Your admin account on the company's app platform is ready\.$/m);
  assert.match(admin, /^- Open the admin console: https:\/\/admin\.example\.com$/m);
  assert.ok(!admin.includes("BUILD YOUR FIRST APP") && !admin.includes("claude.ai"));
  assert.ok(admin.includes(PLUGIN));
});

test("the HTML escapes what it shows", () => {
  const { html } = welcomeMail({ ...base, studioUrl: `https://example.com/"><script>` });
  assert.ok(!html.includes("<script>"));
  assert.match(html, /^<!doctype html>/);
});
