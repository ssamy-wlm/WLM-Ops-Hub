-- ============================================================================
-- Payroll — durable, synced saved-week records
-- ----------------------------------------------------------------------------
-- DRAFT — NOT YET APPLIED. Per CLAUDE.md rule #12, this may not be merged
-- until confirmed applied against the live Supabase project and the Business
-- Setup schema-drift panel shows 0 pending. Written now for review as part of
-- the payroll data-loss investigation (2026-08-18) — the write path in
-- index.html has not been changed to use this table yet.
--
-- Replaces the previous localStorage-only `wl_saved_payrolls` array in
-- index.html, which was never synced to Supabase and had no server copy —
-- the root cause of the payroll history loss this migration follows up on.
-- One row per saved payroll-week record (never one row per employee-week
-- merged together): a team-wide save and a later single-member correction
-- for the same week are always two separate rows, matching the existing
-- app-level fix (commit f8075e23) that made `savePayrollWeek()` append-only.
-- No delete anywhere in this feature: a mistaken save is corrected by a new
-- record, same convention as ops_time_off_ledger's reversing entries — so
-- deliberately no deleted_at column here.
-- Same access model as every other ops_* table: RLS enabled, no policies —
-- only the server-side service-role key (used from api/*.js) can read/write.
-- Read/write access is gated in code (api/ops-state.js, api/ops-sync.js) to
-- tier==='super' only, same as every other payroll/pay-rate field in this
-- app — no schema-level access control needed here.
-- ============================================================================

create table if not exists public.ops_payroll (
  id         text primary key,
  data       jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists ops_payroll_set_updated_at on public.ops_payroll;
create trigger ops_payroll_set_updated_at
  before update on public.ops_payroll
  for each row execute procedure public.ops_set_updated_at();

alter table public.ops_payroll enable row level security;
