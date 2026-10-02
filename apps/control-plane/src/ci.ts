// CI deployment API (PLAN_1 §5.1) on api.<domain>/ci/*: the MCP deployment operations for GitHub Actions,
// authenticated by a GitHub OIDC token instead of a PAT.
//
// Every request: valid signature (issuer JWKS), issuer, audience, expiry; `job_workflow_ref` in the allow-list;
// `repository_id` equal to the app's linked repository. Then the mode:
//   deploy: `ref` is the app's default branch and `ref_protected` is true -> may publish (release, migrations,
//           deployments);
//   check:  any other ref of the linked repository (pull requests) -> get_app and migrations dry_run only.
import { type Context, Hono } from "hono";
import { z } from "zod";
import { ciInputs } from "@platform/shared";
import { AppStoppedError, type AppRow, appInfo, requireWritable, UserError } from "./apps.ts";
import type { Actor } from "./auth.ts";
import { one } from "./db.ts";
import { createDeployment, deploymentOfApp, finalizeDeployment } from "./deployments.ts";
import { githubServerUrl, type GithubClaims, OidcError, verifyGithubToken, workflowAllowed } from "./oidc.ts";
import { createRelease, finishRelease, releaseInfo, type ReleaseRow, requireRunning } from "./releases.ts";
import { getSettings, type Settings } from "./settings.ts";
import { applyMigrations, StructuredUserError } from "./sql.ts";

class CiError extends Error {
  readonly status: 401 | 403 | 404 | 409;
  constructor(status: 401 | 403 | 404 | 409, message: string) {
    super(message);
    this.status = status;
  }
}

interface CiContext {
  app: AppRow;
  claims: GithubClaims;
  settings: Settings;
  mode: "check" | "deploy";
  /** Why the token is in check mode (empty in deploy mode). */
  checkReasons: string[];
  actor: Actor;
  runId: string;
}

async function ciContext(c: Context): Promise<CiContext> {
  const match = /^Bearer\s+(\S+)$/i.exec(c.req.header("authorization") ?? "");
  if (!match) throw new CiError(401, "missing GitHub OIDC token (Authorization: Bearer <token>)");
  const settings = await getSettings();
  let claims: GithubClaims;
  try {
    claims = await verifyGithubToken(match[1]!, settings);
  } catch (error) {
    if (error instanceof OidcError) throw new CiError(401, error.message);
    throw error;
  }
  if (!workflowAllowed(claims.job_workflow_ref, settings.ciAllowedWorkflows)) {
    throw new CiError(403, `workflow ${claims.job_workflow_ref} is not allowed by the platform (CI_ALLOWED_WORKFLOWS)`);
  }
  const slug = c.req.param("app")!;
  const app = await one<AppRow>("select * from apps where slug = $1 and status <> 'deleted'", [slug]);
  // unknown app and app linked to another repository look the same
  if (!app || app.github_repo_id === null || app.github_repo_id !== claims.repository_id) {
    throw new CiError(403, `app "${slug}" is not linked to repository ${claims.repository} (id ${claims.repository_id})`);
  }
  const checkReasons: string[] = [];
  const branchRef = `refs/heads/${app.default_branch}`;
  if (claims.ref !== branchRef) checkReasons.push(`ref ${claims.ref} is not the default branch ${branchRef}`);
  if (claims.ref_protected !== "true") checkReasons.push(`${claims.ref} is not a protected branch`);
  return {
    app,
    claims,
    settings,
    mode: checkReasons.length ? "check" : "deploy",
    checkReasons,
    actor: { id: null, email: `github:${claims.actor}` },
    runId: `${claims.run_id}/${claims.run_attempt}`,
  };
}

function requirePublish(ctx: CiContext) {
  if (ctx.mode === "check") {
    throw new CiError(403, `check mode (${ctx.checkReasons.join("; ")}): only get_app and migrations dry_run are allowed`);
  }
  requireWritable(ctx.app, "deploying");
}

/** The release opened by this run attempt (POST /release). */
async function runRelease(ctx: CiContext) {
  const release = await one<ReleaseRow>("select * from releases where app_id = $1 and ci_run_id = $2", [
    ctx.app.id,
    ctx.runId,
  ]);
  if (!release) throw new CiError(409, `no release for run ${ctx.runId}: POST /ci/apps/${ctx.app.slug}/release first`);
  return release;
}

async function body<T extends z.ZodRawShape>(c: Context, shape: T) {
  return z.object(shape).parse(await c.req.json().catch(() => ({})));
}

function errorResponse(c: Context, error: unknown) {
  if (error instanceof CiError) return c.json({ error: error.message }, error.status);
  if (error instanceof AppStoppedError) return c.json({ error: error.message, code: error.code }, 409);
  if (error instanceof StructuredUserError) return c.json({ error: error.message, ...error.details }, 422);
  if (error instanceof UserError) return c.json({ error: error.message }, 400);
  if (error instanceof z.ZodError) return c.json({ error: "invalid request body", issues: error.issues }, 400);
  console.error(error);
  return c.json({ error: "internal error" }, 500);
}

const handle = (fn: (c: Context, ctx: CiContext) => Promise<unknown>) => async (c: Context) => {
  try {
    return c.json(await fn(c, await ciContext(c)));
  } catch (error) {
    return errorResponse(c, error);
  }
};

export const ciRoutes = new Hono();

ciRoutes.get("/apps/:app", handle(async (_c, ctx) => ({
  ...(await appInfo({ ...ctx.app, member_role: "ci" })),
  mode: ctx.mode,
  check_reasons: ctx.checkReasons,
})));

ciRoutes.post("/apps/:app/release", handle(async (_c, ctx) => {
  requirePublish(ctx);
  const { claims } = ctx;
  const release = await createRelease(ctx.app, {
    source: "ci",
    commit_sha: claims.sha,
    ref: claims.ref,
    ci_run_id: ctx.runId,
    ci_run_url: `${githubServerUrl(ctx.settings.oidcIssuer)}/${claims.repository}/actions/runs/${claims.run_id}` +
      `/attempts/${claims.run_attempt}`,
    github_actor: claims.actor,
  });
  return releaseInfo(requireRunning(release, ctx.app));
}));

ciRoutes.post("/apps/:app/release/finish", handle(async (c, ctx) => {
  const { status, error } = await body(c, ciInputs.finish_release);
  return finishRelease(null, await runRelease(ctx), status, error);
}));

ciRoutes.post("/apps/:app/migrations", handle(async (c, ctx) => {
  const { migrations, dry_run, accept_lints } = await body(c, ciInputs.apply_migrations);
  if (dry_run) return applyMigrations(ctx.actor, ctx.app, migrations, { dryRun: true });
  requirePublish(ctx);
  const release = requireRunning(await runRelease(ctx), ctx.app);
  return applyMigrations(ctx.actor, ctx.app, migrations, {
    acceptLints: accept_lints ?? [],
    release: async () => release.id,
  });
}));

ciRoutes.post("/apps/:app/deployments", handle(async (c, ctx) => {
  const { kind } = await body(c, ciInputs.create_deployment);
  requirePublish(ctx);
  const release = requireRunning(await runRelease(ctx), ctx.app);
  return { ...(await createDeployment(ctx.actor, ctx.app, kind, release.id)), release_id: release.id };
}));

ciRoutes.post("/apps/:app/deployments/:id/finalize", handle(async (c, ctx) => {
  requirePublish(ctx);
  const release = requireRunning(await runRelease(ctx), ctx.app);
  const id = z.uuid().safeParse(c.req.param("id"));
  if (!id.success) throw new CiError(404, "deployment not found");
  const deployment = await deploymentOfApp(ctx.app, id.data);
  if (deployment.release_id !== release.id) throw new CiError(403, "this deployment belongs to another release");
  return { ...(await finalizeDeployment(ctx.actor, deployment, ctx.app)), release_id: release.id };
}));
