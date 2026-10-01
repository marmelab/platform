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

export function dropAppSql(appId: string): string[] {
  const r = appRoles(appId);
  return [
    `drop database if exists ${r.database} with (force)`,
    `drop role if exists ${r.authenticator}`,
    `drop role if exists ${r.authAdmin}`,
    `drop role if exists ${r.owner}`,
  ];
}
