// End-to-end test of platform-deploy (packages/deploy-cli) against the running "plat" stack: a copy of
// examples/todo-app (migrations, one function, Vite frontend) is checked and deployed
//   - in direct mode, with the admin's PAT on MCP (DIRECT_DEPLOY=admins: an audited admin exception);
//   - in CI mode, with GitHub OIDC tokens from a fake issuer: as in ci.e2e.test.ts, the test signs tokens with its own
//     RS256 key (trusted through the oidc_issuer and test-only oidc_jwks settings), and serves them on a local
//     ACTIONS_ID_TOKEN_REQUEST_URL like the GitHub Actions runner does.
// The CLI runs as a child process, exactly as the reusable workflow runs it.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes, randomInt } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { appRoles } from "@platform/sql";
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
const CLI = fileURLToPath(new URL("packages/deploy-cli/src/main.ts", ROOT));
const RUN_ID = runId();
const APP = `e2e-${RUN_ID}-cli`;
const APP_URL = `http://${APP}.localhost:8100`;
const APP_DB = appRoles(APP.replace(/-/g, "_")).database;

const ISSUER = `https://oidc.e2e.invalid/${RUN_ID}`;
const KID = `e2e-${RUN_ID}`;
const REPO = `e2e-org/${APP}`;
const REPO_ID = 900_000_000 + randomInt(90_000_000);
const WORKFLOW = "e2e-org/platform-ci/.github/workflows/deploy.yml";
const MANAGED_SETTINGS = ["oidc_issuer", "oidc_jwks", "oidc_audience", "oidc_jwks_url", "ci_allowed_workflows", "direct_deploy"];
const REQUEST_TOKEN = randomBytes(16).toString("hex");

const work = mkdtempSync(join(tmpdir(), "plat-e2e-cli-"));
const repo = join(work, "todo-app");
const keys = await generateKeyPair("RS256");

// ---------------------------------------------------------------------------------------------------------------
// Fake GitHub Actions OIDC token endpoint (ACTIONS_ID_TOKEN_REQUEST_URL)

/** Claims of the tokens served to the CLI: a push on the protected default branch unless overridden. */
let claims: Record<string, string> = {};
const audiences: string[] = [];

function oidcServer() {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.headers.authorization !== `Bearer ${REQUEST_TOKEN}` || url.searchParams.get("api-version") !== "2.0") {
      res.writeHead(401).end("bad request token");
      return;
    }
    const audience = url.searchParams.get("audience") ?? "";
    audiences.push(audience);
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      repository: REPO,
      repository_id: String(REPO_ID),
      ref: "refs/heads/main",
      ref_protected: "true",
      sha: "0123456789abcdef0123456789abcdef01234567",
      actor: "octocat",
      run_id: "2001",
      run_attempt: "1",
      event_name: "push",
      job_workflow_ref: `${WORKFLOW}@refs/heads/main`,
      ...claims,
    };
    const value = await new SignJWT(payload)
      .setProtectedHeader({ alg: "RS256", kid: KID })
      .setIssuer(ISSUER)
      .setAudience(audience)
      .setSubject(`repo:${REPO}:ref:${payload.ref}`)
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(keys.privateKey);
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ count: 1, value }));
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Helpers

let server: Server;
let oidcUrl: string;

/** Runs platform-deploy as a child process (async: the fake OIDC endpoint lives in this process). */
function platformDeploy(args: string[], extraEnv: Record<string, string>) {
  const summary = join(work, `summary-${randomBytes(4).toString("hex")}.md`);
  writeFileSync(summary, "");
  const childEnv: NodeJS.ProcessEnv = { ...process.env, GITHUB_STEP_SUMMARY: summary, ...extraEnv };
  for (const key of ["PLATFORM_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_URL", "ACTIONS_ID_TOKEN_REQUEST_TOKEN"]) {
    if (!(key in extraEnv)) delete childEnv[key];
  }
  return new Promise<{ code: number | null; output: string; summary: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args, "--dir", repo], { env: childEnv });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, output, summary: readFileSync(summary, "utf8") }));
  });
}

const direct = (args: string[]) => platformDeploy(args, { PLATFORM_URL: MCP_URL, PLATFORM_TOKEN: env.PLATFORM_TOKEN! });
const ci = (args: string[], tokenClaims: Record<string, string>) => {
  claims = tokenClaims;
  return platformDeploy(args, {
    PLATFORM_URL: API_URL,
    ACTIONS_ID_TOKEN_REQUEST_URL: `${oidcUrl}/token?api-version=2.0`,
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: REQUEST_TOKEN,
  });
};

function assertExit(result: { code: number | null; output: string }, code: number) {
  assert.equal(result.code, code, result.output);
}

const git = (...args: string[]) =>
  execFileSync("git", ["-c", "user.email=e2e@example.com", "-c", "user.name=e2e", ...args], { cwd: repo, encoding: "utf8" })
    .trim();

function commit(message: string, files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) writeFileSync(join(repo, path), content);
  git("add", "-A");
  git("commit", "-q", "-m", message);
  return git("rev-parse", "HEAD");
}

const releases = () =>
  psql(`select coalesce(string_agg(concat_ws('|', r.source, r.status, coalesce(r.ci_run_id, '-')), ',' order by r.started_at), '')
    from releases r join apps a on a.id = r.app_id where a.slug = '${APP}'`);
const releaseKinds = (where: string) =>
  psql(`select string_agg(d.kind, ',' order by d.kind) from deployments d join releases r on r.id = d.release_id
    join apps a on a.id = r.app_id where a.slug = '${APP}' and ${where}`);

const liveFrontend = () =>
  psql(`select d.version from deployments d join apps a on a.id = d.app_id
    where a.slug = '${APP}' and d.kind = 'frontend' and d.status = 'live'`);

async function connect(token: string) {
  const client = new Client({ name: "e2e-deploy-cli", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(MCP_URL), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }),
  );
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const result = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
  if (result.isError) throw new Error(`${name} failed: ${result.content[0]?.text}`);
  return JSON.parse(result.content[0]!.text);
}

/** An app user: signs up, then calls the app's REST API and functions with their JWT. */
async function appUser(anonKey: string) {
  const signup = await fetch(`${APP_URL}/auth/v1/signup`, {
    method: "POST",
    headers: { apikey: anonKey, "content-type": "application/json" },
    body: JSON.stringify({ email: `${APP}-user@example.com`, password: randomBytes(12).toString("hex") }),
  });
  assert.equal(signup.status, 200, await signup.clone().text());
  const { access_token } = await signup.json() as { access_token: string };
  return (path: string, init: RequestInit = {}) =>
    fetch(`${APP_URL}${path}`, {
      ...init,
      headers: {
        apikey: anonKey,
        authorization: `Bearer ${access_token}`,
        "content-type": "application/json",
        prefer: "return=representation",
      },
    });
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

// ---------------------------------------------------------------------------------------------------------------

describe("platform-deploy (packages/deploy-cli): direct and CI deployments of examples/todo-app", () => {
  let admin: Client;
  let saved: Record<string, string>;
  let anonKey: string;
  let user: Awaited<ReturnType<typeof appUser>>;

  before(async () => {
    saved = settingsSnapshot();
    const jwk = { ...(await exportJWK(keys.publicKey)), kid: KID, alg: "RS256", use: "sig" };
    cli(["set-setting", "oidc_issuer", ISSUER]);
    cli(["set-setting", "oidc_jwks", JSON.stringify({ keys: [jwk] })]);
    cli(["set-setting", "ci_allowed_workflows", `${WORKFLOW}@refs/heads/main`]);
    for (const key of ["oidc_audience", "oidc_jwks_url", "direct_deploy"]) cli(["unset-setting", key]);

    server = oidcServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    oidcUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    // the app repository: a copy of examples/todo-app with its .platform.json, one commit
    cpSync(fileURLToPath(new URL("examples/todo-app/", ROOT)), repo, {
      recursive: true,
      filter: (source) => !/[/\\](node_modules|dist)$/.test(source),
    });
    git("init", "-q", "-b", "main");
    commit("todo-app", { ".platform.json": JSON.stringify({ app: APP }, null, 2) });

    admin = await connect(env.PLATFORM_TOKEN!);
    // created by the admin: cleanup() deletes users before apps, and apps.owner_id keeps the creator (CP-12)
    anonKey = (await call(admin, "create_app", { name: "CLI demo", slug: APP })).anon_key;
    await call(admin, "link_repo", { app: APP, repo: REPO, repository_id: REPO_ID, default_branch: "main" });
  });

  after(async () => {
    if (saved) restoreSettings(saved);
    await admin?.close();
    server?.close();
    rmSync(work, { recursive: true, force: true });
    await cleanup([APP], []);
  });

  test("1. direct mode with an admin PAT and DIRECT_DEPLOY=admins: migrations, function, build, frontend", async () => {
    cli(["set-setting", "direct_deploy", "admins"]);
    let result;
    try {
      result = await direct(["deploy", "--reason", "e2e direct deployment"]);
    } finally {
      cli(["unset-setting", "direct_deploy"]);
    }
    assertExit(result, 0);
    const sha = git("rev-parse", "HEAD");

    // the app serves the new build, built with the app's variables
    const page = await fetch(APP_URL);
    assert.equal(page.status, 200);
    assert.equal(await page.text(), readFileSync(join(repo, "dist", "index.html"), "utf8"));
    const assets = readFileSync(join(repo, "dist", "index.html"), "utf8").match(/\/assets\/index-[\w-]+\.js/)![0];
    assert.ok((await (await fetch(`${APP_URL}${assets}`)).text()).includes(anonKey), "the bundle embeds the anon key");

    // REST under RLS and the function, as an app user
    user = await appUser(anonKey);
    const inserted = await user("/rest/v1/todos", { method: "POST", body: JSON.stringify({ title: "ship it" }) });
    assert.equal(inserted.status, 201, await inserted.clone().text());
    assert.deepEqual((await (await user("/rest/v1/todos?select=title,done")).json()), [{ title: "ship it", done: false }]);
    const summary = await user("/functions/v1/summary", { method: "POST", body: "{}" });
    assert.deepEqual(await summary.json(), { total: 1, done: 0 });

    // one direct release, flagged as an admin exception, with the reason and the commit
    assert.equal(releases(), "direct|succeeded|-");
    assert.equal(
      psql(`select concat_ws('|', r.admin_exception, r.reason, r.commit_sha, u.email) from releases r
        join apps a on a.id = r.app_id join users u on u.id = r.created_by where a.slug = '${APP}'`),
      `t|e2e direct deployment|${sha}|${env.PLATFORM_ADMIN_EMAIL ?? "admin@example.com"}`,
    );
    assert.equal(releaseKinds("r.source = 'direct'"), "frontend,functions,migrations");
    assert.match(result.summary, new RegExp(`Platform deployment of \`${APP}\`: deployed`));
    assert.match(result.summary, /admin exception/);
    assert.match(result.summary, new RegExp(sha));
  });

  test("2. CI mode (GitHub OIDC, push on the protected default branch): only the new migration is applied", async () => {
    commit("priority", {
      "supabase/migrations/20261001110000_add_priority.sql":
        "alter table public.todos add column priority int not null default 0;\n",
    });
    const result = await ci(["deploy"], { run_id: "2001" });
    assertExit(result, 0);
    assert.ok(audiences.length > 0 && audiences.every((a) => a === API_URL), `audiences: ${audiences.join(", ")}`);
    assert.match(result.output, /applied 1 \(20261001110000\), 1 already applied/);

    assert.equal(releases(), "direct|succeeded|-,ci|succeeded|2001/1");
    assert.equal(
      psql(`select concat_ws('|', r.commit_sha, r.github_actor, r.created_by is null) from releases r
        join apps a on a.id = r.app_id where a.slug = '${APP}' and r.source = 'ci'`),
      "0123456789abcdef0123456789abcdef01234567|octocat|t",
    );
    assert.equal(releaseKinds("r.source = 'ci'"), "frontend,functions,migrations");
    const rows = await user("/rest/v1/todos?select=title,priority");
    assert.deepEqual(await rows.json(), [{ title: "ship it", priority: 0 }]);
    assert.equal((await fetch(APP_URL)).status, 200);
    assert.match(result.summary, /GitHub OIDC \(CI\)/);
    assert.match(result.summary, /deployed/);
  });

  test("3. lints: check reports them, deploy rejects them, acceptedLints lets them through", async () => {
    commit("probe without RLS", {
      "supabase/migrations/20261001120000_probe.sql": "create table public.cli_probe (id int primary key);\n",
    });
    const pr = { ref: "refs/pull/7/merge", ref_protected: "false", event_name: "pull_request", run_id: "2002" };
    const frontendBefore = liveFrontend();

    // check mode (pull request): the blocking lint fails the check; nothing is published
    const check = await ci(["check"], pr);
    assertExit(check, 1);
    assert.match(check.summary, /check of `.*`: failed/);
    assert.match(check.summary, /rls_disabled_in_public.*public\.cli_probe/);
    assert.match(check.output, /1 to apply \(20261001120000\), 2 already applied/);
    // a PR token cannot deploy
    const prDeploy = await ci(["deploy"], pr);
    assertExit(prDeploy, 1);
    assert.match(prDeploy.output, /can only check, not deploy \(ref refs\/pull\/7\/merge is not the default branch/);
    assert.equal(releases(), "direct|succeeded|-,ci|succeeded|2001/1");

    // deploy: the platform rejects the batch, the release fails, nothing else is published
    const rejected = await ci(["deploy"], { run_id: "2003" });
    assertExit(rejected, 1);
    assert.match(rejected.output, /rejected, nothing applied: 1 new ERROR lint/);
    assert.match(rejected.summary, /Blocking lints/);
    assert.equal(releases(), "direct|succeeded|-,ci|succeeded|2001/1,ci|failed|2003/1");
    assert.equal(psql("select to_regclass('public.cli_probe') is null", APP_DB), "t");
    assert.equal(liveFrontend(), frontendBefore);

    // accepted in .platform.json (reviewed with the change): check passes, deploy applies it
    commit("accept the probe lint", {
      ".platform.json": JSON.stringify({
        app: APP,
        acceptedLints: [{ name: "rls_disabled_in_public", object: "public.cli_probe" }],
      }, null, 2),
    });
    assertExit(await ci(["check"], { ...pr, run_id: "2004" }), 0);
    const accepted = await ci(["deploy"], { run_id: "2005" });
    assertExit(accepted, 0);
    assert.match(accepted.summary, /Accepted lints/);
    assert.equal(psql("select to_regclass('public.cli_probe') is not null", APP_DB), "t");
    assert.equal(releases(), "direct|succeeded|-,ci|succeeded|2001/1,ci|failed|2003/1,ci|succeeded|2005/1");
  });
});
