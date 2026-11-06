#!/usr/bin/env node
// platform-deploy: checks or deploys an app repository (migrations, functions, frontend) to the platform.
// See ../README.md.
import "./localhost-dns.ts";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { codeRelay, pull, push } from "./code.ts";
import { apiBase, ciPlatform, githubOidc, mcpPlatform, type Platform } from "./platform.ts";
import { readConfig } from "./project.ts";
import { type Mode, run } from "./run.ts";
import { markdown } from "./summary.ts";

const USAGE = `Usage: platform-deploy <check|deploy|push|pull> [options]

  check    get_app, migrations dry run with the security linter, build. Publishes nothing.
  deploy   release, migrations, functions, build, frontend, smoke test.
  push     Claude Code on the web: commit HEAD to the app's repository through the platform (CI then deploys).
           Prints PUSHED <commit>, UNCHANGED, BEHIND (exit 3: pull first) or EXISTING_CODE (exit 4: the app
           already has code this folder never synced).
  pull     Claude Code on the web: bring the app's code from its repository: restores an empty folder, rebases
           the folder's commits otherwise. Prints PULLED <commit> or CONFLICT (exit 5: resolve, git rebase --continue).

Options:
  --dir <path>       app repository (default: current directory)
  --app <slug>       app slug, instead of the "app" of .platform.json (which may then be absent)
  --url <url>        platform API URL (default: $PLATFORM_URL; a trailing /mcp is ignored)
  --auth <oidc|token>
                     oidc: GitHub Actions OIDC token on the CI API (ACTIONS_ID_TOKEN_REQUEST_URL/_TOKEN)
                     token: personal access token on MCP ($PLATFORM_TOKEN), for direct deployments
                     default: token when PLATFORM_TOKEN is set, else oidc
  --reason <text>    direct deployments: why it is deployed outside CI (expected from admins)
  --audience <aud>   OIDC audience (default: $PLATFORM_AUDIENCE, else the API URL)

Writes a markdown summary to $GITHUB_STEP_SUMMARY when set. Exit code 1 when the check or deployment fails.`;

function usage(message?: string): never {
  if (message) console.error(`platform-deploy: ${message}\n`);
  console.error(USAGE);
  process.exit(2);
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        dir: { type: "string" },
        app: { type: "string" },
        url: { type: "string" },
        auth: { type: "string" },
        reason: { type: "string" },
        audience: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (error) {
    usage((error as Error).message);
  }
  const { values, positionals } = parsed;
  if (values.help) usage();
  const mode = positionals[0];
  if (positionals.length !== 1 || !["check", "deploy", "push", "pull"].includes(mode!)) {
    usage("expected one command: check, deploy, push or pull");
  }

  const url = values.url ?? process.env.PLATFORM_URL;
  if (!url) usage("missing platform URL: --url or PLATFORM_URL");
  const api = apiBase(url);
  const auth = values.auth ?? (process.env.PLATFORM_TOKEN ? "token" : "oidc");
  if (auth !== "oidc" && auth !== "token") usage(`--auth must be oidc or token, not ${auth}`);

  const dir = resolve(values.dir ?? ".");
  const config = readConfig(dir, values.app);
  if (mode === "push" || mode === "pull") {
    const pat = process.env.PLATFORM_TOKEN;
    if (auth !== "token" || !pat) usage(`${mode} needs PLATFORM_TOKEN`);
    const mcp = mcpPlatform(api, config.app, pat);
    const relay = codeRelay(api, config.app, pat, async () => (await mcp.getApp()).default_branch ?? null);
    const result = mode === "push" ? await push(dir, config.app, relay) : await pull(dir, config.app, relay);
    console.log("commit_sha" in result ? `${result.status} ${result.commit_sha}` : result.status);
    process.exitCode = { PUSHED: 0, PULLED: 0, UNCHANGED: 0, BEHIND: 3, EXISTING_CODE: 4, CONFLICT: 5 }[result.status];
    return;
  }
  let platform: Platform;
  if (auth === "token") {
    const pat = process.env.PLATFORM_TOKEN;
    if (!pat) usage("--auth token needs PLATFORM_TOKEN");
    platform = mcpPlatform(api, config.app, pat);
  } else {
    if (values.reason) console.error("platform-deploy: --reason is ignored in CI (the release records the run)");
    platform = ciPlatform(api, config.app, githubOidc(values.audience ?? process.env.PLATFORM_AUDIENCE ?? api));
  }

  console.log(`platform-deploy ${mode} ${config.app} on ${api} (${auth === "oidc" ? "GitHub OIDC" : "personal access token"})`);
  const report = await run({ mode: mode as Mode, dir, config, platform, reason: values.reason });
  const summary = markdown(report);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  console.log(`\n${summary}`);
  process.exitCode = report.ok ? 0 : 1;
}

main().catch((error) => {
  console.error(`platform-deploy: ${(error as Error).message}`);
  process.exitCode = 1;
});
