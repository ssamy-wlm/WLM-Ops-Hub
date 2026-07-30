-- ============================================================================
-- Error log cleanup — loosens the append-only guarantee on ops_error_log ONLY
-- ----------------------------------------------------------------------------
-- ops_error_log was built fully append-only (see 20260707150000_ops_error_log.sql)
-- specifically so nothing — including the admin viewer — could edit or delete
-- a log entry. A real gap surfaced: a single already-fixed bug's ~525 log rows
-- bury new, actionable errors under stale noise, with no way to clear them.
--
-- This adds a narrow, admin-triggered, reversible exception: a nullable
-- archived_at column, plus dropping the block-mutations trigger for this one
-- table so the new admin-only endpoint (api/error-log.js, POST action) can
-- set archived_at on old rows. Nothing else changes:
--   * ops_feed and ops_time_off_ledger keep their own append-only triggers —
--     this migration touches ops_error_log exclusively.
--   * The failure CAPTURE itself (lib/errorLog.js) is untouched and remains
--     purely additive (INSERT only) — this migration only enables an
--     explicit, manually-triggered archive action, never automatic.
--   * Archiving is a soft flag (archived_at), never a hard DELETE — an
--     archived row is still queryable/recoverable, matching this codebase's
--     general reversible cancel/archive pattern (rule #6, CLAUDE.md).
-- ============================================================================

alter table public.ops_error_log add column if not exists archived_at timestamptz;

drop trigger if exists ops_error_log_block_mutations on public.ops_error_log;
