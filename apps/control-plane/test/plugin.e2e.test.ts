// End-to-end test of the plugin's skills against the running "plat" stack, without GitHub and without Claude: the
// commands the `deploy` skill runs on its direct path, and those of `admin-deploy`, run in order on a copy of
// examples/todo-app, from a copy of the plugin with its symlinks resolved (what an installed plugin sees).
// The CI path of the `deploy` skill needs GitHub (gh repo create, a real Actions run): not covered here.
// Requires DIRECT_DEPLOY=everyone (local install); skipped otherwise.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { cleanup, cli, psql, runId } from "./disposable.ts";

const ROOT = new URL("../../../", import.meta.url);
const env = Object.fromEntries(
  readFileSync(new URL("deploy/.env.local", ROOT), "utf8")
    .split("\n")
    .filter((line) => line.includes("="))
    .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
);
const MCP_URL = env.PLATFORM_URL ?? "http://api.localhost:8100/mcp";
const APP = `e2e-${runId()}-plg`;
const APP_URL = `http://${APP}.localhost:8100`;
const BUILDER = `${APP}-builder@example.com`;

const work = mkdtempSync(join(tmpdir(), "plat-e2e-plugin-"));
const plugin = join(work, "plugin");
const repo = join(work, "todo-app");
const remote = join(work, "acme", "todo-app.git");
const deployScripts = join(plugin, "skills", "deploy", "scripts");
const preflight = join(plugin, "skills", "admin-deploy", "scripts", "preflight.sh");

async function connect(token: string) {
  const client = new Client({ name: "e2e-plugin", version: "0.0.0" });
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

const git = (...args: string[]) =>
  execFileSync("git", ["-c", "user.email=e2e@example.com", "-c", "user.name=e2e", ...args], { cwd: repo, encoding: "utf8" })
    .trim();

/** A skill command, run like Claude runs it: from the project root, the token in the environment. */
function script(path: string, args: string[], token: string) {
  const result = spawnSync(path, args, {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, PLATFORM_TOKEN: token, PLATFORM_URL: MCP_URL },
    timeout: 300_000,
  });
  return { code: result.status, stdout: result.stdout, output: `${result.stdout}\n${result.stderr}` };
}

describe("plugin skills: direct path of deploy, and admin-deploy, on examples/todo-app", () => {
  let admin: Client;
  let builder: Client;
  let builderToken = "";
  let directDeploy = false;

  before(async () => {
    admin = await connect(env.PLATFORM_TOKEN!);
    directDeploy = (await call(admin, "whoami")).direct_deploy_setting === "everyone";
    if (!directDeploy) return;
    // the installed plugin: a copy with the symlinks (deploy-cli, workflow template) resolved
    cpSync(fileURLToPath(new URL("plugin/", ROOT)), plugin, { recursive: true, dereference: true });
    cpSync(fileURLToPath(new URL("examples/todo-app/", ROOT)), repo, {
      recursive: true,
      filter: (source) => !/[/\\](node_modules|dist)$/.test(source),
    });
    git("init", "-q", "-b", "main");
    git("add", ".");
    git("commit", "-qm", "todo-app");
    builderToken = cli(["create-user", BUILDER, "developer", "plugin-e2e"]).trim();
    builder = await connect(builderToken);
    // created by the admin, owned by the builder: cleanup() deletes users before apps (CP-12)
    await call(admin, "create_app", { name: "Plugin demo", slug: APP });
    cli(["add-member", APP, BUILDER, "owner"]);
  });

  after(async () => {
    await builder?.close();
    await admin?.close();
    rmSync(work, { recursive: true, force: true });
    if (directDeploy) await cleanup([APP], [BUILDER]);
  });

  test("1. deploy skill, direct path: whoami, .platform.json, secrets, check, deploy", async (t) => {
    if (!directDeploy) return t.skip("DIRECT_DEPLOY is not everyone on this stack");
    const me = await call(builder, "whoami");
    assert.equal(me.direct_deploy, true);
    assert.ok(me.apps.some((a: { slug: string }) => a.slug === APP));

    // step 1: .platform.json, committed (the release records the commit)
    writeFileSync(join(repo, ".platform.json"), `${JSON.stringify({ app: APP }, null, 2)}\n`);
    git("add", ".platform.json");
    git("commit", "-qm", "Add platform app config");

    // step 3: no secret to set for todo-app (its function only reads platform-provided variables)
    const secrets = script(join(deployScripts, "function-secrets.sh"), [], builderToken);
    assert.equal(secrets.code, 0, secrets.output);
    assert.equal(secrets.stdout.trim(), "");

    // step 4: check publishes nothing
    const check = script(join(deployScripts, "platform-deploy"), ["check"], builderToken);
    assert.equal(check.code, 0, check.output);
    assert.match(check.output, /migrations: 1 to apply \(20261001100000\), 0 already applied \(dry run\)/);
    assert.equal((await call(builder, "get_app", { app: APP })).last_release, null);

    // step 5b: deploy
    const deploy = script(join(deployScripts, "platform-deploy"), ["deploy"], builderToken);
    assert.equal(deploy.code, 0, deploy.output);
    const page = await fetch(APP_URL);
    assert.equal(page.status, 200);
    assert.equal(await page.text(), readFileSync(join(repo, "dist", "index.html"), "utf8"));
    const app = await call(builder, "get_app", { app: APP });
    assert.equal(app.last_release.source, "direct");
    assert.equal(app.last_release.status, "succeeded");
    assert.equal(app.last_release.commit_sha, git("rev-parse", "HEAD"));
    assert.equal(app.last_release.created_by, BUILDER);
    assert.equal(app.last_release.admin_exception, false);
    assert.equal(app.schema_drift.count, 0, "migrations of a release are not drift");
    const ping = await fetch(`${APP_URL}/functions/v1/summary`, { method: "OPTIONS" });
    assert.ok(ping.status < 500, `function preflight: ${ping.status}`);
  });

  test("2. admin-deploy: preflight refuses a dirty tree or an unpushed commit, then deploys with a reason", async (t) => {
    if (!directDeploy) return t.skip("DIRECT_DEPLOY is not everyone on this stack");
    const repoName = "acme/todo-app";
    const refused = (args: string[], pattern: RegExp) => {
      const result = script(preflight, args, env.PLATFORM_TOKEN!);
      assert.notEqual(result.code, 0, result.output);
      assert.match(result.output, pattern);
    };
    refused([repoName], /REFUSED: no git remote/);
    execFileSync("git", ["init", "-q", "--bare", remote]);
    git("remote", "add", "origin", remote);
    refused([repoName], /REFUSED: commit [0-9a-f]{40} is not on the remote/);
    git("push", "-q", "origin", "main");
    refused(["acme/other"], /REFUSED: no remote points to the linked repository acme\/other/);
    writeFileSync(join(repo, "index.html"), `${readFileSync(join(repo, "index.html"), "utf8")}<!-- hotfix -->\n`);
    refused([repoName], /REFUSED: the working tree has uncommitted changes/);
    git("checkout", "-q", "index.html");
    const ok = script(preflight, [repoName], env.PLATFORM_TOKEN!);
    assert.equal(ok.code, 0, ok.output);
    assert.equal(ok.stdout.trim(), git("rev-parse", "HEAD"));

    const deploy = script(join(deployScripts, "platform-deploy"), ["deploy", "--reason", "plugin e2e: CI is down"],
      env.PLATFORM_TOKEN!);
    assert.equal(deploy.code, 0, deploy.output);
    const release = (await call(admin, "get_app", { app: APP })).last_release;
    assert.equal(release.source, "direct");
    assert.equal(release.reason, "plugin e2e: CI is down");
    assert.equal(release.commit_sha, git("rev-parse", "HEAD"));
    assert.equal(psql(`select count(*) from releases r join apps a on a.id = r.app_id
      where a.slug = '${APP}' and r.status = 'succeeded'`), "2");
  });
});
