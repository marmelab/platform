create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null unique,
  display_name text not null
);

create function public.sync_profile() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, email, display_name)
  values (
    new.id,
    lower(new.email),
    coalesce(nullif(new.raw_user_meta_data ->> 'display_name', ''), split_part(new.email, '@', 1))
  )
  on conflict (id) do update set email = excluded.email;
  return new;
end;
$$;

create trigger sync_profile after insert or update of email on auth.users
  for each row when (new.email is not null) execute function public.sync_profile();

insert into public.profiles (id, email, display_name)
select id, lower(email), split_part(email, '@', 1) from auth.users where email is not null
on conflict (id) do nothing;

create table public.notes (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  title text not null default '' check (length(title) <= 200),
  content text not null default '' check (length(content) <= 100000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid() references public.profiles (id) on delete set null
);

create index notes_author_id_idx on public.notes (author_id);
create index notes_updated_by_idx on public.notes (updated_by);

create table public.note_shares (
  note_id uuid not null references public.notes (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  permission text not null check (permission in ('read', 'edit')),
  created_at timestamptz not null default now(),
  primary key (note_id, user_id)
);

create index note_shares_user_id_idx on public.note_shares (user_id);

create function public.touch_note() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.author_id := old.author_id;
  new.created_at := old.created_at;
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end;
$$;

create trigger touch_note before update on public.notes
  for each row execute function public.touch_note();

-- 'owner', 'edit', 'read' or null for the current user. Security definer so that the policies of notes and
-- note_shares can read each other without recursing.
create function public.note_role(target uuid) returns text
language sql stable security definer set search_path = '' as $$
  select case
    when n.author_id = (select auth.uid()) then 'owner'
    else (select s.permission from public.note_shares s where s.note_id = n.id and s.user_id = (select auth.uid()))
  end
  from public.notes n
  where n.id = target;
$$;

create function public.is_collaborator(other uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.notes n
    where (n.author_id = (select auth.uid())
        or exists (select 1 from public.note_shares s where s.note_id = n.id and s.user_id = (select auth.uid())))
      and (n.author_id = other
        or exists (select 1 from public.note_shares s where s.note_id = n.id and s.user_id = other))
  );
$$;

revoke execute on function public.sync_profile(), public.touch_note() from public, anon, authenticated;
revoke execute on function public.note_role(uuid), public.is_collaborator(uuid) from public, anon;
grant execute on function public.note_role(uuid), public.is_collaborator(uuid) to authenticated;
revoke all on public.profiles, public.notes, public.note_shares from anon;

alter table public.profiles enable row level security;
alter table public.notes enable row level security;
alter table public.note_shares enable row level security;

create policy "profiles: self and collaborators can read" on public.profiles
  for select to authenticated using (id = (select auth.uid()) or public.is_collaborator(id));
create policy "profiles: self can update" on public.profiles
  for update to authenticated using (id = (select auth.uid())) with check (id = (select auth.uid()));

create policy "notes: author and shared users can read" on public.notes
  for select to authenticated using (author_id = (select auth.uid()) or public.note_role(id) is not null);
create policy "notes: users can create their own" on public.notes
  for insert to authenticated with check (author_id = (select auth.uid()));
create policy "notes: author and editors can update" on public.notes
  for update to authenticated
  using (public.note_role(id) in ('owner', 'edit'))
  with check (public.note_role(id) in ('owner', 'edit'));
create policy "notes: author can delete" on public.notes
  for delete to authenticated using (author_id = (select auth.uid()));

create policy "note_shares: collaborators can read" on public.note_shares
  for select to authenticated using (public.note_role(note_id) is not null);
create policy "note_shares: author can share" on public.note_shares
  for insert to authenticated with check (public.note_role(note_id) = 'owner' and user_id <> (select auth.uid()));
create policy "note_shares: author can change permissions" on public.note_shares
  for update to authenticated
  using (public.note_role(note_id) = 'owner')
  with check (public.note_role(note_id) = 'owner' and user_id <> (select auth.uid()));
create policy "note_shares: author can unshare" on public.note_shares
  for delete to authenticated using (public.note_role(note_id) = 'owner');
