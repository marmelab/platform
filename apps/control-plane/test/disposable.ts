// Disposable apps and users for the e2e suites: unique names per run, deleted (and checked) at the end of the run.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appRoles } from "@platform/sql";

/** Short, unique per run, valid inside a slug: `e2e-${runId()}`. */
export const runId = () => `${Date.now().toString(36).slice(-5)}${randomBytes(2).toString("hex")}`;

/** E2E_KEEP=1 keeps the run's apps for inspection (test users are always deleted). */
export const KEEP = process.env.E2E_KEEP === "1";

export const cli = (args: string[], input?: string) =>
  execFileSync("docker", ["exec", "-i", "plat-control-plane", "node", "src/cli.ts", ...args], { input, encoding: "utf8" });

export const psql = (sql: string, database = "platform") =>
  execFileSync("docker", ["exec", "plat-db", "psql", "-U", "supabase_admin", "-d", database, "-tAc", sql], {
    encoding: "utf8",
  }).trim();

const CADDY_ADMIN = "http://127.0.0.1:2030";
const list = (values: string[]) => values.map((v) => `'${v.replaceAll("'", "''")}'`).join(", ") || "null";

/** Deletes the run's apps and users, then checks that nothing is left behind. */
export async function cleanup(apps: string[], users: string[]) {
  const errors: unknown[] = [];
  const attempt = (fn: () => unknown) => {
    try {
      fn();
    } catch (error) {
      errors.push(error);
    }
  };
  const existing = psql(`select id || ' ' || email from users where email in (${list(users)})`)
    .split("\n").filter(Boolean).map((line) => line.split(" ") as [string, string]);
  const userIds = list(existing.map(([id]) => id));
  for (const [, email] of existing) attempt(() => cli(["delete-user", email]));
  if (KEEP) {
    console.log(`E2E_KEEP=1: kept ${apps.join(", ")}`);
  } else {
    for (const slug of apps) attempt(() => cli(["delete-app", slug]));
  }
  if (errors.length > 0) throw new AggregateError(errors, "cleanup failed");

  const left = psql(`select concat_ws(' ',
    (select string_agg('app:' || slug, ' ') from apps where slug in (${list(KEEP ? [] : apps)})),
    (select string_agg('user:' || email, ' ') from users where email in (${list(users)})),
    (select string_agg('session', ' ') from sessions where user_id::text in (${userIds})),
    (select string_agg('token', ' ') from tokens where user_id::text in (${userIds})),
    (select string_agg('member', ' ') from app_members where user_id::text in (${userIds})))`);
  assert.equal(left, "", "platform rows left behind");
  if (KEEP) return;
  for (const slug of apps) {
    const roles = appRoles(slug.replace(/-/g, "_"));
    const containers = execFileSync("docker", ["ps", "-aq", "--filter", `label=platform.app=${slug}`], { encoding: "utf8" });
    assert.equal(containers.trim(), "", `containers left for ${slug}`);
    for (const id of [`app-${slug}`, `app-${slug}-internal`]) {
      assert.equal((await fetch(`${CADDY_ADMIN}/id/${id}`, { headers: { origin: CADDY_ADMIN } })).status, 404, `Caddy route ${id} left`);
    }
    assert.equal(psql(`select count(*) from pg_database where datname = '${roles.database}'`), "0", `${roles.database} left`);
    assert.equal(
      psql(`select count(*) from pg_roles where rolname in (${list([roles.owner, roles.authenticator, roles.authAdmin])})`),
      "0",
      `roles of ${slug} left`,
    );
  }
}
