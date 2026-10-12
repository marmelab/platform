// Admin REST API (M4, PLAN_1 §8), served same-origin with the admin SPA at admin.<domain>/api/* (site.ts).
// Resources follow the ra-data-simple-rest conventions (rest.ts). Every handler reuses the domain functions of the
// MCP tools and the CLI (same guards), with the signed-in admin as the audited actor.
import { statfs } from "node:fs/promises";
import { cpus, freemem, loadavg, totalmem, uptime } from "node:os";
import { deploymentKind, memberRole, toolInputs } from "@platform/shared";
import { Hono } from "hono";
import { z } from "zod";
import { type AppRow, deleteAppConfirmed, orchestrator, startApp, stopApp, studio } from "../apps.ts";
import { isAbandoned } from "../abandoned.ts";
import { appAuthView } from "../app-auth.ts";
import { audit } from "../audit.ts";
import type { User } from "../auth.ts";
import { adminUrl, appUrl, config, studioUrl } from "../config.ts";
import { randomToken, sha256 } from "../crypto.ts";
import { many, one, platform, transaction } from "../db.ts";
import { rollback } from "../deployments.ts";
import { getLogs } from "../logs.ts";
import { sendPlatformMail } from "../mailer.ts";
import { sampleMetrics } from "../metrics.ts";
import { addMember, removeMember } from "../members.ts";
import { backupView, type BackupRow, createManualBackup } from "../backups.ts";
import { restoreBackup } from "../restore.ts";
import { latestLints, lintApp, lintHistory } from "../lint.ts";
import { platformVersion } from "../version.ts";
import { deleteShadowUser, endOAuthSessions, revokeGrant } from "../platform-auth.ts";
import { githubServerUrl } from "../oidc.ts";
import { listSchemaChanges, schemaDrift } from "../schema-changes.ts";
import { listSecrets } from "../secrets.ts";
import { MIN_PASSWORD_LENGTH, setPassword } from "../sessions.ts";
import {
  backupSummary,
  getSettings,
  setSetting,
  settingOverrides,
  settingsSummary,
  SSO_PROVIDER_KEYS,
  ssoActive,
  ssoSummary,
  unsetSetting,
  validateSetting,
} from "../settings.ts";
import { syncCompanySso } from "../app-sso.ts";
import { discover, ssoCallbackUrl, SsoError } from "../sso.ts";
import { errorResponse, HttpError, includes, listInMemory, type ListParams, listParams, page, truthy } from "./rest.ts";

export type AdminEnv = { Variables: { admin: User } };

export const adminApi = new Hono<AdminEnv>();
adminApi.onError((error, c) => errorResponse(c, error));

const body = async <T extends z.ZodType>(c: { req: { json: () => Promise<unknown> } }, schema: T): Promise<z.infer<T>> =>
  schema.parse(await c.req.json().catch(() => {
    throw new HttpError(400, "invalid JSON body");
  }));

const notAllowed = (message: string) => () => {
  throw new HttpError(405, message);
};

// ---------------------------------------------------------------------------------------------------------------
// users

interface UserRecord extends Record<string, unknown> {
  id: string;
  email: string;
  name: string | null;
  role: "admin" | "developer";
  active: boolean;
  sso_linked: boolean;
}

const USERS_SQL = `
  select u.id, u.email, u.name, u.role, u.active, u.created_at, u.password_hash is not null as has_password,
    (select count(*)::int from app_members m join apps a on a.id = m.app_id
      where m.user_id = u.id and a.status <> 'deleted') as app_count,
    (select count(*)::int from app_members m where m.user_id = u.id and m.role = 'owner') as owned_app_count,
    (select count(*)::int from tokens t where t.user_id = u.id and t.revoked_at is null
      and (t.expires_at is null or t.expires_at > now())) as active_token_count,
    (select max(t.last_used_at) from tokens t where t.user_id = u.id) as last_token_use,
    (select max(s.created_at) from sessions s where s.user_id = u.id) as last_login,
    u.sso_subject is not null as sso_linked
  from users u`;

async function userRecord(id: string) {
  if (!z.uuid().safeParse(id).success) throw new HttpError(404, "user not found");
  const user = await one<UserRecord>(`${USERS_SQL} where u.id = $1`, [id]);
  if (!user) throw new HttpError(404, "user not found");
  return user;
}

adminApi.get("/users", async (c) => {
  const params = listParams(c);
  const rows = await many<UserRecord>(USERS_SQL);
  const { rows: result, total } = listInMemory(rows, params, {
    q: (u, q) => includes(u.email, q) || includes(u.name, q),
  }, { field: "email", order: "ASC" });
  return page(c, "users", result, total, params.range);
});

adminApi.get("/users/:id", async (c) => c.json(await userRecord(c.req.param("id"))));

const password = z.string().min(MIN_PASSWORD_LENGTH, `at least ${MIN_PASSWORD_LENGTH} characters`);
const role = z.enum(["admin", "developer"]);

adminApi.post("/users", async (c) => {
  const admin = c.get("admin");
  const input = await body(c, z.object({
    email: z.email(),
    name: z.string().trim().max(200).nullish(),
    role: role.default("developer"),
    active: z.boolean().default(true),
    password: z.union([password, z.literal("")]).nullish(),
  }));
  const email = input.email.toLowerCase();
  const created = await one<{ id: string }>(
    `insert into users (email, name, role, active) values ($1, $2, $3, $4)
     on conflict (email) do nothing returning id`,
    [email, input.name || null, input.role, input.active],
  );
  if (!created) throw new HttpError(409, `a user with email ${email} already exists`);
  if (input.password) await setPassword(email, input.password);
  // M6: a welcome email (no secret in it: the admin hands over the password or token) when the platform has SMTP
  const welcome = input.active ? await sendWelcome(email, input.role).catch((error) => {
    console.error(`welcome email to ${email} failed`, error);
    return false;
  }) : false;
  await audit(admin.id, null, "create_user", {
    email,
    role: input.role,
    active: input.active,
    password_set: !!input.password,
    welcome_email_sent: welcome,
  });
  return c.json({ ...(await userRecord(created.id)), welcome_email_sent: welcome }, 201);
});

async function sendWelcome(email: string, role: "admin" | "developer") {
  const { sso } = await getSettings();
  const ssoLogin = ssoActive(sso);
  const passwordToo = !ssoLogin || sso.passwordLogin === "everyone" || role === "admin";
  return sendPlatformMail({
    to: [email],
    subject: "Your account on the app platform",
    text: [
      "Hello,",
      "",
      `An account was created for you (${email}) on the company's app platform${role === "admin" ? ", as an admin" : ""}.`,
      "",
      "- Build and deploy apps with Claude Code: install the platform plugin, then ask Claude to deploy your app. " +
      "The first time, Claude Code opens your browser: sign in with your platform account and allow the access.",
      `- Inspect your apps' data in Studio: ${studioUrl()} (sign in ${ssoLogin ? `with ${sso.name}${passwordToo ? ", or with this email and the password your admin gives you" : ""}` : "with this email and the password your admin gives you"}).`,
      ...(role === "admin" ? [`- Administration console: ${adminUrl()}`] : []),
      "",
      ...(passwordToo ? ["Your admin gives you your password over a private channel: it is never sent by email."] : []),
    ].join("\n"),
  });
}

adminApi.put("/users/:id", async (c) => {
  const admin = c.get("admin");
  const before = await userRecord(c.req.param("id"));
  // react-admin sends the whole record back: unknown and read-only fields are ignored
  const input = await body(c, z.object({
    name: z.string().trim().max(200).nullish(),
    role: role.optional(),
    active: z.boolean().optional(),
    password: z.union([password, z.literal("")]).nullish(),
    /** false unlinks the account from its SSO identity (the next SSO login links it again, by email) */
    sso_linked: z.boolean().optional(),
  }));
  const self = before.id === admin.id;
  if (self && input.role && input.role !== before.role) throw new HttpError(400, "you cannot change your own role");
  if (self && input.active === false) throw new HttpError(400, "you cannot disable your own account");
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  const next = {
    name: input.name === undefined ? before.name : input.name || null,
    role: input.role ?? before.role,
    active: input.active ?? before.active,
  };
  for (const key of ["name", "role", "active"] as const) {
    if (next[key] !== before[key]) changes[key] = { from: before[key], to: next[key] };
  }
  if (Object.keys(changes).length) {
    await platform.query("update users set name = $2, role = $3, active = $4 where id = $1", [
      before.id,
      next.name,
      next.role,
      next.active,
    ]);
    // a disabled account loses its browser sessions at once (its tokens stop working too: authenticate() checks
    // active), and its Claude Code connections can no longer refresh their access tokens
    if (!next.active) {
      await platform.query("delete from sessions where user_id = $1", [before.id]);
      await endOAuthSessions(before.id);
    }
    await audit(admin.id, null, "update_user", { email: before.email, changes });
  }
  if (input.password) {
    await setPassword(before.email, input.password);
    await audit(admin.id, null, "set_password", { email: before.email });
  }
  if (input.sso_linked === false && before.sso_linked) {
    await platform.query("update users set sso_issuer = null, sso_subject = null where id = $1", [before.id]);
    await audit(admin.id, null, "unlink_sso", { email: before.email });
  }
  return c.json(await userRecord(before.id));
});

adminApi.delete("/users/:id", async (c) => {
  const admin = c.get("admin");
  const user = await userRecord(c.req.param("id"));
  if (user.id === admin.id) throw new HttpError(400, "you cannot delete your own account");
  const orphaned = await many<{ slug: string }>(
    `select a.slug from apps a join app_members m on m.app_id = a.id and m.user_id = $1 and m.role = 'owner'
      where not exists (select 1 from app_members o where o.app_id = a.id and o.role = 'owner' and o.user_id <> $1)
      order by a.slug`,
    [user.id],
  );
  if (orphaned.length) {
    throw new HttpError(
      409,
      `${user.email} is the last owner of ${orphaned.map((a) => a.slug).join(", ")}: add another owner first, or ` +
        "delete these apps",
    );
  }
  await transaction(async (tx) => {
    // apps.owner_id (creator) moves to another owner of the app, or to the acting admin
    await tx.query(
      `update apps set owner_id = coalesce((select m.user_id from app_members m
          where m.app_id = apps.id and m.role = 'owner' and m.user_id <> $1 order by m.user_id limit 1), $2)
        where owner_id = $1`,
      [user.id, admin.id],
    );
    await tx.query("delete from users where id = $1", [user.id]);
  });
  await deleteShadowUser(user.id);
  await audit(admin.id, null, "delete_user", { email: user.email, role: user.role });
  return c.json(user);
});

// ---------------------------------------------------------------------------------------------------------------
// tokens: personal access tokens, Claude Code connections (OAuth, oauth.ts) and deploy tokens (deploy-tokens.ts)

const TOKENS_SQL = `
  select t.id, t.user_id, u.email as user_email, t.name, t.kind, t.scopes, t.created_at, t.last_used_at, t.expires_at,
    t.revoked_at, t.oauth_client_id, t.parent_id,
    case when t.kind = 'oauth' then t.name end as client_name,
    (select string_agg(a.slug, ', ' order by a.slug) from apps a where a.id = any(t.app_ids)) as apps,
    case when t.revoked_at is not null then 'revoked'
         when t.expires_at is not null and t.expires_at <= now() then 'expired' else 'active' end as status
  from tokens t join users u on u.id = t.user_id`;

async function tokenRecord(id: string) {
  if (!z.uuid().safeParse(id).success) throw new HttpError(404, "token not found");
  const token = await one<Record<string, unknown> & {
    id: string;
    user_id: string;
    user_email: string;
    name: string;
    kind: string;
    oauth_client_id: string | null;
  }>(
    `${TOKENS_SQL} where t.id = $1`,
    [id],
  );
  if (!token) throw new HttpError(404, "token not found");
  return token;
}

adminApi.get("/tokens", async (c) => {
  const params = listParams(c);
  const rows = await many<Record<string, unknown>>(TOKENS_SQL);
  const { rows: result, total } = listInMemory(rows, params, {
    q: (t, q) => includes(t.name, q) || includes(t.user_email, q),
  }, { field: "created_at", order: "DESC" });
  return page(c, "tokens", result, total, params.range);
});

adminApi.get("/tokens/:id", async (c) => c.json(await tokenRecord(c.req.param("id"))));

/** The value is returned once, in `token`: only its hash is stored. */
adminApi.post("/tokens", async (c) => {
  const admin = c.get("admin");
  const input = await body(c, z.object({
    user_id: z.uuid(),
    name: z.string().trim().min(1).max(100),
    expires_at: z.union([z.iso.datetime({ offset: true }), z.iso.date(), z.literal("")]).nullish(),
  }));
  const user = await one<{ id: string; email: string }>("select id, email from users where id = $1", [input.user_id]);
  if (!user) throw new HttpError(400, "unknown user");
  const expiresAt = input.expires_at ? new Date(input.expires_at) : null;
  if (expiresAt && expiresAt.getTime() <= Date.now()) throw new HttpError(400, "expires_at must be in the future");
  const value = randomToken("plat");
  const created = await one<{ id: string }>(
    "insert into tokens (user_id, name, hash, expires_at) values ($1, $2, $3, $4) returning id",
    [user.id, input.name, sha256(value), expiresAt],
  );
  await audit(admin.id, null, "create_token", {
    token_id: created!.id,
    email: user.email,
    name: input.name,
    expires_at: expiresAt?.toISOString() ?? null,
  });
  return c.json({ ...(await tokenRecord(created!.id)), token: value }, 201);
});

adminApi.put("/tokens/:id", notAllowed("tokens cannot be edited: revoke it and create a new one"));

/**
 * DELETE revokes (the row stays, with revoked_at, for the audit trail), with the deploy tokens it minted. A Claude
 * Code connection is revoked for its client as a whole: the consent and every session of the account with this client
 * (GoTrue), so that the next use asks to sign in again. Idempotent.
 */
adminApi.delete("/tokens/:id", async (c) => {
  const admin = c.get("admin");
  const token = await tokenRecord(c.req.param("id"));
  const revoked = token.kind === "oauth" && token.oauth_client_id
    ? await many<{ id: string }>(
      `update tokens set revoked_at = now()
        where kind = 'oauth' and user_id = $1 and oauth_client_id = $2 and revoked_at is null returning id`,
      [token.user_id, token.oauth_client_id],
    )
    : await many<{ id: string }>("update tokens set revoked_at = now() where id = $1 and revoked_at is null returning id", [
      token.id,
    ]);
  const ids = [token.id, ...revoked.map((r) => r.id)];
  await platform.query("update tokens set revoked_at = now() where parent_id = any($1) and revoked_at is null", [ids]);
  if (token.kind === "oauth" && token.oauth_client_id) {
    const owner = await one<User>("select id, email, name, role from users where id = $1", [token.user_id]);
    if (owner) await revokeGrant(owner, token.oauth_client_id);
  }
  if (revoked.length) {
    await audit(admin.id, null, token.kind === "oauth" ? "oauth_token_revoked" : "revoke_token", {
      token_id: token.id,
      email: token.user_email,
      name: token.name,
      kind: token.kind,
      ...(token.kind === "oauth" ? { client_id: token.oauth_client_id, connections: revoked.length } : {}),
    });
  }
  return c.json(await tokenRecord(token.id));
});

// ---------------------------------------------------------------------------------------------------------------
// apps (id = slug)

interface LastRelease {
  id: string;
  source: "ci" | "direct";
  status: "running" | "succeeded" | "failed";
  commit_sha: string | null;
  ci_run_url: string | null;
  github_actor: string | null;
  created_by: string | null;
  admin_exception: boolean;
  reason: string | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

interface AppListRow extends Record<string, unknown> {
  uuid: string;
  id: string;
  slug: string;
  name: string;
  status: string;
  github_repo: string | null;
  owners: { id: string; email: string; name: string | null }[];
  last_release: LastRelease | null;
  accepted_lints: number;
  lint: { ran_at: string; errors: number; warnings: number; failed: boolean; unaccepted_errors: number } | null;
  last_request_at: Date | null;
  created_at: Date;
  restored_at: Date | null;
  requests_24h: string;
  errors_24h: string;
  memory: string | null;
  traffic_7d: { day: string; requests: number; errors: number }[];
}

/** What the abandoned flag (A6) is computed from: the setting, and the first metrics sample. */
interface Activity {
  abandonedAfterDays: number;
  /** Requests are only known since the first sample: an older app is not judged on a period without data. */
  metricsSince: Date;
}

async function activityContext(): Promise<Activity> {
  const [settings, state] = await Promise.all([
    getSettings(),
    one<{ started_at: Date }>("select started_at from metrics_state where id = 1"),
  ]);
  return { abandonedAfterDays: settings.abandonedAfterDays, metricsSince: state?.started_at ?? new Date() };
}

const APPS_SQL = `
  select a.id as uuid, a.slug as id, a.slug, a.name, a.status, a.error, a.github_repo, a.github_repo_id::text,
    a.default_branch, a.created_at, a.restored_at, a.updated_at, a.abandoned_notified_at,
    coalesce((select json_agg(json_build_object('id', u.id, 'email', u.email, 'name', u.name) order by u.email)
      from app_members m join users u on u.id = m.user_id where m.app_id = a.id and m.role = 'owner'), '[]'::json) as owners,
    (select count(*)::int from app_members m where m.app_id = a.id) as member_count,
    (select row_to_json(x) from (
      select r.id, r.source, r.status, r.commit_sha, r.ci_run_url, r.github_actor, u.email as created_by,
        r.admin_exception, r.reason, r.error, r.started_at, r.finished_at
        from releases r left join users u on u.id = r.created_by
       where r.app_id = a.id order by r.started_at desc limit 1) x) as last_release,
    (select coalesce(sum(jsonb_array_length(d.manifest->'accepted_lints')), 0)::int from deployments d
      where d.app_id = a.id and d.kind = 'migrations' and jsonb_typeof(d.manifest->'accepted_lints') = 'array') as accepted_lints,
    -- security linter (lint.ts): the latest run's counts, ERRORs accepted by a migration left out
    (select json_build_object('ran_at', lr.ran_at, 'errors', lr.errors, 'warnings', lr.warnings, 'failed', lr.error is not null,
        'unaccepted_errors', (select count(*)::int from jsonb_array_elements(lr.lints) l
          where l->>'level' = 'ERROR' and not exists (
            select 1 from deployments d, jsonb_array_elements(d.manifest->'accepted_lints') acc
             where d.app_id = a.id and d.kind = 'migrations' and jsonb_typeof(d.manifest->'accepted_lints') = 'array'
               and acc->>'name' = l->>'name' and acc->>'object' = l->>'object')))
       from lint_runs lr where lr.app_id = a.id order by lr.ran_at desc limit 1) as lint,
    (select max(d.version) from deployments d where d.app_id = a.id and d.kind = 'frontend' and d.status = 'live') as frontend_version,
    (select max(d.version) from deployments d where d.app_id = a.id and d.kind = 'functions' and d.status = 'live') as functions_version,
    (select pg_database_size(db.datname) from pg_database db where db.datname = a.db_name) as db_size,
    a.last_request_at,
    -- load (app_metrics, metrics.ts): the last 24 hourly rows (current hour included), the latest memory sample
    (select coalesce(sum(m.requests), 0)::text from app_metrics m
      where m.app_id = a.id and m.hour >= date_trunc('hour', now()) - interval '23 hours') as requests_24h,
    (select coalesce(sum(m.responses_5xx), 0)::text from app_metrics m
      where m.app_id = a.id and m.hour >= date_trunc('hour', now()) - interval '23 hours') as errors_24h,
    (select m.memory_bytes::text from app_metrics m where m.app_id = a.id and m.memory_bytes is not null
      order by m.hour desc limit 1) as memory,
    -- 7 UTC days, oldest first, zeros included
    (select json_agg(json_build_object('day', d.day, 'requests', coalesce(x.requests, 0), 'errors', coalesce(x.errors, 0))
        order by d.day)
       from generate_series(date_trunc('day', now()) - interval '6 days', date_trunc('day', now()), interval '1 day') d(day)
       left join lateral (select sum(m.requests)::int as requests, sum(m.responses_5xx)::int as errors from app_metrics m
         where m.app_id = a.id and m.hour >= d.day and m.hour < d.day + interval '1 day') x on true) as traffic_7d
  from apps a where a.status <> 'deleted'`;

/** GitHub links of a repository: github.com, or the GHES host derived from the OIDC issuer (as the CI run URLs). */
async function githubBase() {
  return githubServerUrl((await getSettings()).oidcIssuer);
}

function decorateApp(row: AppListRow, github: string, activity: Activity) {
  const release = row.last_release;
  const repoUrl = row.github_repo ? `${github}/${row.github_repo}` : null;
  // A6: the last request, the last release, the app's creation or restore, or the start of the metrics, whichever is latest
  const lastActivity = new Date(Math.max(
    ...[row.last_request_at, release?.started_at, row.created_at, row.restored_at, activity.metricsSince]
      .filter((d) => d !== null && d !== undefined).map((d) => new Date(d as string | Date).getTime()),
  ));
  const abandoned = isAbandoned(lastActivity, activity.abandonedAfterDays);
  return {
    ...row,
    db_size: row.db_size === null || row.db_size === undefined ? null : Number(row.db_size),
    requests_24h: Number(row.requests_24h),
    errors_24h: Number(row.errors_24h),
    memory: row.memory === null ? null : Number(row.memory),
    last_activity_at: lastActivity.toISOString(),
    url: appUrl(row.slug),
    studio_url: studio.deepLink(row.slug),
    github_url: repoUrl,
    owner_email: row.owners[0]?.email ?? null,
    last_release_at: release?.started_at ?? null,
    last_release: release && {
      ...release,
      commit_url: repoUrl && release.commit_sha ? `${repoUrl}/commit/${release.commit_sha}` : null,
    },
    flags: {
      /** Last release published with a PAT (A10): flagged until the next CI release. */
      outside_ci: release?.source === "direct",
      admin_exception: release?.admin_exception ?? false,
      last_release_failed: release?.status === "failed",
      stopped: row.status === "stopped",
      error: row.status === "error",
      accepted_lints: row.accepted_lints,
      /** ERROR lints of the latest linter run not accepted by a migration (PLAN_1 §8). */
      lint_errors: row.lint?.unaccepted_errors ?? 0,
      no_repo: !row.github_repo,
      /** Filled for the returned page only (it reads every app database). */
      schema_drift: null as number | null,
      /** No request and no release for `abandoned_after_days` (A6). */
      abandoned,
    },
  };
}
type AppRecord = ReturnType<typeof decorateApp>;

async function withDrift(app: AppRecord) {
  const drift = await Promise.race([
    schemaDrift({ id: app.uuid, slug: app.slug } as AppRow).then((d) => d.count),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000)),
  ]).catch(() => null);
  app.flags.schema_drift = drift;
  return app;
}

async function appRecords() {
  const [github, activity] = await Promise.all([githubBase(), activityContext()]);
  return (await many<AppListRow>(APPS_SQL)).map((row) => decorateApp(row, github, activity));
}

const flag = (name: keyof AppRecord["flags"]) => (app: AppRecord, value: unknown) =>
  Boolean(app.flags[name]) === truthy(value);

adminApi.get("/apps", async (c) => {
  const params = listParams(c);
  let apps = await appRecords();
  // the drift filter needs every app's count; otherwise only the returned page is enriched
  const driftFilter = params.filter.schema_drift !== undefined && params.filter.schema_drift !== "";
  if (driftFilter || params.sort?.field === "flags.schema_drift") apps = await Promise.all(apps.map(withDrift));
  const { rows, total } = listInMemory(apps, params, {
    q: (a, q) =>
      includes(a.slug, q) || includes(a.name, q) || includes(a.github_repo, q) ||
      a.owners.some((o) => includes(o.email, q) || includes(o.name, q)),
    owner_id: (a, id) => a.owners.some((o) => o.id === id),
    outside_ci: flag("outside_ci"),
    admin_exception: flag("admin_exception"),
    stopped: flag("stopped"),
    no_repo: flag("no_repo"),
    accepted_lints: flag("accepted_lints"),
    lint_errors: flag("lint_errors"),
    schema_drift: flag("schema_drift"),
    last_release_failed: flag("last_release_failed"),
    abandoned: flag("abandoned"),
    flagged: (a, value) =>
      (a.flags.outside_ci || a.flags.accepted_lints > 0 || a.flags.lint_errors > 0 || a.flags.error || a.flags.last_release_failed ||
        a.flags.abandoned) === truthy(value),
  }, { field: "slug", order: "ASC" });
  return page(c, "apps", driftFilter ? rows : await Promise.all(rows.map(withDrift)), total, params.range);
});

async function appRow(slug: string) {
  const app = await one<AppRow>("select * from apps where slug = $1 and status <> 'deleted'", [slug]);
  if (!app) throw new HttpError(404, `app "${slug}" not found`);
  return app;
}

async function appRecord(slug: string) {
  const [github, activity] = await Promise.all([githubBase(), activityContext()]);
  const row = await one<AppListRow>(`${APPS_SQL} and a.slug = $1`, [slug]);
  if (!row) throw new HttpError(404, `app "${slug}" not found`);
  const app = await withDrift(decorateApp(row, github, activity));
  const services = await orchestrator.appContainers(slug).catch(() => []);
  // M6: the auth policy (configure_auth) and the sender of the app's emails, read-only here
  const auth = await appAuthView({ id: app.uuid, name: app.name, slug: app.slug });
  return { ...app, services, auth };
}

adminApi.get("/apps/:slug", async (c) => c.json(await appRecord(c.req.param("slug"))));
adminApi.post("/apps", notAllowed("apps are created by their builders, through MCP (create_app)"));
adminApi.put("/apps/:slug", notAllowed("use the app actions (stop, start, delete, rollback) or the members"));
adminApi.delete("/apps/:slug", notAllowed("use POST /apps/<slug>/delete with {confirm: <slug>, backup}"));

adminApi.post("/apps/:slug/stop", async (c) => {
  const result = await stopApp(c.get("admin"), await appRow(c.req.param("slug")));
  return c.json({ ...result, data: await appRecord(result.slug) });
});

adminApi.post("/apps/:slug/start", async (c) => {
  const result = await startApp(c.get("admin"), await appRow(c.req.param("slug")));
  return c.json({ ...result, data: await appRecord(result.slug) });
});

/** Irreversible: `confirm` must repeat the slug; `backup: false` skips the final backup (data lost for good). */
adminApi.post("/apps/:slug/delete", async (c) => {
  const input = await body(c, z.object({ confirm: z.string(), backup: z.boolean().default(true) }));
  const app = await appRow(c.req.param("slug"));
  return c.json(await deleteAppConfirmed(c.get("admin"), app, input.confirm, input.backup));
});

adminApi.post("/apps/:slug/rollback", async (c) => {
  const input = await body(c, z.object({ kind: deploymentKind, version: z.number().int().positive().optional() }));
  return c.json(await rollback(c.get("admin"), await appRow(c.req.param("slug")), input.kind, input.version));
});

/** Hourly load of the app over `days` (1 to 30, default 7), oldest first, hours without a row included. */
adminApi.get("/apps/:slug/metrics", async (c) => {
  const app = await appRow(c.req.param("slug"));
  const days = Math.min(Math.max(Number(c.req.query("days")) || 7, 1), 30);
  const rows = await many<Record<string, unknown>>(
    `select h.hour, coalesce(m.requests, 0)::int as requests, coalesce(m.responses_5xx, 0)::int as responses_5xx,
        m.db_size_bytes::float8 as db_size_bytes, m.memory_bytes::float8 as memory_bytes
       from generate_series(date_trunc('hour', now()) - make_interval(hours => $2 * 24 - 1), date_trunc('hour', now()),
         interval '1 hour') h(hour)
       left join app_metrics m on m.app_id = $1 and m.hour = h.hour
      order by h.hour`,
    [app.id, days],
  );
  const state = await one<{ sampled_at: Date | null }>("select sampled_at from metrics_state where id = 1");
  return c.json({ app: app.slug, days, sampled_at: state?.sampled_at ?? null, hours: rows });
});

/** Samples app_metrics now (as the control plane does every minute): the console's refresh, and the e2e suites. */
adminApi.post("/metrics/sample", async (c) => c.json(await sampleMetrics()));

adminApi.get("/apps/:slug/logs", async (c) => {
  const app = await appRow(c.req.param("slug"));
  const service = toolInputs.get_logs.service.parse(c.req.query("service") || undefined);
  const sinceMinutes = Math.min(Math.max(Number(c.req.query("since_minutes")) || 60, 1), 7 * 24 * 60);
  const limit = Math.min(Math.max(Number(c.req.query("limit")) || 200, 1), 1000);
  return c.json(await getLogs(app, { service, sinceMinutes, limit, query: c.req.query("q") || undefined }));
});

/** Security linter (PLAN_1 §8): the latest run with its lints (`accepted` marked), and the previous runs' counts. */
adminApi.get("/apps/:slug/lints", async (c) => {
  const app = await appRow(c.req.param("slug"));
  const history = await lintHistory(app.id, 20);
  return c.json({
    app: app.slug,
    latest: await latestLints(app.id),
    history: history.map(({ lints: _lints, ...run }) => run),
  });
});

/** Runs the linter now ("Run linter"), audited. */
adminApi.post("/apps/:slug/lint", async (c) => {
  const app = await appRow(c.req.param("slug"));
  const run = await lintApp(app, "manual");
  await audit(c.get("admin").id, app.id, "lint_app", { errors: run.errors, warnings: run.warnings, infos: run.infos });
  return c.json({ app: app.slug, latest: await latestLints(app.id) });
});

/** Manual backup now ("Backup now"), audited. Waits for a backup in progress. */
adminApi.post("/apps/:slug/backup", async (c) => {
  const app = await appRow(c.req.param("slug"));
  return c.json(await createManualBackup(c.get("admin"), app));
});

// ---------------------------------------------------------------------------------------------------------------
// backups (M7, A4): every app's, deleted apps included (filter app=<slug>, kind, status, deleted)

adminApi.get("/backups", async (c) => {
  const params = listParams(c);
  const rows = (await many<BackupRow>(
    "select * from backups where ($1::text is null or slug = $1) order by started_at desc",
    [appFilter(params)],
  )).map((row) => ({ ...backupView(row), started_at: row.started_at.toISOString() }));
  const { rows: result, total } = listInMemory(rows, params, {
    app: () => true,
    q: (b, q) => includes(b.app, q) || includes(b.error, q) || includes(b.location, q),
    kind: (b, v) => b.kind === v,
    status: (b, v) => b.status === v,
    deleted: (b, v) => b.app_deleted === truthy(v),
  }, { field: "started_at", order: "DESC" });
  return page(c, "backups", result, total, params.range);
});

adminApi.get("/backups/:id", async (c) => {
  const id = c.req.param("id");
  const row = z.uuid().safeParse(id).success ? await one<BackupRow>("select * from backups where id = $1", [id]) : undefined;
  if (!row) throw new HttpError(404, "backup not found");
  return c.json({ ...backupView(row), manifest: row.manifest });
});
adminApi.post("/backups", notAllowed("use POST /apps/<slug>/backup"));
adminApi.put("/backups/:id", notAllowed("backups are read-only"));
adminApi.delete("/backups/:id", notAllowed("backups are deleted by the retention policy"));

/**
 * Restores the backup into its app (stopped, data replaced, started), or recreates its deleted app. `confirm` must
 * repeat the slug; `safety_backup: false` skips the pre_restore backup of the current state.
 */
adminApi.post("/backups/:id/restore", async (c) => {
  const input = await body(c, z.object({ confirm: z.string(), safety_backup: z.boolean().default(true) }));
  return c.json(await restoreBackup(c.get("admin"), c.req.param("id"), {
    confirm: input.confirm,
    safetyBackup: input.safety_backup,
  }));
});

/** Effective backup settings (no secret) and the last scheduled run. */
adminApi.get("/backup-settings", async (c) => c.json(await backupStatus()));

async function backupStatus() {
  const { backup } = await getSettings();
  const state = await one<{ scheduled_on: string | null; run_started_at: Date | null; run_finished_at: Date | null; run_summary: unknown }>(
    "select scheduled_on::text, run_started_at, run_finished_at, run_summary from backup_state where id = 1",
  );
  // apps whose last succeeded backup is older than 36 h (or that have none, once created or restored 36 h ago)
  const stale = await many<{ slug: string; last_backup_at: Date | null }>(
    `select a.slug, max(b.started_at) as last_backup_at from apps a
       left join backups b on b.app_id = a.id and b.status = 'succeeded'
      where a.status in ('running', 'stopped', 'error')
        and greatest(a.created_at, a.restored_at) < now() - interval '36 hours'
      group by a.slug having coalesce(max(b.started_at), '-infinity') < now() - interval '36 hours'
      order by a.slug`,
  );
  const failed = await one<{ count: number }>(
    "select count(*)::int as count from backups where status = 'failed' and started_at > now() - interval '7 days'",
  );
  return {
    ...backupSummary(backup),
    last_run: state ?? null,
    failed_7d: failed?.count ?? 0,
    stale_apps: backup.enabled ? stale : [],
  };
}

// ---------------------------------------------------------------------------------------------------------------
// app_members (id = "<slug>:<user id>")

const MEMBERS_SQL = `
  select a.slug || ':' || u.id as id, a.slug as app, a.name as app_name, a.status as app_status, u.id as user_id,
    u.email, u.name, u.active, m.role
  from app_members m join apps a on a.id = m.app_id join users u on u.id = m.user_id
  where a.status <> 'deleted'`;

async function memberRecord(id: string) {
  const [slug, userId] = id.split(":");
  if (!slug || !userId || !z.uuid().safeParse(userId).success) throw new HttpError(404, "membership not found");
  const member = await one<Record<string, unknown> & { app: string; email: string }>(
    `${MEMBERS_SQL} and a.slug = $1 and u.id = $2`,
    [slug, userId],
  );
  if (!member) throw new HttpError(404, "membership not found");
  return member;
}

adminApi.get("/app_members", async (c) => {
  const params = listParams(c);
  const rows = await many<Record<string, unknown>>(`${MEMBERS_SQL} order by a.slug, m.role = 'owner' desc, u.email`);
  const { rows: result, total } = listInMemory(rows, params, {
    q: (m, q) => includes(m.email, q) || includes(m.name, q) || includes(m.app, q),
  });
  return page(c, "app_members", result, total, params.range);
});

adminApi.get("/app_members/:id", async (c) => c.json(await memberRecord(c.req.param("id"))));

/** Adds a member, or changes the role of an existing one (members.ts: the app always keeps an owner). */
adminApi.post("/app_members", async (c) => {
  const input = await body(c, z.object({
    app: z.string(),
    email: z.email().optional(),
    user_id: z.uuid().optional(),
    role: memberRole.default("collaborator"),
  }));
  const app = await appRow(input.app);
  const email = input.email ??
    (input.user_id ? (await one<{ email: string }>("select email from users where id = $1", [input.user_id]))?.email : undefined);
  if (!email) throw new HttpError(400, "email or user_id of an existing platform account is required");
  await addMember(c.get("admin"), app, email, input.role);
  const user = await one<{ id: string }>("select id from users where email = $1", [email.toLowerCase()]);
  return c.json(await memberRecord(`${app.slug}:${user!.id}`), 201);
});

adminApi.put("/app_members/:id", async (c) => {
  const member = await memberRecord(c.req.param("id"));
  const input = await body(c, z.object({ role: memberRole }));
  await addMember(c.get("admin"), await appRow(member.app), member.email, input.role);
  return c.json(await memberRecord(c.req.param("id")));
});

adminApi.delete("/app_members/:id", async (c) => {
  const member = await memberRecord(c.req.param("id"));
  await removeMember(c.get("admin"), await appRow(member.app), member.email);
  return c.json(member);
});

// ---------------------------------------------------------------------------------------------------------------
// releases and deployments

const RELEASES_SQL = `
  select r.id, a.slug as app, a.github_repo, r.source, r.status, r.commit_sha, r.ref, r.ci_run_url, r.github_actor,
    u.email as created_by, r.admin_exception, r.reason, r.error, r.started_at, r.finished_at,
    (select p.commit_sha from releases p where p.app_id = r.app_id and p.started_at < r.started_at
      and p.status = 'succeeded' and p.commit_sha is not null order by p.started_at desc limit 1) as previous_commit,
    coalesce((select json_agg(json_build_object('id', d.id, 'kind', d.kind, 'version', d.version, 'status', d.status)
      order by d.created_at) from deployments d where d.release_id = r.id), '[]'::json) as deployments
  from releases r join apps a on a.id = r.app_id left join users u on u.id = r.created_by
  where a.status <> 'deleted'`;

function decorateRelease<T extends Record<string, unknown>>(row: T, github: string) {
  const repoUrl = row.github_repo ? `${github}/${row.github_repo}` : null;
  return {
    ...row,
    commit_url: repoUrl && row.commit_sha ? `${repoUrl}/commit/${row.commit_sha}` : null,
    /** GitHub diff since the previous succeeded release with a commit. */
    compare_url: repoUrl && row.commit_sha && row.previous_commit && row.previous_commit !== row.commit_sha
      ? `${repoUrl}/compare/${row.previous_commit}...${row.commit_sha}`
      : null,
  };
}

const appFilter = (params: ListParams) => typeof params.filter.app === "string" ? params.filter.app : null;

adminApi.get("/releases", async (c) => {
  const params = listParams(c);
  const app = appFilter(params);
  const github = await githubBase();
  const rows = (await many<Record<string, unknown>>(`${RELEASES_SQL} and ($1::text is null or a.slug = $1)`, [app]))
    .map((r) => decorateRelease(r, github));
  const { rows: result, total } = listInMemory(rows, params, {
    app: () => true,
    q: (r, q) => includes(r.commit_sha, q) || includes(r.github_actor, q) || includes(r.created_by, q) || includes(r.app, q),
  }, { field: "started_at", order: "DESC" });
  return page(c, "releases", result, total, params.range);
});

adminApi.get("/releases/:id", async (c) => {
  const id = c.req.param("id");
  if (!z.uuid().safeParse(id).success) throw new HttpError(404, "release not found");
  const row = await one<Record<string, unknown>>(`${RELEASES_SQL} and r.id = $1`, [id]);
  if (!row) throw new HttpError(404, "release not found");
  return c.json(decorateRelease(row, await githubBase()));
});

const DEPLOYMENTS_SQL = `
  select d.id, a.slug as app, d.kind, d.version, d.status, d.status = 'live' as live, d.release_id,
    u.email as created_by, d.created_at, d.finalized_at, d.error, d.manifest->'accepted_lints' as accepted_lints,
    d.kind <> 'migrations' and d.status = 'ready' as rollbackable
  from deployments d join apps a on a.id = d.app_id left join users u on u.id = d.created_by
  where a.status <> 'deleted'`;

adminApi.get("/deployments", async (c) => {
  const params = listParams(c);
  const rows = await many<Record<string, unknown>>(`${DEPLOYMENTS_SQL} and ($1::text is null or a.slug = $1)`, [
    appFilter(params),
  ]);
  const { rows: result, total } = listInMemory(rows, params, { app: () => true }, { field: "created_at", order: "DESC" });
  return page(c, "deployments", result, total, params.range);
});

// ---------------------------------------------------------------------------------------------------------------
// secrets (names only) and schema changes, per app

adminApi.get("/secrets", async (c) => {
  const params = listParams(c);
  const rows = await many<Record<string, unknown>>(
    `select a.slug || ':' || s.name as id, a.slug as app, s.name, s.updated_at
       from app_secrets s join apps a on a.id = s.app_id
      where a.status <> 'deleted' and ($1::text is null or a.slug = $1)`,
    [appFilter(params)],
  );
  const { rows: result, total } = listInMemory(rows, params, { app: () => true }, { field: "name", order: "ASC" });
  return page(c, "secrets", result, total, params.range);
});

adminApi.get("/schema_changes", async (c) => {
  const params = listParams(c);
  const slug = appFilter(params);
  if (!slug) throw new HttpError(400, 'schema_changes needs filter={"app":"<slug>"}');
  const app = await appRow(slug);
  const { changes } = await listSchemaChanges(app, { all: truthy(params.filter.all), limit: 1000 });
  const rows = changes.map((change, i) => ({ id: `${slug}:${changes.length - i}`, app: slug, ...change }));
  const { rows: result, total } = listInMemory(rows, params, { app: () => true, all: () => true });
  return page(c, "schema_changes", result, total, params.range);
});

// ---------------------------------------------------------------------------------------------------------------
// audit_log (paginated in SQL: it grows without bound)

const AUDIT_SORT: Record<string, string> = {
  id: "l.id",
  created_at: "l.created_at",
  action: "l.action",
  user_email: "u.email",
  app: "coalesce(a.slug, l.details->>'slug')",
};

adminApi.get("/audit_log", async (c) => {
  const params = listParams(c);
  const f = params.filter;
  const where: string[] = [];
  const values: unknown[] = [];
  const add = (sql: (n: string) => string, value: unknown) => {
    values.push(value);
    where.push(sql(`$${values.length}`));
  };
  if (Array.isArray(f.id)) add((n) => `l.id = any(${n}::bigint[])`, f.id.map(Number).filter(Number.isFinite));
  if (typeof f.app === "string" && f.app) add((n) => `(a.slug = ${n} or l.details->>'slug' = ${n})`, f.app);
  if (typeof f.user_id === "string" && f.user_id) add((n) => `l.user_id::text = ${n}`, f.user_id);
  if (typeof f.action === "string" && f.action) add((n) => `l.action = ${n}`, f.action);
  if (Array.isArray(f.action)) add((n) => `l.action = any(${n}::text[])`, f.action.map(String));
  if (typeof f.q === "string" && f.q) {
    add((n) => `(l.action ilike ${n} or u.email ilike ${n} or l.details::text ilike ${n})`, `%${f.q}%`);
  }
  if (typeof f.created_at_gte === "string" && f.created_at_gte) add((n) => `l.created_at >= ${n}::timestamptz`, f.created_at_gte);
  if (typeof f.created_at_lte === "string" && f.created_at_lte) add((n) => `l.created_at <= ${n}::timestamptz`, f.created_at_lte);
  const sort = params.sort && AUDIT_SORT[params.sort.field] ? params.sort : { field: "id", order: "DESC" as const };
  const [start, end] = params.range;
  const { rows } = await platform.query<Record<string, unknown> & { total: number }>(
    `select l.id::text as id, l.created_at, l.action, l.user_id, u.email as user_email, l.app_id,
        coalesce(a.slug, l.details->>'slug') as app, l.details, count(*) over ()::int as total
       from audit_log l left join users u on u.id = l.user_id left join apps a on a.id = l.app_id
      ${where.length ? `where ${where.join(" and ")}` : ""}
      order by ${AUDIT_SORT[sort.field]} ${sort.order}, l.id desc
      offset ${start} limit ${end - start + 1}`,
    values,
  );
  const total = rows[0]?.total ?? (start === 0 ? 0 : (await one<{ n: number }>(
    `select count(*)::int as n from audit_log l left join users u on u.id = l.user_id left join apps a on a.id = l.app_id
      ${where.length ? `where ${where.join(" and ")}` : ""}`,
    values,
  ))!.n);
  return page(c, "audit_log", rows.map(({ total: _, ...row }) => row), total, params.range);
});

adminApi.get("/audit_log/:id", async (c) => {
  const id = c.req.param("id");
  if (!/^\d{1,18}$/.test(id)) throw new HttpError(404, "audit entry not found");
  const row = await one(
    `select l.id::text as id, l.created_at, l.action, l.user_id, u.email as user_email, l.app_id,
        coalesce(a.slug, l.details->>'slug') as app, l.details
       from audit_log l left join users u on u.id = l.user_id left join apps a on a.id = l.app_id where l.id = $1`,
    [id],
  );
  if (!row) throw new HttpError(404, "audit entry not found");
  return c.json(row);
});

// ---------------------------------------------------------------------------------------------------------------
// company SSO (M6 part 2, A7): the OIDC provider of the platform's logins and of the apps' "custom:company" provider

async function ssoRecord() {
  const { sso } = await getSettings();
  const apps = await one<{ n: number }>(
    `select count(*)::int as n from app_auth_config c join apps a on a.id = c.app_id
      where c.sso_provider = 'company' and a.status <> 'deleted'`,
  );
  return {
    ...ssoSummary(sso),
    /** Redirect URIs to register at the IdP for the platform's client. */
    redirect_uris: { studio: ssoCallbackUrl("studio"), admin: ssoCallbackUrl("admin"), apps: `${appUrl("<app>")}/auth/v1/callback` },
    apps_using_sso: apps?.n ?? 0,
  };
}

// Platform settings, read-only: what is in effect (secrets left out) and which values set-setting put over the
// environment. They are changed with the CLI (audited set_setting / unset_setting), the SSO ones on the SSO screen.
adminApi.get("/settings", async (c) =>
  c.json({ effective: settingsSummary(await getSettings()), overrides: await settingOverrides() }));

adminApi.get("/sso", async (c) => c.json(await ssoRecord()));

const ssoInput = z.object({
  enabled: z.boolean().optional(),
  name: z.string().trim().min(1).max(60).optional(),
  issuer: z.string().trim().max(500).optional(),
  /** empty or null: <issuer>/.well-known/openid-configuration */
  discovery_url: z.string().trim().max(500).nullish(),
  client_id: z.string().trim().max(500).optional(),
  /** empty or absent: unchanged (it is never returned) */
  client_secret: z.string().max(2000).nullish(),
  allowed_domains: z.array(z.string().trim().max(253)).max(50).optional(),
  require_verified_email: z.boolean().optional(),
  auto_create: z.enum(["off", "developer"]).optional(),
  password_login: z.enum(["everyone", "admins"]).optional(),
});

adminApi.put("/sso", async (c) => {
  const admin = c.get("admin");
  const input = await body(c, ssoInput);
  // new values of the settings rows; null: back to the environment's default
  const rows: Record<string, string | null> = {};
  if (input.enabled !== undefined) rows.sso_enabled = String(input.enabled);
  if (input.name !== undefined) rows.sso_name = input.name;
  if (input.issuer !== undefined) rows.sso_issuer = input.issuer;
  if (input.discovery_url !== undefined) rows.sso_discovery_url = input.discovery_url || null;
  if (input.client_id !== undefined) rows.sso_client_id = input.client_id;
  if (input.client_secret) rows.sso_client_secret = input.client_secret;
  if (input.allowed_domains !== undefined) rows.sso_allowed_domains = input.allowed_domains.join(",");
  if (input.require_verified_email !== undefined) rows.sso_require_verified_email = String(input.require_verified_email);
  if (input.auto_create !== undefined) rows.sso_auto_create = input.auto_create;
  if (input.password_login !== undefined) rows.sso_password_login = input.password_login;
  for (const [key, value] of Object.entries(rows)) {
    try {
      if (value !== null) validateSetting(key, value);
    } catch (error) {
      throw new HttpError(400, (error as Error).message);
    }
  }
  // write, then check the result: an active configuration must answer with a matching discovery document, otherwise
  // the previous rows are put back
  const saved = await many<{ key: string; value: string }>("select key, value from settings where key like 'sso\\_%'");
  const changed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rows)) {
    if (value === null) await unsetSetting(key);
    else await setSetting(key, value);
    changed[key] = key === "sso_client_secret" ? "(changed)" : value;
  }
  const { sso: next } = await getSettings();
  let refusal: string | null = null;
  if (next.enabled && !next.configured) refusal = "to enable SSO, set the issuer, the client id and the client secret";
  else if (next.enabled) {
    await discover(next, { fresh: true }).catch((error) => {
      if (!(error instanceof SsoError)) throw error;
      refusal = error.message;
    });
  }
  if (refusal) {
    await transaction(async (tx) => {
      await tx.query("delete from settings where key like 'sso\\_%'");
      for (const row of saved) await tx.query("insert into settings (key, value) values ($1, $2)", [row.key, row.value]);
    });
    throw new HttpError(400, refusal);
  }
  await audit(admin.id, null, "update_sso", { changes: changed });
  // the apps' "custom:company" provider follows the provider settings (removed when SSO is turned off)
  const appsSync = Object.keys(rows).some((key) => SSO_PROVIDER_KEYS.includes(key) || key === "sso_discovery_url")
    ? await syncCompanySso()
    : null;
  return c.json({ ...(await ssoRecord()), apps_sync: appsSync });
});

// ---------------------------------------------------------------------------------------------------------------
// dashboard

adminApi.get("/dashboard", async (c) => {
  const [apps, users, tokens, cluster, failures, flagged] = await Promise.all([
    many<{ status: string; count: number }>(
      "select status, count(*)::int as count from apps where status <> 'deleted' group by status order by status",
    ),
    one<{ total: number; admins: number; developers: number; disabled: number }>(
      `select count(*)::int as total, count(*) filter (where role = 'admin')::int as admins,
          count(*) filter (where role = 'developer')::int as developers, count(*) filter (where not active)::int as disabled
         from users`,
    ),
    one<{ active: number }>(
      "select count(*)::int as active from tokens where revoked_at is null and (expires_at is null or expires_at > now())",
    ),
    one<{ size: string; app_databases: string }>(
      `select sum(pg_database_size(datname))::text as size,
          coalesce(sum(pg_database_size(datname)) filter (where datname like 'app\\_%'), 0)::text as app_databases
         from pg_database`,
    ),
    many<{ at: Date; app: string; kind: string; message: string | null }>(
      `select * from (
         select coalesce(r.finished_at, r.started_at) as at, a.slug as app, 'release' as kind,
           concat_ws(' ', r.source, left(r.commit_sha, 7), r.error) as message
           from releases r join apps a on a.id = r.app_id where r.status = 'failed'
         union all
         select d.created_at, a.slug, 'deployment ' || d.kind, d.error
           from deployments d join apps a on a.id = d.app_id where d.status = 'failed'
         union all
         select a.updated_at, a.slug, 'app error', a.error from apps a where a.status = 'error'
         union all
         select coalesce(b.finished_at, b.started_at), b.slug, 'backup ' || b.kind, b.error
           from backups b where b.status = 'failed'
       ) f where at > now() - interval '7 days' order by at desc limit 10`,
    ),
    one<{ outside_ci: number; accepted_lints: number }>(
      `select count(*) filter (where lr.source = 'direct')::int as outside_ci,
          count(*) filter (where exists (select 1 from deployments d where d.app_id = a.id and d.kind = 'migrations'
            and jsonb_typeof(d.manifest->'accepted_lints') = 'array'
            and jsonb_array_length(d.manifest->'accepted_lints') > 0))::int as accepted_lints
         from apps a left join lateral (select r.source from releases r where r.app_id = a.id
           order by r.started_at desc limit 1) lr on true
        where a.status <> 'deleted'`,
    ),
  ]);
  const disk = await statfs(config.dataDir.sites).catch(() => null);
  // load of every app (app_metrics): totals and the 7-day series summed over the apps
  const records = await appRecords();
  const days = new Map<string, { day: string; requests: number; errors: number }>();
  for (const app of records) {
    for (const d of app.traffic_7d ?? []) {
      const day = days.get(d.day) ?? { day: d.day, requests: 0, errors: 0 };
      day.requests += d.requests;
      day.errors += d.errors;
      days.set(d.day, day);
    }
  }
  const sampled = await one<{ sampled_at: Date | null }>("select sampled_at from metrics_state where id = 1");
  const linted = records.filter((a) => a.lint);
  return c.json({
    version: await platformVersion(),
    apps: { total: apps.reduce((n, a) => n + a.count, 0), by_status: Object.fromEntries(apps.map((a) => [a.status, a.count])) },
    // security linter (PLAN_1 §8): apps whose latest run has ERROR lints not accepted by a migration, or warnings
    lints: {
      apps_with_errors: records.filter((a) => a.flags.lint_errors > 0)
        .map((a) => ({ app: a.slug, errors: a.flags.lint_errors, ran_at: a.lint?.ran_at ?? null })),
      apps_with_warnings: linted.filter((a) => (a.lint?.warnings ?? 0) > 0).length,
      apps_linted: linted.length,
      failed_runs: linted.filter((a) => a.lint?.failed).map((a) => a.slug),
    },
    users,
    tokens,
    flagged: { ...flagged, abandoned: records.filter((a) => a.flags.abandoned).length },
    load: {
      requests_24h: records.reduce((n, a) => n + a.requests_24h, 0),
      errors_24h: records.reduce((n, a) => n + a.errors_24h, 0),
      /** GoTrue and PostgREST containers of every app (the shared edge runtime is not included) */
      memory: records.reduce((n, a) => n + (a.memory ?? 0), 0),
      traffic_7d: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)),
      sampled_at: sampled?.sampled_at ?? null,
    },
    recent_failures: failures,
    backups: await backupStatus(),
    database: { cluster_bytes: Number(cluster?.size ?? 0), app_databases_bytes: Number(cluster?.app_databases ?? 0) },
    // as seen from the control plane container: the host's memory and CPUs, the disk of the Docker volumes
    host: {
      memory_total: totalmem(),
      memory_free: freemem(),
      cpus: cpus().length,
      load: loadavg(),
      uptime_seconds: Math.round(uptime()),
      disk: disk ? { total: disk.blocks * disk.bsize, free: disk.bavail * disk.bsize } : null,
    },
  });
});
