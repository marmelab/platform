// Claude Code on the web (docs/ARCHITECTURE.md §6): a session has no GitHub access, so it pushes and pulls its app's
// code through these routes, which call GitHub with the platform bot's token (setting github_token). The caller names
// the app only (its slug, which a deploy token is bound to): the repository and the branch come from the app.
//   - push: one GraphQL createCommitOnBranch per commit. GitHub signs it as the bot; the member is in a Co-authored-by
//     trailer. The body is a line-framed stream turned into the GraphQL request as it flows (pushRequest).
//   - pull: read-only Git Data REST calls, relayed as GitHub answers them.
// Owners only. Nothing is written to disk, no file is held in memory, the platform runs no git.
import { type Context, Hono } from "hono";
import { pipeline, Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { type AppRow, AppStoppedError, appForUser, linkRepo, requireWritable, UserError } from "./apps.ts";
import { audit } from "./audit.ts";
import { authenticate } from "./auth.ts";
import { isBehind, pushRequest, readAllowed } from "./github-policy.ts";
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

function endpoints(settings: Settings) {
  const server = githubServerUrl(settings.oidcIssuer);
  return server === "https://github.com"
    ? { rest: "https://api.github.com", graphql: "https://api.github.com/graphql" }
    : { rest: `${server}/api/v3`, graphql: `${server}/api/graphql` };
}

const github = (settings: Settings, url: string, init: RequestInit = {}) =>
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

const githubError = async (response: Response) =>
  new HttpError(502, `GitHub answered ${response.status}: ${(await response.text()).slice(0, 500)}`);

async function context(c: Context, scope: "push_code" | "pull_code") {
  const user = await authenticate(c.req.header("authorization"));
  if (!user) throw new HttpError(401, "invalid or missing token");
  if (!toolAllowed(user, scope)) throw new HttpError(403, `this token cannot ${scope === "push_code" ? "push" : "pull"} code`);
  const app = await appForUser(user, c.req.param("app")!);
  requireOwner(user, app, scope === "push_code" ? "push its code" : "read its code");
  const settings = await getSettings();
  if (!settings.githubToken) {
    throw new UserError("the platform has no GitHub token: an admin sets github_token (docs/INSTALL.md §7)");
  }
  return { user, app, settings };
}

function linked(app: AppRow) {
  if (!app.github_repo || !app.default_branch) {
    throw new HttpError(404, `app "${app.slug}" has no repository yet: it was never deployed`);
  }
  return { repo: app.github_repo, branch: app.default_branch };
}

async function head(settings: Settings, repo: string, branch: string) {
  // ponytail: a repository just created with auto_init may answer 404/409 for a moment; retried a few times
  for (let attempt = 1; ; attempt++) {
    const response = await github(settings, `${endpoints(settings).rest}/repos/${repo}/git/ref/heads/${branch}`);
    if (response.ok) return ((await response.json()) as { object: { sha: string } }).object.sha;
    if (attempt >= 5 || (response.status !== 404 && response.status !== 409)) throw await githubError(response);
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
githubRoutes.post("/apps/:app/github", handle(async (c) => {
  const { user, app, settings } = await context(c, "push_code");
  requireWritable(app, "creating the repository");
  let { github_repo: repo, default_branch: branch } = app;
  if (!repo || !branch) {
    const ci = callerWorkflow(settings);
    if (!ci) throw new UserError("CI deployment is not set up on this platform (ci_allowed_workflows): ask an admin");
    const created = await github(settings, `${endpoints(settings).rest}/orgs/${ci.github_org}/repos`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: app.slug, private: true, auto_init: true }),
    });
    if (created.status === 422) {
      throw new HttpError(409, `GitHub refused to create ${ci.github_org}/${app.slug} (${await created.text()}): if it ` +
        "already exists, it is not this app's repository; ask an admin");
    }
    if (!created.ok) throw await githubError(created);
    const info = (await created.json()) as { id: number; full_name: string; default_branch: string };
    ({ github_repo: repo, default_branch: branch } = await linkRepo(user, app, info.full_name, info.id, info.default_branch));
  }
  return { github_repo: repo, default_branch: branch, head: await head(settings, repo!, branch!) };
}));

githubRoutes.post("/apps/:app/github/commit", handle(async (c) => {
  const { user, app, settings } = await context(c, "push_code");
  requireWritable(app, "pushing code");
  const { repo, branch } = linked(app);
  const body = c.req.raw.body as WebReadableStream<Uint8Array> | null;
  if (!body) throw new HttpError(400, "empty body");
  const frames = pushRequest({ repo, branch, coAuthor: user });
  let invalid: Error | undefined;
  pipeline(Readable.fromWeb(body), frames, (error) => {
    invalid ??= error ?? undefined;
  });
  let response: Response;
  try {
    response = await github(settings, endpoints(settings).graphql, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: Readable.toWeb(frames) as ReadableStream,
      duplex: "half",
    } as RequestInit);
  } catch (error) {
    if (invalid) throw new HttpError(400, invalid.message);
    throw error;
  }
  if (invalid) throw new HttpError(400, invalid.message);
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
  await audit(user.id, app.id, "push_code", { commit: commit.oid, ...frames.counts });
  return { commit_sha: commit.oid, tree_sha: commit.tree.oid };
}));

githubRoutes.get("/apps/:app/github/*", handle(async (c) => {
  const { app, settings } = await context(c, "pull_code");
  const { repo, branch } = linked(app);
  const url = new URL(c.req.url);
  const path = url.pathname.slice(`/apps/${app.slug}/github/`.length);
  if (!readAllowed(path, url.search, branch)) throw new HttpError(404, "not a path a pull reads");
  const response = await github(settings, `${endpoints(settings).rest}/repos/${repo}/${path}${url.search}`);
  return new Response(response.body, {
    status: response.status,
    headers: { "content-type": response.headers.get("content-type") ?? "application/json" },
  });
}));
