// Usage: node shot.mjs <slug> <out.png> — sign up in the UI, add two todos, screenshot
import { chromium } from "playwright-core";
const [slug, out] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
page.on("console", (m) => m.type() === "error" && console.log("console:", m.text()));
await page.goto(`http://${slug}.localhost:8100`);
await page.fill('input[type=email]', `ui-${Date.now()}@example.com`);
await page.fill('input[type=password]', "password123");
await page.click('text=Sign up');
await page.waitForSelector('text=Sign out');
for (const t of ["Buy milk", "Ship M3"]) {
  if (t === "Ship M3" && await page.locator("select").count()) await page.selectOption("select", "2");
  await page.fill('input[placeholder="What needs to be done?"]', t);
  await page.click('button:text("Add")');
  await page.waitForSelector(`text=${t}`);
}
await page.locator('li input[type=checkbox]').first().click();
await page.waitForSelector('text=1 of 2 done');
await page.screenshot({ path: out });
console.log(await page.locator("main").innerText());
await browser.close();
