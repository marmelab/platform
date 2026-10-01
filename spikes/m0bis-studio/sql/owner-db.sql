-- Run as supabase_admin inside app_<id>. Variables: owner, auth_admin.
set client_min_messages = warning;
-- objects created so far by postgres in public (M0 demo migration) move to the owner
select format('alter table %I.%I owner to %I', n.nspname, c.relname, :'owner')
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r','p','v','m','f') and c.relowner = 'postgres'::regrole \gexec
select format('alter sequence %I.%I owner to %I', n.nspname, c.relname, :'owner')
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'S' and c.relowner = 'postgres'::regrole
    and not exists (select from pg_depend d where d.objid = c.oid and d.deptype in ('a','i')) \gexec
select format('alter routine %s owner to %I', p.oid::regprocedure, :'owner')
  from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proowner = 'postgres'::regrole \gexec
-- same default privileges as "postgres" has in a Supabase project
select format('alter default privileges for role %I in schema public grant all on tables to anon, authenticated, service_role', :'owner') \gexec
select format('alter default privileges for role %I in schema public grant all on sequences to anon, authenticated, service_role', :'owner') \gexec
select format('alter default privileges for role %I in schema public grant execute on functions to anon, authenticated, service_role', :'owner') \gexec
-- schemas used by Supabase SQL (extensions, graphql) and read access to auth for Studio's
-- Auth > Users page and for migrations (FK to auth.users, triggers on auth.users)
select format('grant usage on schema extensions, graphql, graphql_public, auth to %I', :'owner') \gexec
select format('grant select on all tables in schema auth to %I', :'owner') \gexec
select format('grant references, trigger on auth.users to %I', :'owner') \gexec
