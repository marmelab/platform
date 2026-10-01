-- Platform additions applied inside template_supabase (cloned from the image's
-- "postgres" database, so it already contains everything `supabase start` has).

-- Same table as the Supabase CLI, so local `supabase migration` files stay compatible.
create schema if not exists supabase_migrations;
create table if not exists supabase_migrations.schema_migrations (
  version text primary key,
  statements text[],
  name text,
  created_by text,
  idempotency_key text unique
);
alter schema supabase_migrations owner to postgres;
alter table supabase_migrations.schema_migrations owner to postgres;
