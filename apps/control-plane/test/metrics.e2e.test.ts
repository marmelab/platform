// End-to-end test of the load metrics (app_metrics, M4 phase 2) against the running "plat" stack: traffic on a
// disposable app (successful calls, a function that answers 500, PostgREST 404s, maintenance responses), counted from
// Caddy's access log after forcing a sample, then the admin API's load fields, hourly series and abandoned flag.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import * as tar from "tar";
import { cleanup, cli, psql, runId, waitForControlPlane } from "./disposable.ts";
import { deleteMails, searchMails, waitForMails } from "./mailpit.ts";

const ROOT = new URL("../../../", import.meta.url);
const env = Object.fromEntries(
  readFileSync(new URL("deploy/.env.local", ROOT), "utf8").split("\n").filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const MCP_URL = env.PLATFORM_URL ?? "http://api.localhost:8100/mcp";
const ADMIN_EMAIL = env.PLATFORM_ADMIN_EMAIL ?? "admin@example.com";
const ADMIN = "http://admin.localhost:8100";
const APP = `e2e-${runId()}-met`;
const APP_URL = `http://${APP}.localhost:8100`;
const work = mkdtempSync(join(tmpdir(), "plat-metrics-"));

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const result = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
  if (result.isError) throw new Error(`${name} failed: ${result.content[0]?.text}`);
  return JSON.parse(result.content[0]!.text);
}

async function api(method: string, path: string, body?: unknown): Promise<any> {
  const response = await fetch(`${ADMIN}/api${path}`, {
    method,
    headers: { authorization: `Bearer ${env.PLATFORM_TOKEN}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  assert.equal(response.status, 200, `${method} ${path}: ${text}`);
  return JSON.parse(text);
}

const appRecord = async () => {
  const filter = encodeURIComponent(JSON.stringify({ q: APP }));
  const [app] = await api("GET", `/apps?filter=${filter}&range=${encodeURIComponent("[0,9]")}`);
  assert.equal(app?.slug, APP);
  return app;
};

/** Forces samples until the app's 24 h count reaches `requests` (Caddy writes the entry right after the response). */
async function sampledUntil(requests: number) {
  let app: any;
  for (let i = 0; i < 20; i++) {
    await api("POST", "/metrics/sample", {});
    app = await appRecord();
    if (app.requests_24h >= requests) return app;
    await sleep(250);
  }
  return app;
}

async function hit(path: string, times: number, expected: number) {
  for (let i = 0; i < times; i++) {
    const response = await fetch(`${APP_URL}${path}`);
    await response.body?.cancel();
    assert.equal(response.status, expected, `${path}`);
  }
}

describe("app metrics e2e", () => {
  let admin: Client;
  let startedAt = "";
  let previousSetting = "";

  before(async () => {
    await waitForControlPlane(MCP_URL);
    admin = new Client({ name: "metrics-e2e", version: "0.0.0" });
    await admin.connect(new StreamableHTTPClientTransport(new URL(MCP_URL), {
      requestInit: { headers: { Authorization: `Bearer ${env.PLATFORM_TOKEN}` } },
    }));
    startedAt = psql("select started_at from metrics_state where id = 1");
    previousSetting = psql("select value from settings where key = 'abandoned_after_days'");
  });

  after(async () => {
    await admin?.close();
    if (startedAt) psql(`update metrics_state set started_at = '${startedAt}' where id = 1`);
    if (previousSetting) cli(["set-setting", "abandoned_after_days", previousSetting]);
    else cli(["unset-setting", "abandoned_after_days"]);
    await cleanup([APP], []);
  });

  test("1. requests and 5xx per app, counted from Caddy's access log", async () => {
    await call(admin, "create_app", { name: "Metrics e2e", slug: APP });
    const project = join(work, "project");
    for (const [name, body] of [
      ["ok", `Deno.serve(() => Response.json({ ok: true }));\n`],
      ["boom", `Deno.serve(() => new Response("boom", { status: 500 }));\n`],
    ]) {
      mkdirSync(join(project, "supabase/functions", name!), { recursive: true });
      writeFileSync(join(project, "supabase/functions", name!, "index.ts"), body!);
    }
    writeFileSync(join(project, "supabase/config.toml"), `[functions.ok]\nverify_jwt = false\n\n[functions.boom]\nverify_jwt = false\n`);
    const file = join(work, "functions.tgz");
    await tar.c({ gzip: true, cwd: project, file, portable: true }, ["supabase"]);
    const created = await call(admin, "create_deployment", { app: APP, kind: "functions" });
    const upload = await fetch(created.upload_url, { method: "PUT", body: readFileSync(file) });
    assert.equal(upload.status, 200, await upload.text());
    assert.equal((await call(admin, "finalize_deployment", { deployment_id: created.deployment_id })).status, "live");

    // nothing counted yet: the warm-up of the functions goes through the internal network, not the public host
    const before = await sampledUntil(0);
    assert.equal(before.requests_24h, 0);

    await hit("/functions/v1/ok", 5, 200);
    await hit("/functions/v1/boom", 3, 500);
    await hit("/rest/v1/missing_table", 2, 404);
    const app = await sampledUntil(10);
    assert.equal(app.requests_24h, 10);
    assert.equal(app.errors_24h, 3, "only the function's 500s are errors");
    assert.ok(app.memory > 1_000_000, `memory of GoTrue and PostgREST: ${app.memory}`);
    assert.ok(app.db_size > 0);
    assert.equal(app.traffic_7d.length, 7);
    assert.deepEqual(app.traffic_7d.at(-1), { ...app.traffic_7d.at(-1), requests: 10, errors: 3 });
    assert.ok(Date.now() - new Date(app.last_request_at).getTime() < 120_000, "last_request_at");

    // a second sample does not count the same lines again (cursor in metrics_state)
    const again = JSON.parse(cli(["sample-metrics"]));
    assert.equal(typeof again.log_lines, "number");
    assert.equal((await appRecord()).requests_24h, 10);

    const series = await api("GET", `/apps/${APP}/metrics?days=1`);
    assert.equal(series.hours.length, 24);
    const current = series.hours.at(-1);
    assert.equal(current.requests, 10);
    assert.equal(current.responses_5xx, 3);
    assert.ok(current.db_size_bytes > 0 && current.memory_bytes > 0);
    assert.ok(series.sampled_at);
  });

  test("2. maintenance responses of a stopped app are requests, not errors", async () => {
    await api("POST", `/apps/${APP}/stop`, {});
    await hit("/", 2, 503);
    await hit("/functions/v1/boom", 1, 503);
    const app = await sampledUntil(13);
    assert.equal(app.requests_24h, 13);
    assert.equal(app.errors_24h, 3);
    assert.equal(app.memory, 0, "containers stopped");
    await api("POST", `/apps/${APP}/start`, {});
  });

  test("3. dashboard totals include the app", async () => {
    const stats = await api("GET", "/dashboard");
    assert.ok(stats.load.requests_24h >= 13);
    assert.ok(stats.load.errors_24h >= 3);
    assert.ok(stats.load.memory > 0);
    assert.equal(stats.load.traffic_7d.length, 7);
    assert.ok(stats.load.traffic_7d.at(-1).requests >= 13);
    assert.equal(typeof stats.flagged.abandoned, "number");
  });

  test("4. abandoned: no request and no release for abandoned_after_days (A6)", async () => {
    assert.equal((await appRecord()).flags.abandoned, false, "used right now");
    // as if the app had been created, deployed (the functions release of test 1) and used 40 days ago
    psql(`update apps set created_at = now() - interval '40 days', last_request_at = now() - interval '40 days'
           where slug = '${APP}'`);
    psql(`update releases set started_at = now() - interval '40 days', finished_at = now() - interval '40 days'
           where app_id = (select id from apps where slug = '${APP}')`);
    // the flag waits until the metrics have been collected for that long
    assert.equal((await appRecord()).flags.abandoned, false, "metrics younger than 30 days");
    psql("update metrics_state set started_at = now() - interval '40 days' where id = 1");
    const app = await appRecord();
    assert.equal(app.flags.abandoned, true);
    assert.ok(new Date(app.last_activity_at).getTime() < Date.now() - 39 * 86_400_000);
    const filter = encodeURIComponent(JSON.stringify({ abandoned: true, q: APP }));
    assert.equal((await api("GET", `/apps?filter=${filter}`)).length, 1);
    cli(["set-setting", "abandoned_after_days", "60"]);
    assert.equal((await appRecord()).flags.abandoned, false, "setting applied at once");
    assert.throws(() => cli(["set-setting", "abandoned_after_days", "0"]), /whole number of days/);
  });

  test("5. abandoned: the owners are emailed once per transition (A6, M6)", async () => {
    const count = () => Number(psql(`select count(*) from audit_log l join apps a on a.id = l.app_id
      where a.slug = '${APP}' and l.action = 'notify_abandoned'`));
    const notifiedAt = () => psql(`select coalesce(abandoned_notified_at::text, '') from apps where slug = '${APP}'`);
    const query = `to:"${ADMIN_EMAIL}" subject:"${APP}"`;
    // a notice the in-process sampler may have sent during test 4's backdating does not count
    psql(`update apps set abandoned_notified_at = null where slug = '${APP}'`);
    await deleteMails(query);
    const before = count();
    const notices = () => String(count() - before);
    // still flagged by test 4's backdating; abandoned_after_days back to 30 days
    cli(["set-setting", "abandoned_after_days", "30"]);
    assert.equal((await appRecord()).flags.abandoned, true);
    await api("POST", "/metrics/sample", {}); // the in-process sampler may have sent it already
    const [mail] = await waitForMails(query);
    assert.match(mail!.Subject, /looks abandoned/);
    assert.deepEqual(mail!.From, { Name: "Platform", Address: "noreply@platform.localhost" });
    assert.ok(mail!.Text.includes(APP_URL), "the app's URL");
    assert.match(mail!.Text, /more than 30 days/);
    assert.equal(notices(), "1");
    assert.notEqual(notifiedAt(), "");
    const audit = JSON.parse(psql(`select l.details from audit_log l join apps a on a.id = l.app_id
      where a.slug = '${APP}' and l.action = 'notify_abandoned' order by l.id desc limit 1`));
    assert.deepEqual(audit.recipients, [ADMIN_EMAIL]);

    // once: later samples do not send it again
    const sample = await api("POST", "/metrics/sample", {});
    assert.ok(!sample.abandoned_notified.includes(APP));
    assert.equal((await searchMails(query)).length, 1);
    assert.equal(notices(), "1");

    // active again (here: a longer threshold), then abandoned again: a new notice
    cli(["set-setting", "abandoned_after_days", "60"]);
    await api("POST", "/metrics/sample", {});
    assert.equal(notifiedAt(), "", "cleared when the app is no longer abandoned");
    cli(["set-setting", "abandoned_after_days", "30"]);
    await api("POST", "/metrics/sample", {});
    await waitForMails(query, 2);
    assert.equal(notices(), "2");
  });
});
