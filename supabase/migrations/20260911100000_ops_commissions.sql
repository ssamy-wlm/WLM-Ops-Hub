-- ============================================================================
-- ops_commissions — Commissions (Phase 1), Super Admin/Owner only
-- ----------------------------------------------------------------------------
-- Same document-model convention as every other ops_* table: `id text
-- primary key, data jsonb not null` — the full commission-month shape
-- (recipientId, recipientType, recipientName, month, entries[], net-based
-- computedCommission/tier, payoutDate, status, updatedBy/updatedAt) lives
-- entirely in `data`, nothing bespoke at the column level. One row per
-- recipient per month. A plain MUTABLE table (not append-only, no
-- update/delete guard trigger) — a Super Admin can freely edit a month's
-- entries before/after it's finalized, exactly like ops_tasks/ops_clients.
-- Deliberately NOT modeled on ops_payroll/ops_time_off_ledger, both of
-- which are pure append-only audit logs via a DB-level guard trigger —
-- commission entries are editable line items, closer in shape to
-- ops_tasks, so no such guard is installed here.
--
-- RLS enabled, zero policies — only the server-side service-role key (used
-- from api/ops-sync.js and api/ops-state.js) can read/write, same as every
-- other ops_* table. The browser never talks to Supabase directly.
-- ============================================================================

create table if not exists public.ops_commissions (
  id         text primary key,
  data       jsonb not null,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

drop trigger if exists ops_commissions_set_updated_at on public.ops_commissions;
create trigger ops_commissions_set_updated_at
  before update on public.ops_commissions
  for each row execute procedure public.ops_set_updated_at();

alter table public.ops_commissions enable row level security;
-- No policies — matches every other ops_* table's "service-role only" convention.
