// Releases (PLAN_1 §4.1): one per CI run attempt (source "ci"), or per direct deployment with a PAT (source
// "direct"). A release groups the deployments (migrations, functions, frontend) it published.
import type { ReleaseInfo } from "@platform/shared";
import { type AppRow, UserError } from "./apps.ts";
import { audit } from "./audit.ts";
import type { User } from "./auth.ts";
import { one } from "./db.ts";
import { getSettings } from "./settings.ts";

export interface ReleaseRow {
  id: string;
  app_id: string;
  source: "ci" | "direct";
  status: "running" | "succeeded" | "failed";
  commit_sha: string | null;
  ref: string | null;
  ci_run_id: string | null;
  ci_run_url: string | null;
  github_actor: string | null;
  created_by: string | null;
  admin_exception: boolean;
  reason: string | null;
  error: string | null;
  started_at: Date;
  finished_at: Date | null;
}

export const releaseInfo = (r: ReleaseRow & { created_by_email?: string | null }): ReleaseInfo => ({
  id: r.id,
  source: r.source,
  status: r.status,
  commit_sha: r.commit_sha,
  ci_run_url: r.ci_run_url,
  github_actor: r.github_actor,
  created_by: r.created_by_email ?? null,
  admin_exception: r.admin_exception,
  reason: r.reason,
  started_at: r.started_at.toISOString(),
  finished_at: r.finished_at?.toISOString() ?? null,
});

export async function lastRelease(app: AppRow) {
  const row = await one<ReleaseRow & { created_by_email: string | null }>(
    `select r.*, u.email as created_by_email from releases r left join users u on u.id = r.created_by
      where r.app_id = $1 order by r.started_at desc limit 1`,
    [app.id],
  );
  return row ? releaseInfo(row) : null;
}

type NewRelease = Partial<Pick<ReleaseRow,
  "status" | "commit_sha" | "ref" | "ci_run_id" | "ci_run_url" | "github_actor" | "created_by" | "admin_exception" | "reason">> & {
  source: ReleaseRow["source"];
};

/** Inserts a release (idempotent per CI run attempt: returns the existing one) and audits its creation. */
export async function createRelease(app: AppRow, release: NewRelease): Promise<ReleaseRow> {
  const status = release.status ?? "running";
  const inserted = await one<ReleaseRow>(
    `insert into releases (app_id, source, status, commit_sha, ref, ci_run_id, ci_run_url, github_actor, created_by,
       admin_exception, reason, finished_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, case when $3 = 'running' then null else now() end)
     on conflict (app_id, ci_run_id) where ci_run_id is not null do nothing
     returning *`,
    [app.id, release.source, status, release.commit_sha ?? null, release.ref ?? null, release.ci_run_id ?? null,
      release.ci_run_url ?? null, release.github_actor ?? null, release.created_by ?? null,
      release.admin_exception ?? false, release.reason ?? null],
  );
  if (!inserted) {
    return (await one<ReleaseRow>("select * from releases where app_id = $1 and ci_run_id = $2", [
      app.id,
      release.ci_run_id,
    ]))!;
  }
  await audit(release.created_by ?? null, app.id, "create_release", {
    release_id: inserted.id,
    source: inserted.source,
    commit_sha: inserted.commit_sha,
    ci_run_url: inserted.ci_run_url,
    github_actor: inserted.github_actor,
    admin_exception: inserted.admin_exception,
    reason: inserted.reason,
  });
  return inserted;
}

export async function finishRelease(actorId: string | null, release: ReleaseRow, status: "succeeded" | "failed",
  error?: string) {
  const finished = await one<ReleaseRow>(
    `update releases set status = $2, error = $3, finished_at = now() where id = $1 and status = 'running' returning *`,
    [release.id, status, error ?? null],
  );
  if (!finished) throw new UserError(`release ${release.id} is already ${release.status}`);
  await audit(actorId, release.app_id, "finish_release", { release_id: release.id, status });
  return releaseInfo(finished);
}

export function requireRunning(release: ReleaseRow | undefined, app: AppRow): ReleaseRow {
  if (!release || release.app_id !== app.id) throw new UserError("release not found for this app");
  if (release.status !== "running") throw new UserError(`release ${release.id} is already ${release.status}`);
  return release;
}

// --- Direct deployments (PAT through MCP) ---

/**
 * DIRECT_DEPLOY gate on the MCP publishing tools: with "admins", only admins publish with a PAT (the audited
 * exception, PLAN_1 §6.3); builders go through CI. Returns whether this publication is an admin exception.
 */
export async function requireDirectDeploy(user: User): Promise<{ adminException: boolean }> {
  const { directDeploy } = await getSettings();
  if (directDeploy === "everyone") return { adminException: false };
  if (user.role !== "admin") {
    throw new UserError(
      "direct deployment is reserved to admins on this platform (DIRECT_DEPLOY=admins): push to the default " +
        "branch of the app's linked repository and let its CI workflow deploy. dry_run stays available.",
    );
  }
  return { adminException: true };
}

export async function beginDirectRelease(user: User, app: AppRow, options: { commitSha?: string; reason?: string }) {
  const { adminException } = await requireDirectDeploy(user);
  return createRelease(app, {
    source: "direct",
    commit_sha: options.commitSha,
    created_by: user.id,
    admin_exception: adminException,
    reason: options.reason,
  });
}

/** A release given to a publishing tool: a running direct release of the same app. */
export async function directRelease(app: AppRow, releaseId: string) {
  const release = requireRunning(await one<ReleaseRow>("select * from releases where id = $1", [releaseId]), app);
  if (release.source !== "direct") throw new UserError("a CI release cannot be used with a personal access token");
  return release;
}

/** Without release_id, a successful direct publication is recorded as its own, already finished, release. */
export async function implicitDirectRelease(user: User, app: AppRow) {
  const { adminException } = await requireDirectDeploy(user);
  return createRelease(app, {
    source: "direct",
    status: "succeeded",
    created_by: user.id,
    admin_exception: adminException,
  });
}

export async function releaseForUser(user: User, releaseId: string) {
  const release = await one<ReleaseRow & { slug: string }>(
    "select r.*, a.slug from releases r join apps a on a.id = r.app_id where r.id = $1",
    [releaseId],
  );
  if (!release) throw new UserError("release not found");
  return release;
}
