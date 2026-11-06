// Claude Code on the web (docs/ARCHITECTURE.md §6): a session has no GitHub access, so it pushes and pulls its app's
// code through these routes, which call GitHub with the platform bot's token (setting github_token). The caller names
// the app only (its slug, which a deploy token is bound to): the repository and the branch come from the app.
//   - push: one GraphQL createCommitOnBranch per commit. GitHub signs it as the bot; the member is in a Co-authored-by
//     trailer. The body is a line-framed stream turned into the GraphQL request as it flows (commitRequestBody).
//   - pull: read-only Git Data REST calls, relayed as GitHub answers them.
// The MCP tool get_ci_run reads the app's CI runs the same way (ciRun).
// Owners only, on the repository the platform created for the app. Nothing is written to disk, no file is held in
// memory, the platform runs no git.
import { type Context, Hono } from "hono";
import { pipeline, Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { type AppRow, AppStoppedError, appForUser, linkRepo, requireWritable, UserError } from "./apps.ts";
import { audit } from "./audit.ts";
import { authenticate, type User } from "./auth.ts";
import { isBehind, commitRequestBody, githubError, logTail, pullAnswer, pullPathAllowed } from "./github-policy.ts";
import { requireOwner } from "./members.ts";
import { githubServerUrl } from "./oidc.ts";
import { callerWorkflow, getSettings, type Settings } from "./settings.ts";
import { toolAllowed } from "./token-scopes.ts";

class HttpError extends Error {
  readonly status: 400 | 401 | 403 | 404 | 409 | 502;
  constructor(status: 400 | 401 | 403 | 404 | 409 | 502, message: string) {
    super(message);
    this.status = status;
  }
}

function githubApiUrls(settings: Settings) {
  const server = githubServerUrl(settings.oidcIssuer);
  return server === "https://github.com"
    ? { rest: "https://api.github.com", graphql: "https://api.github.com/graphql" }
    : { rest: `${server}/api/v3`, graphql: `${server}/api/graphql` };
}

const githubFetch = (settings: Settings, url: string, init: RequestInit = {}) =>
  fetch(url, {
    ...init,
    headers: {
      authorization: `Bearer ${settings.githubToken}`,
      accept: "application/vnd.github+json",
      "user-agent": "platform",
      "x-github-api-version": "2022-11-28",
      ...init.headers,
    },
  });

const githubResponseError = async (response: Response) => new HttpError(502, await githubError(response));

async function ownedApp(user: User, slug: string, action: string) {
  const app = await appForUser(user, slug);
  requireOwner(user, app, action);
  const settings = await getSettings();
  if (!settings.githubToken) {
    throw new UserError("the platform has no GitHub token: an admin sets github_token (docs/INSTALL.md §7)");
  }
  return { app, settings };
}

async function authorizeOwner(c: Context, scope: "push_code" | "pull_code") {
  const user = await authenticate(c.req.header("authorization"));
  if (!user) throw new HttpError(401, "invalid or missing token");
  if (!toolAllowed(user, scope)) throw new HttpError(403, `this token cannot ${scope === "push_code" ? "push" : "pull"} code`);
  return { user, ...(await ownedApp(user, c.req.param("app")!, scope === "push_code" ? "push its code" : "read its code")) };
}

function linkedRepo(app: AppRow) {
  if (!app.github_repo || !app.default_branch) {
    throw new HttpError(404, `app "${app.slug}" has no repository yet: it was never deployed`);
  }
  if (!app.github_repo_created) {
    throw new HttpError(403, `${app.github_repo} was linked to "${app.slug}" by hand (link_repo): the platform only ` +
      "reaches the repository it created for the app");
  }
  return { repo: app.github_repo, branch: app.default_branch };
}

async function githubJson<T>(settings: Settings, url: string): Promise<T> {
  const response = await githubFetch(settings, url);
  if (!response.ok) throw await githubResponseError(response);
  return (await response.json()) as T;
}

const FAILED = ["failure", "timed_out"];

/**
 * get_ci_run (mcp.ts): the run of the app's workflow (platform.yml) on its branch for `commit`, or the latest one, with
 * its failed jobs and the end of their log. `run` null: none yet.
 */
export async function ciRun(user: User, slug: string, commit?: string) {
  const { app, settings } = await ownedApp(user, slug, "read its CI runs");
  const { repo, branch } = linkedRepo(app);
  const actions = `${githubApiUrls(settings).rest}/repos/${repo}/actions`;
  const query = new URLSearchParams({ branch, event: "push", per_page: "1", ...(commit ? { head_sha: commit } : {}) });
  const runs = await githubFetch(settings, `${actions}/workflows/platform.yml/runs?${query}`);
  if (runs.status === 404) return { run: null, failed_jobs: [] }; // no platform.yml pushed yet
  if (!runs.ok) throw await githubResponseError(runs);
  const [run] = ((await runs.json()) as {
    workflow_runs: { id: number; status: string; conclusion: string | null; head_sha: string; html_url: string; created_at: string }[];
  }).workflow_runs;
  if (!run) return { run: null, failed_jobs: [] };
  const summary = {
    status: run.status, conclusion: run.conclusion, head_sha: run.head_sha, url: run.html_url, created_at: run.created_at,
  };
  if (run.status !== "completed" || run.conclusion === "success") return { run: summary, failed_jobs: [] };
  const { jobs } = await githubJson<{
    jobs: { id: number; name: string; conclusion: string | null; steps?: { name: string; conclusion: string | null }[] }[];
  }>(settings, `${actions}/runs/${run.id}/jobs?per_page=100`);
  const failed_jobs = [];
  for (const job of jobs.filter((j) => FAILED.includes(j.conclusion ?? ""))) {
    // ponytail: the whole log is read, then cut; stream it if CI logs grow to many MB
    const log = await githubFetch(settings, `${actions}/jobs/${job.id}/logs`);
    failed_jobs.push({
      name: job.name,
      failed_steps: (job.steps ?? []).filter((s) => FAILED.includes(s.conclusion ?? "")).map((s) => s.name),
      log_tail: log.ok ? logTail(await log.text()) : await githubError(log),
    });
  }
  return { run: summary, failed_jobs };
}

async function branchHead(settings: Settings, repo: string, branch: string) {
  // ponytail: a repository just created with auto_init may answer 404/409 for a moment; retried a few times
  for (let attempt = 1; ; attempt++) {
    const response = await githubFetch(settings, `${githubApiUrls(settings).rest}/repos/${repo}/git/ref/heads/${branch}`);
    if (response.ok) return ((await response.json()) as { object: { sha: string } }).object.sha;
    if (attempt >= 5 || (response.status !== 404 && response.status !== 409)) throw await githubResponseError(response);
    await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
  }
}

const handle = (fn: (c: Context) => Promise<unknown>) => async (c: Context) => {
  try {
    const result = await fn(c);
    return result instanceof Response ? result : c.json(result);
  } catch (error) {
    if (error instanceof HttpError) return c.json({ error: error.message }, error.status);
    if (error instanceof AppStoppedError) return c.json({ error: error.message, code: error.code }, 409);
    if (error instanceof UserError) return c.json({ error: error.message }, 400);
    console.error(error);
    return c.json({ error: "internal error" }, 500);
  }
};

export const githubRoutes = new Hono();

// Creates the app's repository in the CI organization (auto_init: createCommitOnBranch needs a branch) and links it.
async function createRepository(user: User, app: AppRow, settings: Settings) {
  const ci = callerWorkflow(settings);
  if (!ci) throw new UserError("CI deployment is not set up on this platform (ci_allowed_workflows): ask an admin");
  const created = await githubFetch(settings, `${githubApiUrls(settings).rest}/orgs/${ci.github_org}/repos`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: app.slug, private: true, auto_init: true }),
  });
  if (created.status === 422) {
    throw new HttpError(409, `GitHub refused to create ${ci.github_org}/${app.slug} (${await githubError(created)}): if it ` +
      "already exists, it is not this app's repository; ask an admin");
  }
  if (!created.ok) throw await githubResponseError(created);
  const repository = (await created.json()) as { id: number; full_name: string; default_branch: string };
  await linkRepo(user, app, repository.full_name, repository.id, repository.default_branch, true);
  return { repo: repository.full_name, branch: repository.default_branch };
}

githubRoutes.post("/apps/:app/github", handle(async (c) => {
  const { user, app, settings } = await authorizeOwner(c, "push_code");
  requireWritable(app, "creating the repository");
  const { repo, branch } = app.github_repo ? linkedRepo(app) : await createRepository(user, app, settings);
  return { github_repo: repo, default_branch: branch, head: await branchHead(settings, repo, branch) };
}));

githubRoutes.post("/apps/:app/github/commit", handle(async (c) => {
  const { user, app, settings } = await authorizeOwner(c, "push_code");
  requireWritable(app, "pushing code");
  const { repo, branch } = linkedRepo(app);
  const frames = c.req.raw.body as WebReadableStream<Uint8Array> | null;
  if (!frames) throw new HttpError(400, "empty body");
  const graphqlBody = commitRequestBody({ repo, branch, coAuthor: user });
  let framesError: Error | undefined;
  pipeline(Readable.fromWeb(frames), graphqlBody, (error) => {
    framesError ??= error ?? undefined;
  });
  let response: Response;
  try {
    response = await githubFetch(settings, githubApiUrls(settings).graphql, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: Readable.toWeb(graphqlBody) as ReadableStream,
      duplex: "half",
    } as RequestInit);
  } catch (error) {
    if (framesError) throw new HttpError(400, framesError.message);
    throw error;
  }
  if (framesError) throw new HttpError(400, framesError.message);
  const result = (await response.json().catch(() => ({}))) as {
    data?: { createCommitOnBranch?: { commit: { oid: string; tree: { oid: string } } } };
    errors?: { type?: string; message?: string }[];
    message?: string;
  };
  const commit = result.data?.createCommitOnBranch?.commit;
  if (!commit) {
    if (isBehind(result.errors)) throw new HttpError(409, "behind");
    const reason = result.errors?.map((e) => e.message).join("; ") || result.message || `HTTP ${response.status}`;
    throw new HttpError(502, `GitHub refused the commit: ${reason}`);
  }
  await audit(user.id, app.id, "push_code", { commit: commit.oid, ...graphqlBody.counts });
  return { commit_sha: commit.oid, tree_sha: commit.tree.oid };
}));

githubRoutes.get("/apps/:app/github/*", handle(async (c) => {
  const { app, settings } = await authorizeOwner(c, "pull_code");
  const { repo, branch } = linkedRepo(app);
  const url = new URL(c.req.url);
  const path = url.pathname.slice(`/apps/${app.slug}/github/`.length);
  if (!pullPathAllowed(path, url.search, branch)) throw new HttpError(404, "not a path a pull reads");
  return pullAnswer(await githubFetch(settings, `${githubApiUrls(settings).rest}/repos/${repo}/${path}${url.search}`));
}));
