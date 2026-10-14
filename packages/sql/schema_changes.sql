-- Schema change tracking (ARCHITECTURE §7): an event trigger records every DDL command run in an app database, so that the
-- control plane can flag schema changes made outside a release (Studio SQL editor, execute_sql with write, a
-- function using SUPABASE_DB_URL...). Applied to template_supabase and, idempotently, to every app database at
-- control plane startup and at provisioning. Run as supabase_admin (event triggers need a superuser).
--
-- Who is recorded: every session except the platform's own (supabase_admin: provisioning, Studio registration;
-- platform_realtime_migrator: Realtime's tenant migrations) and the services' (app_<id>_auth_admin: GoTrue's migrations
-- at boot; app_<id>_storage_admin and app_<id>_realtime: Storage's and Realtime's migrations and partitions). Whether a change belongs to a release is decided by the
-- control plane, not here: it records the transaction id (txid) of each migrations deployment it commits, and a
-- change whose txid is not one of those is "outside release". The app roles can neither write that list nor this
-- table.
--
-- Protection: the schema, table, functions and event triggers belong to supabase_admin. The app owner role owns the
-- database but cannot drop, alter or disable objects it does not own, and session_replication_role (which would
-- skip event triggers) is superuser-only.

create schema if not exists _platform;
alter schema _platform owner to supabase_admin;
revoke all on schema _platform from public;

create table if not exists _platform.schema_changes (
  id bigserial primary key,
  at timestamptz not null default clock_timestamp(),
  txid xid8 not null default pg_current_xact_id(),
  event text not null,
  command_tag text not null,
  object_type text,
  object_identity text,
  role name not null default session_user,
  application_name text default current_setting('application_name', true)
);
alter table _platform.schema_changes owner to supabase_admin;
revoke all on _platform.schema_changes from public;
create index if not exists schema_changes_at on _platform.schema_changes (at);

-- Sessions whose DDL is not a builder's change.
create or replace function _platform.ignored_session() returns boolean
language sql stable set search_path = '' as $$
  select session_user::text in ('supabase_admin', 'platform_realtime_migrator')
      or session_user::text ~ '^app_[a-z0-9_]+_(auth_admin|storage_admin|realtime)$'
$$;
alter function _platform.ignored_session() owner to supabase_admin;

create or replace function _platform.record_ddl() returns event_trigger
language plpgsql security definer set search_path = '' as $$
begin
  if _platform.ignored_session() then return; end if;
  insert into _platform.schema_changes (event, command_tag, object_type, object_identity)
  select 'ddl_command_end', c.command_tag, c.object_type, c.object_identity
    from pg_event_trigger_ddl_commands() c
   where not c.in_extension and coalesce(c.schema_name, '') !~ '^pg_temp';
end
$$;
alter function _platform.record_ddl() owner to supabase_admin;
revoke all on function _platform.record_ddl() from public;

create or replace function _platform.record_drop() returns event_trigger
language plpgsql security definer set search_path = '' as $$
begin
  if _platform.ignored_session() then return; end if;
  insert into _platform.schema_changes (event, command_tag, object_type, object_identity)
  select 'sql_drop', tg_tag, d.object_type, d.object_identity
    from pg_event_trigger_dropped_objects() d
   where d.original and not d.is_temporary;
end
$$;
alter function _platform.record_drop() owner to supabase_admin;
revoke all on function _platform.record_drop() from public;

do $$
begin
  if not exists (select from pg_event_trigger where evtname = 'platform_record_ddl') then
    create event trigger platform_record_ddl on ddl_command_end execute function _platform.record_ddl();
  end if;
  if not exists (select from pg_event_trigger where evtname = 'platform_record_drop') then
    create event trigger platform_record_drop on sql_drop execute function _platform.record_drop();
  end if;
  -- re-enable if a superuser disabled them
  alter event trigger platform_record_ddl enable;
  alter event trigger platform_record_drop enable;
  alter event trigger platform_record_ddl owner to supabase_admin;
  alter event trigger platform_record_drop owner to supabase_admin;
end $$;
