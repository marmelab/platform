-- app_<id>_owner (M0 recommendation 3): owns the app database and its public schema objects,
-- used by Studio (and later apply_migrations / execute_sql) instead of the cluster-wide "postgres".
-- BYPASSRLS like Supabase's postgres: auth.* tables have RLS enabled without policies, so Studio's
-- Auth > Users page (plain SQL on auth.users) shows 0 users otherwise. Scoped: the role can only
-- connect to its own database.
-- Run as supabase_admin in database "postgres". Variables: app, owner, pw.
set client_min_messages = warning;
select format('create role %I', :'owner')
  where not exists (select from pg_roles where rolname = :'owner') \gexec
select format('alter role %I with login inherit nocreaterole nocreatedb noreplication bypassrls connection limit 10 password %L', :'owner', :'pw') \gexec
-- SET ROLE anon/authenticated/service_role (RLS impersonation in the SQL editor) without inheriting them
select format('grant anon, authenticated, service_role to %I with inherit false, set true', :'owner') \gexec
-- the control plane (postgres) can still act as the owner
select format('grant %I to postgres', :'owner') \gexec
select format('alter database %I owner to %I', 'app_' || :'app', :'owner') \gexec
select format('revoke all on database %I from public', 'app_' || :'app') \gexec
select format('grant connect, temporary, create on database %I to %I', 'app_' || :'app', :'owner') \gexec
