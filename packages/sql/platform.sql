-- Control plane data model (database "platform"). Idempotent: applied at every start.

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  name text,
  role text not null default 'developer' check (role in ('admin', 'developer')),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id) on delete cascade,
  name text not null,
  hash text not null unique,
  scopes text[] not null default '{}',
  app_ids uuid[],
  expires_at timestamptz,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists apps (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  owner_id uuid not null references users (id),
  status text not null default 'provisioning'
    check (status in ('provisioning', 'running', 'stopped', 'error', 'deleted')),
  db_name text not null,
  secrets_enc text not null,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists app_members (
  app_id uuid not null references apps (id) on delete cascade,
  user_id uuid not null references users (id) on delete cascade,
  role text not null default 'developer' check (role in ('owner', 'developer')),
  primary key (app_id, user_id)
);

create table if not exists app_secrets (
  app_id uuid not null references apps (id) on delete cascade,
  name text not null,
  value_enc text not null,
  updated_at timestamptz not null default now(),
  primary key (app_id, name)
);

create table if not exists deployments (
  id uuid primary key default gen_random_uuid(),
  app_id uuid not null references apps (id) on delete cascade,
  kind text not null check (kind in ('frontend', 'functions', 'migrations')),
  version integer not null,
  status text not null default 'pending'
    check (status in ('pending', 'uploaded', 'live', 'ready', 'failed')),
  created_by uuid references users (id),
  created_at timestamptz not null default now(),
  finalized_at timestamptz,
  manifest jsonb,
  error text,
  unique (app_id, kind, version)
);

create table if not exists uploads (
  id uuid primary key default gen_random_uuid(),
  deployment_id uuid not null references deployments (id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  size_bytes bigint,
  created_at timestamptz not null default now()
);

create table if not exists audit_log (
  id bigint generated always as identity primary key,
  user_id uuid references users (id),
  app_id uuid references apps (id) on delete set null,
  action text not null,
  details jsonb,
  created_at timestamptz not null default now()
);
