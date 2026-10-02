// End-to-end test of the CI deployment API (/ci/*, GitHub OIDC), link_repo, releases and DIRECT_DEPLOY, against the
// running "plat" stack. A fake OIDC issuer: the test generates an RS256 key pair and points the platform settings
// at it (oidc_issuer + the test-only inline oidc_jwks), then restores the previous settings at the end of the run.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomInt } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { exportJWK, generateKeyPair, type JWTPayload, SignJWT } from "jose";
import * as tar from "tar";
import { cleanup, cli, psql, runId } from "./disposable.ts";

const ROOT = new URL("../../../", import.meta.url);
const env = Object.fromEntries(
  readFileSync(new URL("deploy/.env.local", ROOT), "utf8")
    .split("\n")
    .filter((line) => line.includes("="))
    .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
);
const MCP_URL = env.PLATFORM_URL ?? "http://api.localhost:8100/mcp";
const API_URL = MCP_URL.replace(/\/mcp$/, "");
const RUN_ID = runId();
const APP = `e2e-${RUN_ID}-ci`;
const APP_URL = `http://${APP}.localhost:8100`;
const OWNER = `${APP}-owner@example.com`;
const COLLAB = `${APP}-collab@example.com`;

const ISSUER = `https://oidc.e2e.invalid/${RUN_ID}`;
const KID = `e2e-${RUN_ID}`;
const REPO = `e2e-org/${APP}`;
const REPO_ID = 900_000_000 + randomInt(90_000_000);
const WORKFLOW = "e2e-org/platform-ci/.github/workflows/deploy.yml";
const OTHER_WORKFLOW = "e2e-org/other-ci/.github/workflows/any.yml";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const MANAGED_SETTINGS = ["oidc_issuer", "oidc_jwks", "oidc_audience", "oidc_jwks_url", "ci_allowed_workflows", "direct_deploy"];

const work = mkdtempSync(join(tmpdir(), "plat-e2e-ci-"));
const keys = await generateKeyPair("RS256");
const otherKeys = await generateKeyPair("RS256");

async function connect(token: string) {
  const client = new Client({ name: "e2e-ci", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(MCP_URL), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}

type ToolResult = { isError?: boolean; content: { type: string; text: string }[] };
const callRaw = async (client: Client, name: string, args: Record<string, unknown> = {}) =>
  (await client.callTool({ name, arguments: args })) as ToolResult;

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const result = await callRaw(client, name, args);
  const text = result.content[0]?.text ?? "";
  if (result.isError) throw new Error(`${name} failed: ${text}`);
  return JSON.parse(text);
}

async function refused(client: Client, name: string, args: Record<string, unknown>, pattern: RegExp) {
  const result = await callRaw(client, name, args);
  assert.equal(result.isError, true, `${name} should be refused: ${result.content[0]?.text}`);
  assert.match(result.content[0]!.text, pattern);
}

/** A GitHub Actions OIDC token from the fake issuer: a push on the protected default branch unless overridden. */
async function oidcToken(
  claims: Record<string, unknown> = {},
  options: { key?: CryptoKey; aud?: string; iss?: string; exp?: number; iat?: number } = {},
) {
  const now = Math.floor(Date.now() / 1000);
  const payload: JWTPayload = {
    repository: REPO,
    repository_id: String(REPO_ID),
    ref: "refs/heads/main",
    ref_protected: "true",
    sha: SHA,
    actor: "octocat",
    run_id: "1001",
    run_attempt: "1",
    event_name: "push",
    job_workflow_ref: `${WORKFLOW}@refs/heads/main`,
    ...claims,
  };
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setIssuer(options.iss ?? ISSUER)
    .setAudience(options.aud ?? API_URL)
    .setSubject(`repo:${REPO}:ref:${payload.ref}`)
    .setIssuedAt(options.iat ?? now)
    .setExpirationTime(options.exp ?? now + 300)
    .sign(options.key ?? keys.privateKey);
}

async function ci(method: "GET" | "POST", path: string, token: string | null, body?: unknown) {
  const response = await fetch(`${API_URL}/ci/apps/${APP}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as any };
}

async function ciRefused(method: "GET" | "POST", path: string, token: string | null, status: number, pattern: RegExp,
  body?: unknown) {
  const result = await ci(method, path, token, body);
  assert.equal(result.status, status, JSON.stringify(result.body));
  assert.match(result.body.error, pattern);
}

const todos = {
  version: "20260101000001",
  name: "create_todos",
  sql: readFileSync(new URL("fixtures/todos.sql", import.meta.url), "utf8"),
};

async function frontendArchive(label: string) {
  const dir = join(work, `dist-${label}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.html"), `<!doctype html><title>ci</title><h1>CI ${label}</h1>\n`);
  const file = join(work, `${label}.tgz`);
  await tar.c({ gzip: true, cwd: dir, file, portable: true }, ["."]);
  return new Blob([readFileSync(file)]);
}

async function upload(url: string, archive: Blob) {
  const response = await fetch(url, { method: "PUT", body: archive });
  assert.equal(response.status, 200, await response.text());
}

const settingsSnapshot = () =>
  JSON.parse(psql(`select coalesce(json_object_agg(key, value), '{}') from settings where key in (${
    MANAGED_SETTINGS.map((k) => `'${k}'`).join(", ")
  })`)) as Record<string, string>;

function restoreSettings(saved: Record<string, string>) {
  for (const key of MANAGED_SETTINGS) {
    if (key in saved) cli(["set-setting", key, saved[key]!]);
    else cli(["unset-setting", key]);
  }
}

describe("CI deployment API (GitHub OIDC) and DIRECT_DEPLOY", () => {
  let admin: Client;
  let owner: Client;
  let collab: Client;
  let saved: Record<string, string>;

  before(async () => {
    saved = settingsSnapshot();
    const jwk = { ...(await exportJWK(keys.publicKey)), kid: KID, alg: "RS256", use: "sig" };
    cli(["set-setting", "oidc_issuer", ISSUER]);
    cli(["set-setting", "oidc_jwks", JSON.stringify({ keys: [jwk] })]);
    cli(["set-setting", "ci_allowed_workflows", `${WORKFLOW}@refs/heads/main, ${OTHER_WORKFLOW}`]);
    for (const key of ["oidc_audience", "oidc_jwks_url", "direct_deploy"]) cli(["unset-setting", key]);
    admin = await connect(env.PLATFORM_TOKEN);
    owner = await connect(cli(["create-user", OWNER, "developer"]).trim());
    collab = await connect(cli(["create-user", COLLAB, "developer"]).trim());
    // created by the admin: cleanup() deletes the users before the apps, and apps.owner_id keeps the creator
    await call(admin, "create_app", { name: "CI demo", slug: APP });
    await call(admin, "add_member", { app: APP, email: OWNER, role: "owner" });
    await call(admin, "add_member", { app: APP, email: COLLAB });
  });

  after(async () => {
    if (saved) restoreSettings(saved);
    for (const client of [admin, owner, collab]) await client?.close();
    await cleanup([APP], [OWNER, COLLAB]);
  });

  test("1. link_repo: owner only, audited, shown by get_app", async () => {
    const tools = (await owner.listTools()).tools.map((t) => t.name);
    for (const name of ["link_repo", "begin_release", "finish_release"]) assert.ok(tools.includes(name), name);
    // not linked yet: a valid token is refused
    await ciRefused("GET", "", await oidcToken(), 403, /not linked to repository/);

    const link = { app: APP, repo: REPO, repository_id: REPO_ID, default_branch: "main" };
    await refused(collab, "link_repo", link, /only an owner/);
    await refused(owner, "link_repo", { ...link, default_branch: "refs/heads/main" }, /without refs\/heads/);
    assert.deepEqual(await call(owner, "link_repo", link), {
      slug: APP,
      github_repo: REPO,
      github_repo_id: REPO_ID,
      default_branch: "main",
    });
    const app = await call(collab, "get_app", { app: APP });
    assert.equal(app.github_repo, REPO);
    assert.equal(app.github_repo_id, REPO_ID);
    assert.equal(app.default_branch, "main");
    assert.equal(app.last_release, null);
    assert.equal(
      psql(`select l.details->'to'->>'repository_id' from audit_log l join apps a on a.id = l.app_id
        where a.slug = '${APP}' and l.action = 'link_repo'`),
      String(REPO_ID),
    );
  });

  test("2. invalid tokens are refused", async () => {
    await ciRefused("GET", "", null, 401, /missing GitHub OIDC token/);
    await ciRefused("GET", "", "not-a-jwt", 401, /rejected/);
    await ciRefused("GET", "", await oidcToken({}, { key: otherKeys.privateKey }), 401, /signature/i);
    await ciRefused("GET", "", await oidcToken({}, { aud: "https://elsewhere.example.com" }), 401, /aud/);
    await ciRefused("GET", "", await oidcToken({}, { iss: "https://token.actions.githubusercontent.com" }), 401, /iss/);
    const past = Math.floor(Date.now() / 1000) - 3600;
    await ciRefused("GET", "", await oidcToken({}, { iat: past - 300, exp: past }), 401, /expired/);
    await ciRefused("GET", "", await oidcToken({ run_id: undefined }), 401, /without run_id/);
    await ciRefused("GET", "", await oidcToken({ repository_id: String(REPO_ID + 1) }), 403, /not linked/);
    // allow-list: the first entry pins a ref (exact match), the second accepts any ref of its workflow file
    await ciRefused("GET", "", await oidcToken({ job_workflow_ref: `${REPO}/.github/workflows/platform.yml@refs/heads/main` }),
      403, /not allowed/);
    await ciRefused("GET", "", await oidcToken({ job_workflow_ref: `${WORKFLOW}@refs/heads/skip-checks` }), 403, /not allowed/);
    const other = await ci("GET", "", await oidcToken({ job_workflow_ref: `${OTHER_WORKFLOW}@refs/tags/v9` }));
    assert.equal(other.status, 200, JSON.stringify(other.body));
  });

  test("3. check mode (pull request, unprotected or non-default branch): get_app and dry_run only", async () => {
    const pr = await oidcToken({ ref: "refs/pull/7/merge", ref_protected: "false", event_name: "pull_request" });
    const info = await ci("GET", "", pr);
    assert.equal(info.status, 200, JSON.stringify(info.body));
    assert.equal(info.body.mode, "check");
    assert.equal(info.body.slug, APP);
    assert.match(info.body.anon_key, /^eyJ/);
    assert.ok(!JSON.stringify(info.body).includes("service_role"));

    const dry = await ci("POST", "/migrations", pr, { migrations: [todos], dry_run: true });
    assert.equal(dry.status, 200, JSON.stringify(dry.body));
    assert.equal(dry.body.status, "dry_run");
    assert.deepEqual(dry.body.would_apply, [todos.version]);
    const unsafe = { version: "20260101000002", sql: "create table public.ci_probe (id int primary key);" };
    const lints = await ci("POST", "/migrations", pr, { migrations: [unsafe], dry_run: true });
    assert.ok(lints.body.blocking_lints.some((l: { object: string }) => l.object === "public.ci_probe"));

    await ciRefused("POST", "/migrations", pr, 403, /check mode/, { migrations: [todos] });
    await ciRefused("POST", "/release", pr, 403, /check mode/);
    await ciRefused("POST", "/deployments", pr, 403, /check mode/, { kind: "frontend" });
    await ciRefused("POST", "/release", await oidcToken({ ref: "refs/heads/release", ref_protected: "true" }), 403,
      /not the default branch refs\/heads\/main/);
    await ciRefused("POST", "/release", await oidcToken({ ref_protected: "false" }), 403, /not a protected branch/);
    assert.equal(psql(`select count(*) from releases r join apps a on a.id = r.app_id where a.slug = '${APP}'`), "0");
  });

  test("4. a deploy token publishes a release: migrations and frontend", async () => {
    const token = await oidcToken();
    assert.equal((await ci("GET", "", token)).body.mode, "deploy");
    await ciRefused("POST", "/deployments", token, 409, /no release for run 1001\/1/, { kind: "frontend" });

    const begun = await ci("POST", "/release", token);
    assert.equal(begun.status, 200, JSON.stringify(begun.body));
    assert.equal(begun.body.status, "running");
    assert.equal(begun.body.source, "ci");
    const release = begun.body.id;
    assert.equal((await ci("POST", "/release", token)).body.id, release, "one release per run attempt");

    const applied = await ci("POST", "/migrations", token, { migrations: [todos] });
    assert.equal(applied.status, 200, JSON.stringify(applied.body));
    assert.deepEqual(applied.body.applied, [todos.version]);
    assert.equal(applied.body.release_id, release);
    const unsafe = { version: "20260101000002", sql: "create table public.ci_probe (id int primary key);" };
    const rejected = await ci("POST", "/migrations", token, { migrations: [todos, unsafe] });
    assert.equal(rejected.status, 422);
    assert.equal(rejected.body.status, "rejected");

    const created = await ci("POST", "/deployments", token, { kind: "frontend" });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    await upload(created.body.upload_url, await frontendArchive("v1"));
    // another run cannot publish this run's deployment
    await ciRefused("POST", `/deployments/${created.body.deployment_id}/finalize`, await oidcToken({ run_id: "1002" }),
      409, /no release for run 1002\/1/);
    const finalized = await ci("POST", `/deployments/${created.body.deployment_id}/finalize`, token);
    assert.equal(finalized.status, 200, JSON.stringify(finalized.body));
    assert.equal(finalized.body.status, "live");
    assert.equal(finalized.body.release_id, release);
    assert.match(await (await fetch(APP_URL)).text(), /CI v1/);

    const finished = await ci("POST", "/release/finish", token, { status: "succeeded" });
    assert.equal(finished.status, 200, JSON.stringify(finished.body));
    assert.equal(finished.body.status, "succeeded");
    await ciRefused("POST", "/deployments", token, 400, /already succeeded/, { kind: "frontend" });
    await ciRefused("POST", "/release", token, 400, /already succeeded/);

    const row = psql(`select concat_ws('|', source, status, commit_sha, github_actor, ci_run_url, created_by is null)
      from releases where id = '${release}'`);
    assert.equal(row, `ci|succeeded|${SHA}|octocat|https://oidc.e2e.invalid/${REPO}/actions/runs/1001/attempts/1|t`);
    assert.equal(psql(`select string_agg(kind, ',' order by kind) from deployments where release_id = '${release}'`),
      "frontend,migrations");
    const app = await call(owner, "get_app", { app: APP });
    assert.equal(app.last_release.id, release);
    assert.equal(app.last_release.source, "ci");
    assert.equal(app.last_release.commit_sha, SHA);
    assert.equal(app.frontend_version, finalized.body.version);
  });

  test("5. a stopped app refuses CI publishing, check operations stay available", async () => {
    await call(owner, "stop_app", { app: APP });
    try {
      const token = await oidcToken({ run_id: "1003" });
      await ciRefused("POST", "/release", token, 409, new RegExp(`APP_STOPPED: app "${APP}" is stopped and read-only`));
      await ciRefused("POST", "/deployments", token, 409, /APP_STOPPED/, { kind: "frontend" });
      await ciRefused("POST", "/migrations", token, 409, /APP_STOPPED/, { migrations: [todos] });
      assert.equal((await ci("GET", "", token)).body.status, "stopped");
      assert.equal((await ci("POST", "/migrations", token, { migrations: [todos], dry_run: true })).status, 200);
      // the same guard on the MCP side
      await refused(owner, "link_repo", { app: APP, repo: REPO, repository_id: REPO_ID, default_branch: "main" }, /APP_STOPPED/);
      await refused(owner, "begin_release", { app: APP }, /APP_STOPPED/);
    } finally {
      await call(owner, "start_app", { app: APP });
    }
  });

  test("6. DIRECT_DEPLOY=admins: builders lose the publishing tools, admins keep them as an audited exception", async () => {
    cli(["set-setting", "direct_deploy", "admins"]);
    try {
      const reserved = /reserved to admins/;
      const builder = await call(owner, "whoami");
      assert.deepEqual([builder.direct_deploy, builder.direct_deploy_setting], [false, "admins"]);
      // the deploy skill writes the app's caller workflow from the first allowed reusable workflow
      assert.deepEqual(builder.ci, { uses: `${WORKFLOW}@main`, github_org: "e2e-org" });
      assert.equal((await call(admin, "whoami")).direct_deploy, true);
      await refused(owner, "create_deployment", { app: APP, kind: "frontend" }, reserved);
      await refused(owner, "apply_migrations", { app: APP, migrations: [todos] }, reserved);
      await refused(owner, "begin_release", { app: APP }, reserved);
      const dry = await call(owner, "apply_migrations", { app: APP, migrations: [todos], dry_run: true });
      assert.equal(dry.status, "dry_run");
      assert.equal((await call(collab, "get_app", { app: APP })).slug, APP, "reading is unchanged");

      const begun = await call(admin, "begin_release", { app: APP, commit_sha: SHA, reason: "CI is down" });
      assert.equal(begun.admin_exception, true);
      const created = await call(admin, "create_deployment", { app: APP, kind: "frontend", release_id: begun.release_id });
      await upload(created.upload_url, await frontendArchive("admin"));
      // a deployment uploaded by the admin cannot be published by a builder
      await refused(owner, "finalize_deployment", { deployment_id: created.deployment_id }, reserved);
      const finalized = await call(admin, "finalize_deployment", { deployment_id: created.deployment_id });
      assert.equal(finalized.release_id, begun.release_id);
      assert.match(await (await fetch(APP_URL)).text(), /CI admin/);
      assert.equal((await call(admin, "finish_release", { release_id: begun.release_id, status: "succeeded" })).status,
        "succeeded");
      const row = psql(`select concat_ws('|', r.source, r.status, r.admin_exception, r.reason, u.email)
        from releases r join users u on u.id = r.created_by where r.id = '${begun.release_id}'`);
      assert.equal(row, `direct|succeeded|t|CI is down|${env.PLATFORM_ADMIN_EMAIL ?? "admin@example.com"}`);
      assert.equal((await call(owner, "get_app", { app: APP })).last_release.admin_exception, true);

      // without begin_release, an admin's publication is its own release
      const view = { version: "20260101000003", name: "todo_count", sql: "create table public.counters (n int);" +
        " alter table public.counters enable row level security;" };
      const applied = await call(admin, "apply_migrations", { app: APP, migrations: [todos, view] });
      assert.deepEqual(applied.applied, [view.version]);
      assert.equal(psql(`select concat_ws('|', source, status, admin_exception) from releases where id = '${applied.release_id}'`),
        "direct|succeeded|t");
    } finally {
      cli(["unset-setting", "direct_deploy"]);
    }
    // DIRECT_DEPLOY=everyone (the local default): builders publish again, without the exception flag
    assert.equal((await call(owner, "whoami")).direct_deploy, true);
    const created = await call(owner, "create_deployment", { app: APP, kind: "frontend" });
    await upload(created.upload_url, await frontendArchive("builder"));
    const finalized = await call(owner, "finalize_deployment", { deployment_id: created.deployment_id });
    assert.equal(psql(`select concat_ws('|', source, status, admin_exception) from releases where id = '${finalized.release_id}'`),
      "direct|succeeded|f");
    await refused(owner, "finish_release", { release_id: finalized.release_id, status: "failed" }, /already succeeded/);
  });
});
