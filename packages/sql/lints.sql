-- Security linter (ARCHITECTURE §7, TECH_DEBT CP-4), run inside the app database as the app's owner role, in the migrations
-- transaction (apply_migrations) or on its own (lint runs: admin console, CLI, periodic sweep).
--
-- The rules are rewritten from Supabase's splinter (https://github.com/supabase/splinter, lints/00NN_*.sql; checked
-- against commit fccca4b of 2026-09-29) and keep its lint names, so that splinter's documentation applies:
-- https://supabase.com/docs/guides/database/database-linter?lint=<number>_<name>. splinter itself is not vendored: its
-- repository declares no license. Differences with splinter:
--   * the exposed schemas are the platform's PostgREST schemas (PGRST_DB_SCHEMAS of every app: public, graphql_public)
--     instead of the `pgrst.db_schemas` setting;
--   * rls_disabled_in_public also counts write grants (insert, update, delete), not only select;
--   * function_search_path_mutable only covers SECURITY DEFINER functions;
--   * the security definer function rules skip trigger functions (not callable through /rest/v1/rpc);
--   * unindexed_foreign_keys is a WARN (an INFO in splinter);
--   * public_bucket_allows_listing is in lints_storage.sql (storage.* may not exist yet).
-- Each row: (name, level, object, detail). `object` identifies what the lint is about (accept_lints matches on it).

with exposed(nspname) as (values ('public'), ('graphql_public')),
system_schemas(nspname) as (
  values ('auth'), ('cron'), ('extensions'), ('graphql'), ('graphql_public'), ('information_schema'), ('net'),
    ('pgbouncer'), ('pg_catalog'), ('pg_toast'), ('pgsodium'), ('pgsodium_masks'), ('realtime'), ('storage'),
    ('supabase_functions'), ('supabase_migrations'), ('vault'), ('_platform'), ('_realtime'), ('pgmq'), ('pgtle')
),
-- relations of the exposed schemas that are not extension members
api_relations as (
  select c.oid, c.relname, c.relkind, c.relrowsecurity, c.reloptions, n.nspname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname in (select nspname from exposed)
     and not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')
),
api_readable as (
  select * from api_relations r
   where has_table_privilege('anon', r.oid, 'select') or has_table_privilege('authenticated', r.oid, 'select')
),
policies as (
  select n.nspname, c.relname, c.relrowsecurity, p.polname, p.polcmd, p.polpermissive, p.polroles,
         pg_get_expr(p.polqual, p.polrelid) as qual, pg_get_expr(p.polwithcheck, p.polrelid) as with_check
    from pg_policy p
    join pg_class c on c.oid = p.polrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname not in (select nspname from system_schemas)
),
-- the policy roles anon, authenticated or public (every role)
api_policies as (
  select *, regexp_replace(lower(coalesce(qual, '')), '\s', '', 'g') as norm_qual,
         regexp_replace(lower(coalesce(with_check, '')), '\s', '', 'g') as norm_check
    from policies
   where 0::oid = any(polroles)
      or exists (select 1 from unnest(polroles) r where r in ('anon'::regrole, 'authenticated'::regrole))
),
security_definer_functions as (
  select n.nspname, p.proname, p.oid, pg_get_function_identity_arguments(p.oid) as args
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where p.prosecdef
     and p.prokind = 'f'
     and p.prorettype not in ('trigger'::regtype, 'event_trigger'::regtype)
     and n.nspname in (select nspname from exposed)
     and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
)

-- 0013_rls_disabled_in_public: table exposed through the REST API without RLS
select 'rls_disabled_in_public' as name, 'ERROR' as level,
       format('%I.%I', r.nspname, r.relname) as object,
       'Table is exposed to anon/authenticated through the REST API but row level security is disabled' as detail
from api_relations r
where r.relkind in ('r', 'p')
  and not r.relrowsecurity
  and exists (select 1 from unnest(array['select', 'insert', 'update', 'delete']) priv
               where has_table_privilege('anon', r.oid, priv) or has_table_privilege('authenticated', r.oid, priv))

union all
-- 0008_rls_enabled_no_policy: RLS on but nothing allowed (often a forgotten policy)
select 'rls_enabled_no_policy', 'INFO',
       format('%I.%I', n.nspname, c.relname),
       'Row level security is enabled but no policy exists: the table is unreachable for anon/authenticated'
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relkind in ('r', 'p')
  and c.relrowsecurity
  and not exists (select 1 from pg_policy p where p.polrelid = c.oid)

union all
-- 0007_policy_exists_rls_disabled: policies are written but not enforced
select 'policy_exists_rls_disabled', 'ERROR',
       format('%I.%I', n.nspname, c.relname),
       'Policies exist on this table but row level security is disabled, so they are not enforced'
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relkind in ('r', 'p')
  and not c.relrowsecurity
  and exists (select 1 from pg_policy p where p.polrelid = c.oid)

union all
-- 0010_security_definer_view: view bypassing the caller's RLS
select 'security_definer_view', 'ERROR',
       format('%I.%I', r.nspname, r.relname),
       'View runs with the privileges of its owner (no security_invoker): it bypasses RLS of the caller'
from api_readable r
where r.relkind = 'v'
  and not (lower(coalesce(r.reloptions::text, '{}'))::text[]
           && array['security_invoker=1', 'security_invoker=true', 'security_invoker=yes', 'security_invoker=on'])

union all
-- 0011_function_search_path_mutable (SECURITY DEFINER functions only)
select 'function_search_path_mutable', 'WARN',
       format('%I.%I', n.nspname, p.proname),
       'SECURITY DEFINER function without a fixed search_path'
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.prosecdef
  and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) cfg where cfg like 'search_path=%')

union all
-- 0002_auth_users_exposed: a view or materialized view of the API reads auth.users with its owner's privileges
select distinct 'auth_users_exposed', 'ERROR',
       format('%I.%I', r.nspname, r.relname),
       'View or materialized view readable by anon/authenticated exposes auth.users (emails, metadata) through the REST API'
from api_readable r
join pg_rewrite rw on rw.ev_class = r.oid
join pg_depend d on d.classid = 'pg_rewrite'::regclass and d.objid = rw.oid and d.deptype = 'n'
where d.refobjid = 'auth.users'::regclass
  and (r.relkind = 'm'
       or (r.relkind = 'v' and (
             not (lower(coalesce(r.reloptions::text, '{}'))::text[]
                  && array['security_invoker=1', 'security_invoker=true', 'security_invoker=yes', 'security_invoker=on'])
             or not (select relrowsecurity from pg_class where oid = 'auth.users'::regclass))))

union all
-- 0028_anon_security_definer_function_executable: callable without signing in, through /rest/v1/rpc
select 'anon_security_definer_function_executable', 'WARN',
       format('%I.%I(%s)', f.nspname, f.proname, f.args),
       'SECURITY DEFINER function executable by anon through /rest/v1/rpc: it runs with its owner''s privileges and '
         || 'bypasses RLS. Revoke EXECUTE from anon (and public), or make it SECURITY INVOKER'
from security_definer_functions f
where has_function_privilege('anon', f.oid, 'execute')

union all
-- 0029_authenticated_security_definer_function_executable
select 'authenticated_security_definer_function_executable', 'WARN',
       format('%I.%I(%s)', f.nspname, f.proname, f.args),
       'SECURITY DEFINER function executable by any signed-in user through /rest/v1/rpc: it runs with its owner''s '
         || 'privileges and bypasses RLS. Check the caller inside, revoke EXECUTE, or make it SECURITY INVOKER'
from security_definer_functions f
where has_function_privilege('authenticated', f.oid, 'execute')
  and not has_function_privilege('anon', f.oid, 'execute')

union all
-- 0014_extension_in_public
select 'extension_in_public', 'WARN',
       e.extname::text,
       'Extension installed in the public schema: its functions and tables are exposed through the REST API. '
         || 'Create it in the extensions schema'
from pg_extension e
where e.extnamespace = 'public'::regnamespace
  and e.extname <> 'plpgsql'

union all
-- 0016_materialized_view_in_api: materialized views have no RLS
select 'materialized_view_in_api', 'WARN',
       format('%I.%I', r.nspname, r.relname),
       'Materialized view readable by anon/authenticated through the REST API (materialized views ignore RLS)'
from api_readable r
where r.relkind = 'm'

union all
-- 0017_foreign_table_in_api: foreign tables have no RLS
select 'foreign_table_in_api', 'WARN',
       format('%I.%I', r.nspname, r.relname),
       'Foreign table readable by anon/authenticated through the REST API (foreign tables ignore RLS)'
from api_readable r
where r.relkind = 'f'

union all
-- 0015_rls_references_user_metadata: user_metadata is writable by the user
select 'rls_references_user_metadata', 'ERROR',
       format('%I.%I', p.nspname, p.relname) || ' policy ' || quote_ident(p.polname),
       'Policy reads user_metadata from the JWT: users can change their own user_metadata, never use it for '
         || 'authorization (use app_metadata)'
from policies p
where (coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '')) ~ 'user_metadata'
  and (coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '')) ~ '(auth\.jwt\(\)|request\.jwt\.claim)'

union all
-- 0024_rls_policy_always_true: write policies that let anyone change any row (SELECT using (true) is often wanted)
select 'rls_policy_always_true', 'WARN',
       format('%I.%I', p.nspname, p.relname) || ' policy ' || quote_ident(p.polname),
       format('Permissive %s policy for anon/authenticated whose %s is always true: any user can %s every row',
         case p.polcmd when 'a' then 'INSERT' when 'w' then 'UPDATE' when 'd' then 'DELETE' else 'ALL' end,
         case when p.polcmd = 'a' then 'WITH CHECK' else 'USING' end,
         case p.polcmd when 'a' then 'insert' when 'w' then 'update' when 'd' then 'delete' else 'write' end)
from api_policies p
where p.relrowsecurity
  and p.polpermissive
  and p.polcmd in ('a', 'w', 'd', '*')
  and (
    (p.polcmd <> 'a' and (p.norm_qual in ('true', '(true)', '1=1', '(1=1)') or p.qual is null))
    or (p.polcmd = 'a' and (p.norm_check in ('true', '(true)', '1=1', '(1=1)') or p.with_check is null))
  )

union all
-- 0001_unindexed_foreign_keys (WARN here): deletes and joins on the referenced table scan the referencing one
select 'unindexed_foreign_keys', 'WARN',
       format('%I.%I', n.nspname, c.relname) || ' ' || quote_ident(ct.conname),
       'Foreign key without a covering index: create an index on its columns'
from pg_constraint ct
join pg_class c on c.oid = ct.conrelid
join pg_namespace n on n.oid = c.relnamespace
where ct.contype = 'f'
  and n.nspname not in (select nspname from system_schemas)
  and not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')
  and not exists (
    select 1 from pg_index i
     where i.indrelid = ct.conrelid and i.indisvalid
       and (string_to_array(i.indkey::text, ' ')::smallint[])[1:cardinality(ct.conkey)] = ct.conkey)

union all
-- 0004_no_primary_key: Realtime's postgres_changes and the table editor need one
select 'no_primary_key', 'INFO',
       format('%I.%I', r.nspname, r.relname),
       'Table without a primary key'
from api_relations r
where r.relkind in ('r', 'p')
  and not exists (select 1 from pg_index i where i.indrelid = r.oid and i.indisprimary)
