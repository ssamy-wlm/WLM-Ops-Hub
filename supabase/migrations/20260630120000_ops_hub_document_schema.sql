-- ============================================================================
-- WLM Ops Hub — document-model schema (replaces the Vercel Blob cloud-data.json)
-- ----------------------------------------------------------------------------
-- One row per top-level record; the record is stored as jsonb in `data`.
-- ALL access is server-side via the service-role key. RLS is enabled on every
-- table with NO policies, so the anon/authenticated (browser) roles get ZERO
-- access — only the service role (which bypasses RLS) can read/write.
--
-- DATA SAFETY:
--   * The cleanup block below ONLY drops a pre-existing table if it is EMPTY.
--     If any listed table contains even one row it RAISES and changes nothing,
--     so real data can never be dropped by re-running this script.
--   * Append-only tables (ops_feed, ops_time_off_ledger) block UPDATE/DELETE at
--     the database level via a trigger, even for the service role.
--   * Idempotent: safe to re-run before any data has been imported.
-- ============================================================================

-- ── 0. Safe cleanup of EMPTY legacy/leftover tables that share these names ──
-- Removes only empty scaffolding (e.g. the older normalized ops_* schema) so the
-- document-model tables below can be created cleanly. Refuses if any has rows.
do $$
declare
  t   text;
  n   bigint;
  tbls text[] := array[
    -- document-model tables (recreated below)
    'ops_users','ops_admins','ops_clients','ops_goals','ops_roadmap_tasks',
    'ops_org_nodes','ops_org_links','ops_time_off_requests','ops_messages',
    'ops_settings','ops_deleted_user_ids','ops_feed','ops_time_off_ledger',
    'ops_summaries',
    -- older normalized-only tables that the document model no longer uses
    'ops_services','ops_projects','ops_project_users','ops_subprojects',
    'ops_subproject_users','ops_tasks','ops_admin_assigned_users',
    'ops_settings_singleton','ops_pending_task_notifications','ops_org_links',
    'ops_deleted_client_ids'
  ];
begin
  foreach t in array tbls loop
    if exists (select 1 from information_schema.tables
               where table_schema='public' and table_name=t) then
      execute format('select count(*) from public.%I', t) into n;
      if n > 0 then
        raise exception
          'public.% has % row(s) — refusing to drop. Resolve manually before re-running this migration.', t, n;
      end if;
      execute format('drop table if exists public.%I cascade', t);
    end if;
  end loop;
end $$;

-- ── 1. shared helper functions ──────────────────────────────────────────────
create or replace function public.ops_set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- Append-only guard: any UPDATE or DELETE on a table using this trigger raises.
create or replace function public.ops_block_mutations()
returns trigger language plpgsql as $$
begin
  raise exception 'append-only table %: UPDATE/DELETE is not permitted', tg_table_name;
end;
$$;

-- ── 2. mutable top-level tables (one row per record) ────────────────────────
create table if not exists public.ops_users (
  id         text primary key,
  data       jsonb not null,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists public.ops_admins (
  id         text primary key,
  data       jsonb not null,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- Clients are NEVER deleted — only Active/Inactive. Inactive rows stay in the
-- DB and just drop out of the default view.
create table if not exists public.ops_clients (
  id         text primary key,
  status     text not null default 'active' check (status in ('active','inactive')),
  data       jsonb not null,
  updated_at timestamptz not null default now()
);
create index if not exists idx_ops_clients_status on public.ops_clients(status);

create table if not exists public.ops_goals (
  id         text primary key,
  data       jsonb not null,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists public.ops_roadmap_tasks (
  id         text primary key,
  data       jsonb not null,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists public.ops_org_nodes (
  id         text primary key,
  data       jsonb not null,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists public.ops_org_links (
  id         text primary key,   -- synthesized as "<from>_<to>"
  data       jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.ops_time_off_requests (
  id         text primary key,
  data       jsonb not null,     -- status updates (approve/deny) allowed
  updated_at timestamptz not null default now()
);

create table if not exists public.ops_messages (
  id         text primary key,
  data       jsonb not null,
  created_at timestamptz not null default now()
);

-- Key/value singletons: announcement, coc, settings, otPolicy, primaryAdminPw,
-- orgExcluded, orgLayoutVersion.
create table if not exists public.ops_settings (
  key        text primary key,
  data       jsonb,
  updated_at timestamptz not null default now()
);

-- Explicit user tombstones (mirrors wl_deleted_user_ids). Users are removed from
-- the active set ONLY when their id is recorded here.
create table if not exists public.ops_deleted_user_ids (
  user_id    text primary key,
  deleted_at timestamptz not null default now()
);

-- ── 3. append-only tables (INSERT only; UPDATE/DELETE blocked by trigger) ───
create table if not exists public.ops_feed (
  id         text primary key,
  data       jsonb not null,
  created_at timestamptz not null default now()
);

create table if not exists public.ops_time_off_ledger (
  id         text primary key,
  data       jsonb not null,
  created_at timestamptz not null default now()
);

-- ── 4. per-client period summaries (admin-only; append-OR-update) ───────────
-- One summary per (client, kind, period). `data` holds the auto-compiled
-- progress AND the admin's editable notes, e.g.
--   { "progress": { ... compiled from tracker updates ... }, "notes": "..." }
-- Regenerating progress for a period upserts on the PK and PRESERVES notes
-- (the endpoint merges, never blanks notes). Reads are restricted to admins by
-- the server endpoint (the data never reaches a non-admin browser).
create table if not exists public.ops_summaries (
  client_id  text not null,
  kind       text not null check (kind in ('weekly','monthly','yearly')),
  period_key text not null,                 -- e.g. '2026-W26', '2026-06', '2026'
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (client_id, kind, period_key)
);
create index if not exists idx_ops_summaries_period on public.ops_summaries(kind, period_key);

-- ── 5. updated_at triggers on mutable tables ────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array[
    'ops_users','ops_admins','ops_clients','ops_goals','ops_roadmap_tasks',
    'ops_org_nodes','ops_org_links','ops_time_off_requests','ops_settings',
    'ops_summaries'
  ] loop
    execute format('drop trigger if exists %I_set_updated_at on public.%I', t, t);
    execute format(
      'create trigger %I_set_updated_at before update on public.%I for each row execute procedure public.ops_set_updated_at()',
      t, t);
  end loop;
end $$;

-- ── 6. append-only triggers (block UPDATE/DELETE) ───────────────────────────
do $$
declare t text;
begin
  foreach t in array array['ops_feed','ops_time_off_ledger'] loop
    execute format('drop trigger if exists %I_block_mutations on public.%I', t, t);
    execute format(
      'create trigger %I_block_mutations before update or delete on public.%I for each row execute procedure public.ops_block_mutations()',
      t, t);
  end loop;
end $$;

-- ── 7. Row Level Security: ENABLE on every table, NO policies ────────────────
-- Effect: anon/authenticated (the browser) get zero access; only the
-- service-role key (used server-side) bypasses RLS.
do $$
declare t text;
begin
  foreach t in array array[
    'ops_users','ops_admins','ops_clients','ops_goals','ops_roadmap_tasks',
    'ops_org_nodes','ops_org_links','ops_time_off_requests','ops_messages',
    'ops_settings','ops_deleted_user_ids','ops_feed','ops_time_off_ledger',
    'ops_summaries'
  ] loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

-- (No GRANTs to anon/authenticated and no policies are created, so those roles
--  cannot read or write any of these tables. The service role bypasses RLS, and
--  the table owner — i.e. you in the dashboard SQL editor — can still inspect
--  the data. `force` is intentionally NOT used so your dashboard access works.)
