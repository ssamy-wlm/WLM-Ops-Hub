-- Core relational schema for WLM-Ops-Hub's main data store, replacing the
-- single Vercel Blob JSON document (wlm-ops-hub/cloud-data.json) that backs
-- api/cloud-data.js today. See the migration plan for full context.
--
-- This is intentionally a SEPARATE, additive set of tables from the ones in
-- 20260629120000_init_realtime_schema.sql (profiles/clients/tasks) — those
-- back the standalone task-board.html demo and assume Supabase Auth/RLS;
-- this app's main pages keep their existing custom login and reach these
-- tables only through server-side endpoints using the service-role key, so
-- every table here is prefixed ops_ to avoid any name collision or ambiguity
-- about which "clients"/"tasks" a future reader should trust. No RLS is
-- enabled on any ops_ table, and none are added to the supabase_realtime
-- publication — the app polls via its own endpoints, it doesn't need
-- Postgres realtime push, and turning that on unguarded by RLS would let the
-- anon key receive every row change.
--
-- Idempotent throughout (create table if not exists / drop+create for
-- triggers and functions), consistent with the existing migration file.

-- ── people / auth-adjacent ──────────────────────────────────────────────────

create table if not exists public.ops_users (
  id                    uuid primary key default gen_random_uuid(),
  legacy_id             text unique,
  name                  text not null,
  email                 text not null unique,
  password_hash         text not null,
  status                text not null default 'active' check (status in ('active','archived')),
  title                 text,
  role                  text not null default 'Employee' check (role in ('Admin','Manager','Employee','Contractor')),
  resp                  text,
  hours                 numeric,
  pay_rate              numeric,
  manager_id            uuid references public.ops_users(id) on delete set null,
  probation_start       date,
  probation_end         date,
  must_change_password  boolean not null default false,
  first_login           boolean not null default true,
  seeded                boolean not null default false,
  archived_at           timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index if not exists idx_ops_users_status on public.ops_users(status);
create index if not exists idx_ops_users_manager_id on public.ops_users(manager_id);

create table if not exists public.ops_admins (
  id            uuid primary key default gen_random_uuid(),
  legacy_id     text unique,
  name          text not null,
  email         text not null unique,
  password_hash text not null,
  title         text,
  initials      text,
  level         text not null default 'admin'
                check (level in ('super','owner','admin','account_manager','production_manager','creative_manager')),
  status        text not null default 'active',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- admins[].assignedUsers[] (admin -> many users)
create table if not exists public.ops_admin_assigned_users (
  admin_id uuid not null references public.ops_admins(id) on delete cascade,
  user_id  uuid not null references public.ops_users(id) on delete cascade,
  primary key (admin_id, user_id)
);

-- tombstones — users are never hard-deleted; this table IS deletedUserIds[],
-- queried instead of array-membership-checked.
create table if not exists public.ops_deleted_user_ids (
  legacy_user_id text primary key,
  deleted_at     timestamptz not null default now()
);

-- ── clients, services, projects, subprojects, tasks ────────────────────────

create table if not exists public.ops_clients (
  id              uuid primary key default gen_random_uuid(),
  legacy_id       text unique,
  name            text not null,
  pinned          boolean not null default false,
  status          text not null default 'active' check (status in ('active','archived')),
  color           text,
  code            text,
  industry        text,
  account_manager text,
  manager_id      uuid references public.ops_users(id) on delete set null,
  client_name     text,
  client_email    text,
  client_phone    text,
  referred_by     text,
  notes           text,
  internal_notes  text,
  website         text,
  logo            text,
  brand_colors    jsonb not null default '[]',
  brand_details   text,
  start_date      date,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists idx_ops_clients_status on public.ops_clients(status);
create index if not exists idx_ops_clients_manager_id on public.ops_clients(manager_id);

create table if not exists public.ops_services (
  id            uuid primary key default gen_random_uuid(),
  legacy_id     text unique,
  client_id     uuid not null references public.ops_clients(id) on delete cascade,
  catalog_id    text,
  name          text not null,
  freq          text check (freq in ('monthly','weekly','yearly','one-time')),
  freq_label    text,
  assignee_id   uuid references public.ops_users(id) on delete set null,
  assignee_name text,
  status        text not null default 'active' check (status in ('active','paused','completed')),
  last_done     date,
  due           date,
  platforms     text,
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists idx_ops_services_client_id on public.ops_services(client_id);
create index if not exists idx_ops_services_assignee_id on public.ops_services(assignee_id);

create table if not exists public.ops_projects (
  id                   uuid primary key default gen_random_uuid(),
  legacy_id            text unique,
  client_id            uuid not null references public.ops_clients(id) on delete cascade,
  service_id           uuid references public.ops_services(id) on delete set null,
  name                 text not null,
  type                 text,
  billing              text,
  status               text not null default 'not-started'
                       check (status in ('not-started','in-progress','on-hold','completed','cancelled')),
  priority             text,
  start_date           date,
  due_date             date,
  color                text,
  description          text,
  progress             numeric,
  progress_log         jsonb not null default '[]',
  milestones           jsonb not null default '[]',
  is_recurring_service boolean not null default false,
  freq                 text,
  freq_label           text,
  last_done            date,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index if not exists idx_ops_projects_client_id on public.ops_projects(client_id);
create index if not exists idx_ops_projects_status on public.ops_projects(status);

-- projects[].users[] (assigned user ids)
create table if not exists public.ops_project_users (
  project_id uuid not null references public.ops_projects(id) on delete cascade,
  user_id    uuid not null references public.ops_users(id) on delete cascade,
  primary key (project_id, user_id)
);

create table if not exists public.ops_subprojects (
  id         uuid primary key default gen_random_uuid(),
  legacy_id  text unique,
  project_id uuid not null references public.ops_projects(id) on delete cascade,
  name       text not null,
  billing    text,
  status     text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_ops_subprojects_project_id on public.ops_subprojects(project_id);

create table if not exists public.ops_subproject_users (
  subproject_id uuid not null references public.ops_subprojects(id) on delete cascade,
  user_id       uuid not null references public.ops_users(id) on delete cascade,
  primary key (subproject_id, user_id)
);

-- A task belongs to EITHER a project directly OR a subproject — never both.
create table if not exists public.ops_tasks (
  id                  uuid primary key default gen_random_uuid(),
  legacy_id           text unique,
  project_id          uuid references public.ops_projects(id) on delete cascade,
  subproject_id       uuid references public.ops_subprojects(id) on delete cascade,
  name                text not null,
  assignee_id         uuid references public.ops_users(id) on delete set null,
  assignee_name       text,
  due                 date,
  done                boolean not null default false,
  last_edited_by_id   uuid references public.ops_users(id) on delete set null,
  last_edited_by_name text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint ops_tasks_one_parent check (
    (project_id is not null and subproject_id is null) or
    (project_id is null and subproject_id is not null)
  )
);
create index if not exists idx_ops_tasks_project_id on public.ops_tasks(project_id);
create index if not exists idx_ops_tasks_subproject_id on public.ops_tasks(subproject_id);
create index if not exists idx_ops_tasks_assignee_id on public.ops_tasks(assignee_id);
create index if not exists idx_ops_tasks_due on public.ops_tasks(due);

-- ── org chart ────────────────────────────────────────────────────────────

create table if not exists public.ops_org_nodes (
  id         uuid primary key default gen_random_uuid(),
  legacy_id  text unique,
  name       text not null,
  title      text,
  level      text check (level in ('ceo','partner','director','manager','member')),
  x          numeric,
  y          numeric,
  fixed      boolean not null default false,
  photo_url  text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.ops_org_links (
  manager_node_id uuid not null references public.ops_org_nodes(id) on delete cascade,
  report_node_id  uuid not null references public.ops_org_nodes(id) on delete cascade,
  primary key (manager_node_id, report_node_id)
);

-- ── append/cap-bounded logs and time tracking ─────────────────────────────

create table if not exists public.ops_goals (
  id          uuid primary key default gen_random_uuid(),
  legacy_id   text unique,
  title       text not null,
  description text,
  progress    numeric,
  due_date    date,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- feed[] (activity log) — the ~500 cap was a blob-size mitigation, meaningless
-- once each entry is its own row; old rows simply aren't queried by default.
create table if not exists public.ops_feed (
  id          uuid primary key default gen_random_uuid(),
  legacy_id   text,
  type        text,
  user_name   text,
  description text,
  detail      text,
  occurred_at timestamptz not null default now()
);
create index if not exists idx_ops_feed_occurred_at on public.ops_feed(occurred_at desc);

create table if not exists public.ops_messages (
  id         uuid primary key default gen_random_uuid(),
  legacy_id  text,
  title      text,
  body       text,
  user_name  text,
  created_at timestamptz not null default now()
);
create index if not exists idx_ops_messages_created_at on public.ops_messages(created_at desc);

-- roadmapTasks[] — kept loose as jsonb since this internal planning list has
-- a less-stable shape than client/task data; promote fields to columns later
-- only if/when something needs to query into it directly.
create table if not exists public.ops_roadmap_tasks (
  id         uuid primary key default gen_random_uuid(),
  legacy_id  text unique,
  data       jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.ops_time_off_requests (
  id          uuid primary key default gen_random_uuid(),
  legacy_id   text unique,
  user_id     uuid not null references public.ops_users(id) on delete cascade,
  start_date  date not null,
  end_date    date not null,
  status      text not null default 'pending' check (status in ('pending','approved','denied')),
  approved_by uuid references public.ops_admins(id) on delete set null,
  reviewed_at timestamptz,
  admin_note  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Append-only audit ledger — never pruned, never updated, only inserted.
-- on delete restrict (not cascade): users are tombstoned, never hard-deleted,
-- so a future accidental hard-delete must fail loudly rather than silently
-- destroy payroll history. No updated_at/trigger on purpose — an UPDATE on
-- this table is itself a bug signal.
create table if not exists public.ops_time_off_ledger (
  id        uuid primary key default gen_random_uuid(),
  legacy_id text unique,
  user_id   uuid not null references public.ops_users(id) on delete restrict,
  hours     numeric not null,
  logged_at timestamptz not null default now()
);
create index if not exists idx_ops_time_off_ledger_user_id on public.ops_time_off_ledger(user_id);

-- ── settings singleton ─────────────────────────────────────────────────────
-- Replaces announcement / coc / settings / otPolicy / orgLayoutVersion /
-- orgExcluded / primaryAdminPw — all "exactly one global value" fields,
-- fetched and written whole by the same admin-settings UI, never filtered or
-- joined. Forcing each into its own one-row table would add ceremony with no
-- query benefit.
create table if not exists public.ops_settings_singleton (
  id                           boolean primary key default true,
  announcement                 text,
  coc                          jsonb,
  app_settings                 jsonb,
  ot_policy                    jsonb,
  org_layout_version           text,
  org_excluded_names           jsonb not null default '[]',
  primary_admin_password_hash  text,
  updated_at                   timestamptz not null default now(),
  constraint ops_settings_singleton_single_row check (id)
);
insert into public.ops_settings_singleton (id) values (true) on conflict (id) do nothing;

-- ── pending task-change notification queue ────────────────────────────────
-- Replaces the Blob-JSON QUEUE_PATH file used by api/_task-notifications.js.
-- One row per task with an open batch of unsent field changes.
create table if not exists public.ops_pending_task_notifications (
  task_id          uuid primary key references public.ops_tasks(id) on delete cascade,
  fields           jsonb not null default '{}',
  first_changed_at timestamptz not null default now(),
  last_changed_at  timestamptz not null default now(),
  attempts         integer not null default 0
);

-- ── triggers ───────────────────────────────────────────────────────────────
-- Reuses public.set_updated_at(), already defined in
-- 20260629120000_init_realtime_schema.sql — the one piece of that migration
-- this schema shares rather than redefining.

do $$
declare
  t text;
begin
  foreach t in array array[
    'ops_users','ops_admins','ops_clients','ops_services','ops_projects',
    'ops_subprojects','ops_tasks','ops_org_nodes','ops_goals',
    'ops_roadmap_tasks','ops_time_off_requests'
  ]
  loop
    execute format('drop trigger if exists %I_set_updated_at on public.%I', t, t);
    execute format(
      'create trigger %I_set_updated_at before update on public.%I for each row execute procedure public.set_updated_at()',
      t, t
    );
  end loop;
end $$;

-- ── storage bucket for org-chart photos ────────────────────────────────────
-- Private bucket; the app generates short-lived signed URLs server-side on
-- read rather than ever exposing a Storage credential to the browser.
insert into storage.buckets (id, name, public)
values ('org-photos', 'org-photos', false)
on conflict (id) do nothing;
