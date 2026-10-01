-- Minimal security linter, adapted from Supabase's splinter (https://github.com/supabase/splinter).
-- Each query returns (name, level, object, detail). Run inside the app database.

-- 0013_rls_disabled_in_public: table exposed through PostgREST without RLS
select 'rls_disabled_in_public' as name, 'ERROR' as level,
       format('%I.%I', n.nspname, c.relname) as object,
       'Table is exposed to anon/authenticated through the REST API but row level security is disabled' as detail
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relkind in ('r', 'p')
  and not c.relrowsecurity
  and (has_table_privilege('anon', c.oid, 'select') or has_table_privilege('authenticated', c.oid, 'select'))

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
       format('%I.%I', n.nspname, c.relname),
       'View runs with the privileges of its owner (no security_invoker): it bypasses RLS of the caller'
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relkind = 'v'
  and not coalesce(c.reloptions @> array['security_invoker=true'] or c.reloptions @> array['security_invoker=on'], false)
  and (has_table_privilege('anon', c.oid, 'select') or has_table_privilege('authenticated', c.oid, 'select'))

union all
-- 0011_function_search_path_mutable
select 'function_search_path_mutable', 'WARN',
       format('%I.%I', n.nspname, p.proname),
       'SECURITY DEFINER function without a fixed search_path'
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.prosecdef
  and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) cfg where cfg like 'search_path=%');
