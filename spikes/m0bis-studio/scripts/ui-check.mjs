// Headless walk through Studio for every registered app: forward-auth login, Studio login,
// then one screenshot per feature page + the list of failing /api calls. Usage: pnpm ui [page...]
import { chromium } from "playwright";
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from "node:fs";

const dir = new URL("..", import.meta.url).pathname;
const env = Object.fromEntries(
  readFileSync(`${dir}.env`, "utf8").split("\n").filter(Boolean).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const STUDIO = "http://studio.localhost:8080";
const apps = readdirSync(`${dir}apps`)
  .filter((a) => existsSync(`${dir}apps/${a}/studio.json`))
  .map((a) => JSON.parse(readFileSync(`${dir}apps/${a}/studio.json`, "utf8")));

const PAGES = {
  "table-editor": "editor",
  "sql-editor": "sql/new",
  policies: "auth/policies",
  roles: "database/roles",
  tables: "database/tables",
  users: "auth/users",
  storage: "storage/buckets",
  functions: "functions",
  logs: "logs/explorer",
};
const only = process.argv.slice(2);
mkdirSync(`${dir}screenshots`, { recursive: true });

// reuse any headless shell already in the Playwright cache (no download)
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`;
const shell = existsSync(cache)
  ? readdirSync(cache).filter((d) => d.startsWith("chromium_headless_shell-")).sort().reverse()
      .map((d) => `${cache}/${d}/chrome-headless-shell-mac-arm64/chrome-headless-shell`).find(existsSync)
  : undefined;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || shell });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
let failures = [];
page.on("response", (r) => {
  if (r.url().includes("/api/") && r.status() >= 400) failures.push(`${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`);
});
page.on("requestfailed", (r) => failures.push(`FAILED ${r.method()} ${r.url()} ${r.failure()?.errorText}`));

// 1. forward auth (mock SSO)
await page.goto(`${STUDIO}/`);
await page.screenshot({ path: `${dir}screenshots/00-forward-auth-login.png` });
await page.fill('input[name="user"]', env.FWD_AUTH_USER);
await page.fill('input[name="password"]', env.FWD_AUTH_PASSWORD);
await Promise.all([page.waitForNavigation(), page.click("button")]);
await page.waitForTimeout(4000);
// 2. Studio's own login (GoTrue)
if (page.url().includes("sign-in")) {
  await page.screenshot({ path: `${dir}screenshots/01-studio-sign-in.png` });
  await page.fill('input[type="email"]', env.STUDIO_ADMIN_EMAIL);
  await page.fill('input[type="password"]', env.STUDIO_ADMIN_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForTimeout(6000);
}
await page.goto(`${STUDIO}/projects`);
await page.waitForTimeout(6000);
await page.screenshot({ path: `${dir}screenshots/02-projects.png` });

const report = [];
for (const app of apps) {
  for (const [name, path] of Object.entries(PAGES)) {
    if (only.length && !only.includes(name)) continue;
    failures = [];
    await page.goto(`${STUDIO}/project/${app.studio_ref}/${path}`);
    await page.waitForTimeout(9000);
    if (name === "table-editor") {
      await page.getByText("todos", { exact: true }).first().click().catch(() => {});
      await page.waitForTimeout(7000);
    }
    if (name === "sql-editor") {
      await page.locator(".monaco-editor").first().click().catch(() => {});
      await page.keyboard.type("select current_user, current_database(), count(*) as users from auth.users;");
      await page.keyboard.press("Meta+Enter");
      await page.waitForTimeout(6000);
    }
    const file = `screenshots/${app.app}-${name}.png`;
    await page.screenshot({ path: `${dir}${file}` });
    const text = (await page.locator("main").first().innerText().catch(() => page.innerText("body"))).replace(/\s+/g, " ").slice(0, 300);
    report.push({ app: app.app, page: name, url: page.url().replace(STUDIO, ""), failures: [...new Set(failures)], text, file });
    console.log(`${app.app} ${name}: ${[...new Set(failures)].length} failing calls`);
  }
}
writeFileSync(`${dir}results/ui-check${only.length ? "-" + only.join("-") : ""}.json`, JSON.stringify(report, null, 2));
await browser.close();
