import { createHash, createHmac, pbkdf2Sync } from "node:crypto";
import { readFileSync } from "node:fs";

const sqlFile = (name: string) => readFileSync(new URL(`../${name}`, import.meta.url), "utf8");

export const bootstrapSql = () => sqlFile("bootstrap.sql");
export const templateSql = () => sqlFile("template.sql");
export const platformSql = () => sqlFile("platform.sql");
export const lintsSql = () => sqlFile("lints.sql");
/** Storage rules of the linter: run only when storage.buckets exists. */
export const storageLintsSql = () => sqlFile("lints_storage.sql");
/** DDL event trigger and `_platform.schema_changes` (PLAN_1 §7). Idempotent, run as supabase_admin. */
export const schemaChangesSql = () => sqlFile("schema_changes.sql");

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

/**
 * The SCRAM-SHA-256 secret of a role's password, with a salt derived from the role and the password: setting it
 * again (every provisioning re-runs the role statements) leaves pg_authid unchanged. A plain `PASSWORD '...'` would
 * draw a new salt each time, which invalidates the SCRAM keys the pooler caches from its connected clients
 * (pass-through authentication): their next server login would fail until they reconnect.
 */
export function scramSecret(role: string, password: string): string {
  if (!SECRET_RE.test(password)) throw new Error("unsafe password");
  const iterations = 4096;
  const salt = createHash("sha256").update(`platform-scram:${role}:${password}`).digest().subarray(0, 16);
  const salted = pbkdf2Sync(password, salt, iterations, 32, "sha256");
  const clientKey = createHmac("sha256", salted).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest();
  const serverKey = createHmac("sha256", salted).update("Server Key").digest();
  const b64 = (b: Buffer) => b.toString("base64");
  return `'SCRAM-SHA-256$${iterations}:${b64(salt)}$${b64(storedKey)}:${b64(serverKey)}'`;
}

export interface AppRoles {
  database: string;
  authenticator: string;
  authAdmin: string;
  owner: string;
  /** Storage API (M5): owns storage.*, member of the API roles (Storage SET ROLEs to the JWT's role). */
  storageAdmin: string;
  /** Realtime (M5): logical replication of the app database, member of the API roles (RLS checks). */
  realtime: string;
}

export function appRoles(appId: string): AppRoles {
  const id = ident(appId);
  return {
    database: `app_${id}`,
    authenticator: `app_${id}_authenticator`,
    authAdmin: `app_${id}_auth_admin`,
    owner: `app_${id}_owner`,
    storageAdmin: `app_${id}_storage_admin`,
    realtime: `app_${id}_realtime`,
  };
}

/** Login roles of an app, all of them (sessions to terminate, roles to drop). */
export const appLoginRoles = (r: AppRoles) => [r.owner, r.authenticator, r.authAdmin, r.storageAdmin, r.realtime];

export interface AppPasswords {
  authenticator: string;
  authAdmin: string;
  owner: string;
  storageAdmin: string;
  realtime: string;
}

/**
 * Global NOLOGIN role that owns the realtime.* objects of every app database once Realtime's tenant migrations ran
 * (they create and GRANT it; reserved by supautils: created by the control plane at init). Each app's realtime role is
 * a member, and can only use it in the one database it may connect to.
 */
export const REALTIME_ADMIN_ROLE = "supabase_realtime_admin";

/**
 * Realtime's tenant migrations must run as a superuser (they GRANT the reserved supabase_realtime_admin role). This
 * role is given LOGIN and a one-time password only while the control plane registers a tenant, then locked again.
 */
export const REALTIME_MIGRATOR_ROLE = "platform_realtime_migrator";

export function realtimeAdminRoleSql(): string[] {
  return [
    `do $$ begin if not exists (select from pg_roles where rolname = '${REALTIME_ADMIN_ROLE}') then
       create role ${REALTIME_ADMIN_ROLE} noinherit nologin noreplication; end if; end $$`,
    ensureRole(REALTIME_MIGRATOR_ROLE),
    `alter role ${REALTIME_MIGRATOR_ROLE} with nologin superuser password null`,
  ];
}

/** Opens (password) or locks (null) the realtime migrator role. Run as supabase_admin. */
export function realtimeMigratorSql(password: string | null): string[] {
  return password === null
    ? [
      `alter role ${REALTIME_MIGRATOR_ROLE} with nologin password null`,
      `select pg_terminate_backend(pid) from pg_stat_activity where usename = '${REALTIME_MIGRATOR_ROLE}'`,
    ]
    : [`alter role ${REALTIME_MIGRATOR_ROLE} with login superuser connection limit 10 password ${secret(password)}`];
}

/**
 * Connection pooler (PgBouncer, apps/control-plane/README.md, "Connection pooler"). Clients log in with their own role and password: PgBouncer
 * reads the role's SCRAM secret with `auth_query` (POOLER_AUTH_FUNCTION, in the "postgres" database, as
 * POOLER_AUTH_ROLE) and reuses the client's SCRAM keys to log in to Postgres. Only the app roles routed through the
 * pooler are returned: any other role (superusers, the platform's roles, owners) cannot log in through it.
 */
export const POOLER_AUTH_ROLE = "platform_pooler";
export const POOLER_AUTH_FUNCTION = "platform_pooler.get_auth";
/** App login roles that connect through the pooler: PostgREST's and Storage's. */
export const POOLED_ROLE_RE = "^app_[a-z0-9_]+_(authenticator|storage_admin)$";

/** Run in "postgres" as supabase_admin. Idempotent. */
export function poolerAuthSql(password: string): string[] {
  return [
    ensureRole(POOLER_AUTH_ROLE),
    `alter role ${POOLER_AUTH_ROLE} with login noinherit nosuperuser nocreatedb nocreaterole noreplication connection limit 5 password ${secret(password)}`,
    `grant connect on database postgres to ${POOLER_AUTH_ROLE}`,
    `create schema if not exists platform_pooler`,
    `revoke all on schema platform_pooler from public`,
    `grant usage on schema platform_pooler to ${POOLER_AUTH_ROLE}`,
    `create or replace function ${POOLER_AUTH_FUNCTION}(p_usename text) returns table (usename name, passwd text)
      language sql stable security definer set search_path = pg_catalog as $$
        select rolname, rolpassword from pg_authid
         where rolname = p_usename and rolname ~ '${POOLED_ROLE_RE}' and rolcanlogin and not rolsuper
           and not rolreplication and (rolvaliduntil is null or rolvaliduntil > now())
      $$`,
    `revoke all on function ${POOLER_AUTH_FUNCTION}(text) from public`,
    `grant execute on function ${POOLER_AUTH_FUNCTION}(text) to ${POOLER_AUTH_ROLE}`,
  ];
}

/**
 * PostgREST connects through the pooler in transaction mode, where LISTEN does not work: its schema cache channel is
 * off, and the control plane listens to "pgrst" in each running app database instead (pgrst-relay.ts), as this role:
 * LOGIN and CONNECT on the app databases, nothing else.
 */
export const PGRST_RELAY_ROLE = "platform_pgrst_relay";

/** Run in "postgres" as supabase_admin. Idempotent. */
export function pgrstRelayRoleSql(password: string): string[] {
  return [
    ensureRole(PGRST_RELAY_ROLE),
    `alter role ${PGRST_RELAY_ROLE} with login noinherit nosuperuser nocreatedb nocreaterole noreplication connection limit 200 password ${secret(password)}`,
  ];
}

/** Metadata database and role of a shared service (Storage's tenants, Realtime's tenants). Run in "postgres". */
export function serviceDatabaseRoleSql(role: string, password: string): string[] {
  return [
    ensureRole(ident(role)),
    `alter role ${role} with login nosuperuser nocreatedb nocreaterole noreplication connection limit 30 password ${secret(password)}`,
  ];
}

/** GoTrue of the platform's own accounts (OAuth for Claude Code, platform-auth.ts): its login role. */
export const PLATFORM_AUTH_ROLE = "platform_auth_admin";

/**
 * Role and `auth` schema of the platform's GoTrue, in the platform database (run there as supabase_admin). GoTrue owns
 * the schema and creates its tables with its own migrations, as an app's GoTrue does. Idempotent.
 */
export function platformAuthSql(database: string, password: string): string[] {
  const r = PLATFORM_AUTH_ROLE;
  return [
    ensureRole(r),
    `alter role ${r} with login noinherit nosuperuser nocreatedb nocreaterole noreplication connection limit 20 password ${secret(password)}`,
    `alter role ${r} set search_path = auth`,
    `alter role ${r} set idle_in_transaction_session_timeout = 60000`,
    `alter role ${r} set log_statement = none`,
    `grant connect on database ${ident(database)} to ${r}`,
    `create schema if not exists auth authorization ${r}`,
  ];
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
    `alter role ${r.authenticator} with login noinherit nocreaterole nocreatedb connection limit 20 password ${scramSecret(r.authenticator, passwords.authenticator)}`,
    `grant anon, authenticated, service_role to ${r.authenticator}`,
    `alter role ${r.authenticator} set session_preload_libraries = supautils, safeupdate`,
    `alter role ${r.authenticator} set statement_timeout = '8s'`,
    `alter role ${r.authenticator} set lock_timeout = '8s'`,
    // GoTrue login role: same shape as "supabase_auth_admin" but without createrole
    `alter role ${r.authAdmin} with login noinherit nocreaterole nocreatedb connection limit 20 password ${scramSecret(r.authAdmin, passwords.authAdmin)}`,
    `alter role ${r.authAdmin} set search_path = auth`,
    `alter role ${r.authAdmin} set idle_in_transaction_session_timeout = 60000`,
    `alter role ${r.authAdmin} set log_statement = none`,
    // Owner role: owns the database and the public schema; used for migrations, execute_sql and edge functions
    `alter role ${r.owner} with login inherit nocreaterole nocreatedb connection limit 15 password ${scramSecret(r.owner, passwords.owner)}`,
    `alter role ${r.owner} set statement_timeout = '60s'`,
    // Storage API: same shape as the image's supabase_storage_admin, without createrole
    ensureRole(r.storageAdmin),
    `alter role ${r.storageAdmin} with login noinherit nocreaterole nocreatedb connection limit 10 password ${scramSecret(r.storageAdmin, passwords.storageAdmin)}`,
    `grant anon, authenticated, service_role to ${r.storageAdmin}`,
    `alter role ${r.storageAdmin} set search_path = storage`,
    // Realtime: REPLICATION for the logical decoding of its own database only (CONNECT is per database, and pg_hba
    // has no "replication" line: no physical streaming of the cluster)
    ensureRole(r.realtime),
    `alter role ${r.realtime} with login noinherit nocreaterole nocreatedb replication connection limit 10 password ${scramSecret(r.realtime, passwords.realtime)}`,
    `grant anon, authenticated, service_role to ${r.realtime}`,
    `grant ${REALTIME_ADMIN_ROLE} to ${r.realtime} with inherit true`,
    // realtime.list_changes() is declared with SET log_min_messages (a superuser setting)
    `grant set on parameter log_min_messages to ${r.realtime}`,
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
    `grant connect on database ${r.database} to ${r.storageAdmin}, ${r.realtime}`,
    `grant connect on database ${r.database} to ${PGRST_RELAY_ROLE}`,
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
    // Storage (M5): storage.* is created by the Storage API's own migrations, run as the storage role when the tenant
    // is registered. The owner role writes storage policies (CREATE POLICY needs the table owner's privileges), as
    // Supabase's "postgres" does.
    `alter schema storage owner to ${r.storageAdmin}`,
    `grant usage on schema storage to ${apiRoles}, ${r.owner}`,
    `grant ${r.storageAdmin} to ${r.owner}`,
    `grant usage on schema auth to ${r.storageAdmin}, ${r.realtime}`,
    // Realtime (M5): the owner adds its tables to the publication (alter publication ... add table needs its owner)
    `alter publication supabase_realtime owner to ${r.owner}`,
    `grant usage on schema realtime to ${apiRoles}, ${r.owner}`,
  ];
}

/**
 * Run inside the app database as supabase_admin after Realtime's tenant migrations (run by the migrator role, or by
 * Realtime's schema dump which hardcodes supabase_admin): the objects they own go to supabase_realtime_admin, then
 * the publication of Realtime's "broadcast changes" (Realtime would create it itself, which needs CREATE on the
 * database). Re-runnable.
 */
export function realtimeDatabaseSql(appId: string): string[] {
  const r = appRoles(appId);
  const migrators = `'supabase_admin', '${REALTIME_MIGRATOR_ROLE}'`;
  return [
    `do $$ declare q text; begin
      for q in select case c.relkind when 'c' then format('alter type %s owner to ${REALTIME_ADMIN_ROLE}', c.reltype::regtype)
          else format('alter %s %s owner to ${REALTIME_ADMIN_ROLE}',
            case c.relkind when 'S' then 'sequence' when 'v' then 'view' else 'table' end, c.oid::regclass) end
        from pg_class c where c.relnamespace = 'realtime'::regnamespace and c.relkind in ('r', 'p', 'v', 'S', 'c')
          and pg_get_userbyid(c.relowner) in (${migrators})
      loop execute q; end loop;
      for q in select format('alter routine %s owner to ${REALTIME_ADMIN_ROLE}', p.oid::regprocedure)
        from pg_proc p where p.pronamespace = 'realtime'::regnamespace and pg_get_userbyid(p.proowner) in (${migrators})
      loop execute q; end loop;
      for q in select format('alter type %s owner to ${REALTIME_ADMIN_ROLE}', t.oid::regtype)
        from pg_type t where t.typnamespace = 'realtime'::regnamespace and t.typrelid = 0 and t.typelem = 0
          and pg_get_userbyid(t.typowner) in (${migrators})
      loop execute q; end loop;
    end $$`,
    `alter schema realtime owner to ${REALTIME_ADMIN_ROLE}`,
    `do $$ begin
      if to_regclass('realtime.messages') is not null
         and not exists (select from pg_publication where pubname = 'supabase_realtime_messages_publication') then
        create publication supabase_realtime_messages_publication for table realtime.messages;
      end if;
      if exists (select from pg_publication where pubname = 'supabase_realtime_messages_publication') then
        alter publication supabase_realtime_messages_publication owner to ${r.realtime};
      end if;
    end $$`,
  ];
}

/**
 * B8: a stopped app's database is read-only by default for every new session (run in "postgres"). A guardrail, not
 * a security boundary: any session may still opt out with SET or BEGIN READ WRITE (accepted trade-off, formerly
 * TECH_DEBT CP-9).
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
    // DROP DATABASE refuses a database with logical replication slots: Realtime's are temporary (gone with their
    // session, which FORCE terminates), but a slot left behind by a crash or a manual test would block the deletion
    `select pg_terminate_backend(active_pid) from pg_replication_slots where database = '${r.database}' and active_pid is not null`,
    `select pg_drop_replication_slot(slot_name) from pg_replication_slots where database = '${r.database}' and not temporary`,
    `drop database if exists ${r.database} with (force)`,
    // the parameter privilege is a cluster-level object owned by the role grant: revoke it first
    `do $$ begin if exists (select from pg_roles where rolname = '${r.realtime}') then
       revoke set on parameter log_min_messages from ${r.realtime}; end if; end $$`,
    ...appLoginRoles(r).map((role) => `drop role if exists ${role}`),
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
