-- ============================================================================
-- Error log — read-only failure capture
-- ----------------------------------------------------------------------------
-- Every server endpoint failure and every failed cloud write gets recorded
-- here so problems surface to an admin instead of failing silently. This
-- table is INSERT-ONLY at the database level (same append-only trigger as
-- ops_feed/ops_time_off_ledger) — nothing in the app is allowed to edit or
-- delete a log entry, including the admin viewer, which is read-only by
-- design. Logging itself must never modify app data or block the response
-- it's logging about — see lib/errorLog.js, which always swallows its own
-- failures.
-- Same access model as every other ops_* table: RLS enabled, no policies —
-- only the server-side service-role key (used from api/*.js) can read/write.
-- ============================================================================

create table if not exists public.ops_error_log (
  id         text primary key,
  data       jsonb not null,
  created_at timestamptz not null default now()
);

drop trigger if exists ops_error_log_block_mutations on public.ops_error_log;
create trigger ops_error_log_block_mutations
  before update or delete on public.ops_error_log
  for each row execute procedure public.ops_block_mutations();

alter table public.ops_error_log enable row level security;
