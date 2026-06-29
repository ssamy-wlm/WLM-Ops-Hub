-- Run this once in the Supabase SQL editor (Project → SQL Editor → New query).
-- This is for a Supabase project, a separate Postgres instance from the
-- existing Vercel Postgres (POSTGRES_URL) and Vercel Blob (cloud-data.json)
-- stores in this app — it is not run via api/migrate-schema.js. Once this is
-- verified working, db/migrations/0001_core_pm_schema.sql and the Blob-based
-- client/task data become legacy and can be retired in a follow-up.

-- ── profiles ─────────────────────────────────────────────────────────────
-- One row per Supabase auth user, created automatically by the trigger below
-- the moment someone signs up. Never insert into this table directly.
create table if not exists public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  full_name  text,
  email      text not null,
  role       text not null default 'member' check (role in ('admin','member')),
  created_at timestamptz not null default now()
);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, full_name, email)
  values (new.id, new.raw_user_meta_data->>'full_name', new.email);
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ── clients ──────────────────────────────────────────────────────────────
create table if not exists public.clients (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  company_details text,
  created_at      timestamptz not null default now()
);

-- ── tasks ────────────────────────────────────────────────────────────────
create table if not exists public.tasks (
  id          uuid primary key default gen_random_uuid(),
  client_id   uuid not null references public.clients(id) on delete cascade,
  title       text not null,
  description text,
  status      text not null default 'Todo' check (status in ('Todo', 'In Progress', 'Done')),
  assigned_to uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists idx_tasks_client_id on public.tasks(client_id);
create index if not exists idx_tasks_assigned_to on public.tasks(assigned_to);

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists tasks_set_updated_at on public.tasks;
create trigger tasks_set_updated_at
  before update on public.tasks
  for each row execute procedure public.set_updated_at();

-- ── Row Level Security ───────────────────────────────────────────────────
-- Realtime only ever delivers rows a client is allowed to SELECT under RLS —
-- without these policies, .subscribe() would silently receive nothing.
alter table public.profiles enable row level security;
alter table public.clients  enable row level security;
alter table public.tasks    enable row level security;

drop policy if exists "profiles viewable by authenticated users" on public.profiles;
create policy "profiles viewable by authenticated users"
  on public.profiles for select to authenticated using (true);

drop policy if exists "clients viewable by authenticated users" on public.clients;
create policy "clients viewable by authenticated users"
  on public.clients for select to authenticated using (true);
drop policy if exists "clients writable by authenticated users" on public.clients;
create policy "clients writable by authenticated users"
  on public.clients for all to authenticated using (true) with check (true);

drop policy if exists "tasks viewable by authenticated users" on public.tasks;
create policy "tasks viewable by authenticated users"
  on public.tasks for select to authenticated using (true);
drop policy if exists "tasks writable by authenticated users" on public.tasks;
create policy "tasks writable by authenticated users"
  on public.tasks for all to authenticated using (true) with check (true);

-- ── Realtime ─────────────────────────────────────────────────────────────
-- Supabase only pushes change events for tables added to this publication.
-- ALTER PUBLICATION ... ADD TABLE has no IF NOT EXISTS form, so check first.
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'clients') then
    alter publication supabase_realtime add table public.clients;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'tasks') then
    alter publication supabase_realtime add table public.tasks;
  end if;
end $$;
