create table public.todos (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title text not null,
  done boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.todos enable row level security;

create policy "todos: owner can read" on public.todos
  for select to authenticated using (user_id = (select auth.uid()));
create policy "todos: owner can insert" on public.todos
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy "todos: owner can update" on public.todos
  for update to authenticated using (user_id = (select auth.uid()));
create policy "todos: owner can delete" on public.todos
  for delete to authenticated using (user_id = (select auth.uid()));
