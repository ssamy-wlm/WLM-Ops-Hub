-- ============================================================================
-- Payroll — durable, append-only, synced saved-week records
-- ----------------------------------------------------------------------------
-- DRAFT — NOT YET APPLIED. Per CLAUDE.md rule #12, this may not be merged
-- until confirmed applied against the live Supabase project and the Business
-- Setup schema-drift panel shows 0 pending. Per the PAYROLL — MASTER PLAN
-- (2026-08-19), the DB side (this file + seeding the 4 recovered totals) is
-- applied directly against Supabase, coordinated to land with the app-code
-- PR that wires index.html/api/ops-sync.js/api/ops-state.js to this table —
-- no orphan table, no orphan write path.
--
-- Replaces the previous localStorage-only `wl_saved_payrolls` array in
-- index.html, which was never synced to Supabase and had no server copy —
-- the root cause of the payroll history loss this migration follows up on.
-- One row per saved payroll-week record (never one row per employee-week
-- merged together): a team-wide save and a later single-member correction
-- for the same week are always two separate rows, matching the existing
-- app-level fix (commit f8075e23) that made `savePayrollWeek()` append-only.
--
-- Append-only at the DATABASE level, not just by app-code convention — a
-- dedicated, ISOLATED guard function (ops_payroll_guard, not the shared
-- ops_block_mutations() used by ops_feed/ops_time_off_ledger, and not
-- ops_error_log_archive_guard's narrower archived_at carve-out either) so
-- this table's blast radius stays fully contained: a bug affecting this
-- guard can never weaken any other table's tamper-proofing, and vice versa.
-- Blocks ALL UPDATE and DELETE unconditionally — no carve-out, unlike
-- ops_error_log's archived_at exception, because payroll has no "archive"
-- concept: a mistaken save is corrected by a new record, never edited.
-- No updated_at column — an append-only row is never updated, so there is
-- nothing for one to track (same reasoning ops_time_off_ledger/
-- ops_error_log already apply).
--
-- Same access model as every other ops_* table: RLS enabled, no policies —
-- only the server-side service-role key (used from api/*.js) can read/write.
-- Read/write access is gated in code (api/ops-state.js, api/ops-sync.js) to
-- tier==='super' only, same as every other payroll/pay-rate field in this
-- app — no schema-level access control needed here.
-- ============================================================================

create table if not exists public.ops_payroll (
  id         text primary key,
  data       jsonb not null,
  created_at timestamptz not null default now()
);

create or replace function public.ops_payroll_guard()
returns trigger language plpgsql as $$
begin
  raise exception 'append-only table ops_payroll: UPDATE/DELETE is not permitted';
end;
$$;

drop trigger if exists ops_payroll_block_mutations on public.ops_payroll;
create trigger ops_payroll_block_mutations
  before update or delete on public.ops_payroll
  for each row execute procedure public.ops_payroll_guard();

alter table public.ops_payroll enable row level security;
