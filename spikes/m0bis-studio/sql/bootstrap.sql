-- Run as supabase_admin by scripts/up.sh (idempotent). Variables: meta_pw, auth_pw.
set client_min_messages = warning;

-- pg-meta default connection: an empty database and a role with no privileges, so that any
-- request reaching pg-meta without a per-project x-connection-encrypted header sees nothing.
select 'create role studio_meta_default'
  where not exists (select from pg_roles where rolname = 'studio_meta_default') \gexec
alter role studio_meta_default with login nocreaterole nocreatedb noinherit connection limit 5 password :'meta_pw';
select 'create database studio_meta_default template template0'
  where not exists (select from pg_database where datname = 'studio_meta_default') \gexec
revoke all on database studio_meta_default from public;
grant connect on database studio_meta_default to studio_meta_default;

-- Studio's own GoTrue (dashboard users): same recipe as an app's auth_admin in M0.
select 'create role studio_auth_admin'
  where not exists (select from pg_roles where rolname = 'studio_auth_admin') \gexec
alter role studio_auth_admin with login noinherit nocreaterole nocreatedb connection limit 5 password :'auth_pw';
alter role studio_auth_admin set search_path = auth;
select 'create database studio_auth template template_supabase owner postgres'
  where not exists (select from pg_database where datname = 'studio_auth') \gexec
revoke all on database studio_auth from public;
grant connect on database studio_auth to studio_auth_admin;
