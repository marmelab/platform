import { readFileSync } from "node:fs";

const sqlFile = (name: string) => readFileSync(new URL(`../${name}`, import.meta.url), "utf8");

export const bootstrapSql = () => sqlFile("bootstrap.sql");
export const templateSql = () => sqlFile("template.sql");
export const platformSql = () => sqlFile("platform.sql");
export const lintsSql = () => sqlFile("lints.sql");

export const TEMPLATE_DB = "template_supabase";

const IDENT_RE = /^[a-z][a-z0-9_]{0,62}$/;
const SECRET_RE = /^[A-Za-z0-9_-]{16,128}$/;

function ident(value: string): string {
  if (!IDENT_RE.test(value)) throw new Error(`unsafe identifier: ${value}`);
  return value;
}

function secret(value: string): string {
  if (!SECRET_RE.test(value)) throw new Error("unsafe password");
  return `'${value}'`;
}

export interface AppRoles {
  database: string;
  authenticator: string;
  authAdmin: string;
  owner: string;
}

export function appRoles(appId: string): AppRoles {
  const id = ident(appId);
  return {
    database: `app_${id}`,
    authenticator: `app_${id}_authenticator`,
    authAdmin: `app_${id}_auth_admin`,
    owner: `app_${id}_owner`,
  };
}

export interface AppPasswords {
  authenticator: string;
  authAdmin: string;
  owner: string;
}

const ensureRole = (role: string) =>
  `do $$ begin if not exists (select from pg_roles where rolname = '${role}') then create role ${role}; end if; end $$`;

/** Cluster-level statements (run in the "postgres" database as supabase_admin), before CREATE DATABASE. */
export function clusterRolesSql(appId: string, passwords: AppPasswords): string[] {
  const r = appRoles(appId);
  return [
    ensureRole(r.authenticator),
    ensureRole(r.authAdmin),
    ensureRole(r.owner),
    // PostgREST login role: same shape as the image's "authenticator"
    `alter role ${r.authenticator} with login noinherit nocreaterole nocreatedb connection limit 20 password ${secret(passwords.authenticator)}`,
    `grant anon, authenticated, service_role to ${r.authenticator}`,
    `alter role ${r.authenticator} set session_preload_libraries = supautils, safeupdate`,
    `alter role ${r.authenticator} set statement_timeout = '8s'`,
    `alter role ${r.authenticator} set lock_timeout = '8s'`,
    // GoTrue login role: same shape as "supabase_auth_admin" but without createrole
    `alter role ${r.authAdmin} with login noinherit nocreaterole nocreatedb connection limit 20 password ${secret(passwords.authAdmin)}`,
    `alter role ${r.authAdmin} set search_path = auth`,
    `alter role ${r.authAdmin} set idle_in_transaction_session_timeout = 60000`,
    `alter role ${r.authAdmin} set log_statement = none`,
    // Owner role: owns the database and the public schema; used for migrations, execute_sql and edge functions
    `alter role ${r.owner} with login inherit nocreaterole nocreatedb connection limit 15 password ${secret(passwords.owner)}`,
    `alter role ${r.owner} set statement_timeout = '60s'`,
  ];
}

export const databaseExistsSql = "select 1 from pg_database where datname = $1";

export function createDatabaseSql(appId: string): string {
  const r = appRoles(appId);
  return `create database ${r.database} template ${TEMPLATE_DB} owner ${r.owner}`;
}

export function databaseGrantsSql(appId: string): string[] {
  const r = appRoles(appId);
  return [
    `alter database ${r.database} owner to ${r.owner}`,
    `revoke all on database ${r.database} from public`,
    `grant connect, temporary on database ${r.database} to ${r.authenticator}`,
    `grant connect on database ${r.database} to ${r.authAdmin}`,
    `grant all on database ${r.database} to ${r.owner}`,
  ];
}

/** Statements run inside the app database as supabase_admin. Re-runnable. */
export function appDatabaseSql(appId: string): string[] {
  const r = appRoles(appId);
  const apiRoles = "anon, authenticated, service_role";
  return [
    // auth.* comes from the template owned by the global supabase_auth_admin: GoTrue must own it.
    `reassign owned by supabase_auth_admin to ${r.authAdmin}`,
    `drop owned by supabase_auth_admin`,
    `drop owned by supabase_storage_admin`,
    `grant usage, create on schema auth to ${r.authAdmin}`,
    // the owner role replaces "postgres" for application DDL
    `alter schema public owner to ${r.owner}`,
    `alter schema supabase_migrations owner to ${r.owner}`,
    `alter table supabase_migrations.schema_migrations owner to ${r.owner}`,
    `grant usage on schema auth, extensions to ${r.owner}`,
    `grant select, references on auth.users to ${r.owner}`,
    `grant execute on all functions in schema auth to ${r.owner}`,
    `alter default privileges for role ${r.owner} in schema public grant all on tables to ${apiRoles}`,
    `alter default privileges for role ${r.owner} in schema public grant all on sequences to ${apiRoles}`,
    `alter default privileges for role ${r.owner} in schema public grant all on functions to ${apiRoles}`,
  ];
}

/**
 * B8: a stopped app's database is read-only by default for every new session (run in "postgres"). A guardrail, not
 * a security boundary: any session may still opt out with SET or BEGIN READ WRITE (TECH_DEBT CP-9).
 */
export function databaseReadOnlySql(appId: string, readOnly: boolean): string {
  const r = appRoles(appId);
  return readOnly
    ? `alter database ${r.database} set default_transaction_read_only = on`
    : `alter database ${r.database} reset default_transaction_read_only`;
}

/** Whether databaseReadOnlySql(appId, true) is in effect. Parameter: the database name. */
export const databaseIsReadOnlySql = `select 1 from pg_db_role_setting s join pg_database d on d.oid = s.setdatabase
  where d.datname = $1 and s.setrole = 0 and 'default_transaction_read_only=on' = any(s.setconfig)`;

/**
 * Terminates the sessions of the app's own roles in its database (Studio's pg-meta, GoTrue, PostgREST, edge
 * functions), so that the database-level settings apply to their next session. The platform's admin sessions stay.
 * Parameters: the database name and the role names.
 */
export const terminateAppSessionsSql = `select count(pg_terminate_backend(pid))::int as terminated from pg_stat_activity
  where datname = $1 and usename = any($2::text[]) and pid <> pg_backend_pid()`;

export function dropAppSql(appId: string): string[] {
  const r = appRoles(appId);
  return [
    `drop database if exists ${r.database} with (force)`,
    `drop role if exists ${r.authenticator}`,
    `drop role if exists ${r.authAdmin}`,
    `drop role if exists ${r.owner}`,
  ];
}

/**
 * auth.* tables Studio reads in SQL (pg-meta: Auth > Users list, user detail and count). Every other auth table stays
 * out of reach: user writes go through GoTrue's admin API with the service key.
 */
export const STUDIO_AUTH_TABLES = ["users", "identities"] as const;

export const STUDIO_AUTH_POLICY = "platform_owner_read";

/**
 * Studio connects as the owner role (SQL editor, table editor, Auth > Users). Unlike Supabase's "postgres" it does not
 * bypass RLS: it reads STUDIO_AUTH_TABLES through a dedicated policy (see studioDatabaseSql). It gets the RLS roles for
 * impersonation (SET ROLE, without inheriting their privileges). Cluster-level, run in "postgres".
 */
export function studioClusterSql(appId: string): string[] {
  const r = appRoles(appId);
  return [
    `alter role ${r.owner} nobypassrls`,
    `grant anon, authenticated, service_role to ${r.owner} with inherit false, set true`,
  ];
}

/**
 * Run inside the app database as supabase_admin, once GoTrue has migrated auth.*. Re-runnable: it also repairs the
 * policies if a GoTrue migration recreated a table. Tables that do not exist yet are skipped.
 */
export function studioDatabaseSql(appId: string): string[] {
  const r = appRoles(appId);
  const tables = STUDIO_AUTH_TABLES.map((t) => `'${t}'`).join(", ");
  return [
    `grant usage on schema graphql, graphql_public to ${r.owner}`,
    `revoke select on all tables in schema auth from ${r.owner}`,
    `alter default privileges for role ${r.authAdmin} in schema auth revoke select on tables from ${r.owner}`,
    `grant trigger on auth.users to ${r.owner}`,
    `do $$
declare t text;
begin
  foreach t in array array[${tables}] loop
    if to_regclass(format('auth.%I', t)) is null then continue; end if;
    execute format('grant select on auth.%I to ${r.owner}', t);
    if not (select relrowsecurity from pg_class where oid = format('auth.%I', t)::regclass) then
      execute format('alter table auth.%I enable row level security', t);
    end if;
    if not exists (select from pg_policies where schemaname = 'auth' and tablename = t and policyname = '${STUDIO_AUTH_POLICY}') then
      execute format('create policy ${STUDIO_AUTH_POLICY} on auth.%I for select to ${r.owner} using (true)', t);
    end if;
  end loop;
end $$`,
  ];
}

export const STUDIO_META_DEFAULT = "studio_meta_default";

/**
 * Default connection of the shared postgres-meta (used when a request carries no x-connection-encrypted header):
 * an empty database and a role without any privilege, so that a request without a project reaches nothing.
 */
export function studioMetaDefaultRoleSql(password: string): string[] {
  const role = STUDIO_META_DEFAULT;
  return [
    ensureRole(role),
    `alter role ${role} with login noinherit nocreaterole nocreatedb nobypassrls connection limit 5 password ${secret(password)}`,
  ];
}

export function studioMetaDefaultDatabaseSql(): string[] {
  const db = STUDIO_META_DEFAULT;
  return [`revoke all on database ${db} from public`, `grant connect on database ${db} to ${db}`];
}
