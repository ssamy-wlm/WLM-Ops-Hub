-- ============================================================================
-- Session activity — append-only capture for "time in app" (later dashboard
-- PR builds on this; this migration/PR only creates the capture path).
-- ----------------------------------------------------------------------------
-- Written ONLY by api/session-ping.js, using the service-role key, from a
-- valid signed session — never from the browser directly, never as part of
-- cloudPushAll/dirty-sync, and never touching any other table. Same capture-
-- only shape as ops_error_log: instrumentation, not app data.
--
-- Append-only at the DATABASE level, not just by app-code convention — same
-- ops_block_mutations() trigger already enforcing this on ops_feed/
-- ops_time_off_ledger/ops_error_log (defined in
-- 20260630120000_ops_hub_document_schema.sql), reused here rather than
-- relying on "the endpoint just never calls UPDATE/DELETE." A ping row, once
-- written, cannot be edited or deleted by anything — including a future bug
-- in this same endpoint.
--
-- DELIBERATE deviation from the document-model convention (CLAUDE.md rule
-- #5: every other ops_* table is `id text primary key, data jsonb not null`)
-- — flagged, not silently done. This table uses named columns instead of a
-- jsonb payload because the one thing this table needs to do efficiently is
-- exactly what named columns are for: an index on (user_id, created_at) for
-- the later per-person "time in app" query. No RLS policy is needed for the
-- browser either way, so the document-model's "jsonb payload behind a
-- service-role wall" rationale doesn't apply here the way it does for
-- ops_users/ops_clients/etc.
-- ============================================================================

create table if not exists public.ops_session_activity (
  id          text primary key,
  user_id     text not null,
  user_name   text,
  user_role   text,
  event       text not null check (event in ('start','heartbeat','end')),
  client_ts   timestamptz,
  created_at  timestamptz not null default now()
);

drop trigger if exists ops_session_activity_block_mutations on public.ops_session_activity;
create trigger ops_session_activity_block_mutations
  before update or delete on public.ops_session_activity
  for each row execute procedure public.ops_block_mutations();

alter table public.ops_session_activity enable row level security;

create index if not exists idx_ossa_user_created
  on public.ops_session_activity (user_id, created_at);
