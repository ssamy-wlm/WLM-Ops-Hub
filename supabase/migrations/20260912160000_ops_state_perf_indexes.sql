-- ============================================================================
-- Performance indexes for the /api/ops-state read-heavy queries
-- ----------------------------------------------------------------------------
-- api/ops-state.js runs three ORDER BY created_at DESC ... LIMIT queries on
-- every single request, against tables that have NO index supporting that
-- order at all (their only index is the `id` primary key): ops_feed is
-- queried this way TWICE (a general 300-row query for Live Feed, and a
-- separate type-scoped 50-row query for Overview's Recent Activity — see
-- api/ops-state.js's own comment on recentClientFeedQ), and ops_notifications
-- once (200-row cap). Without a supporting index, each of these forces a full
-- sequential scan + sort of the ENTIRE table before the LIMIT is applied —
-- and both ops_feed and ops_notifications are append-only-by-nature /
-- monotonically growing (ops_feed specifically is DB-trigger-enforced
-- append-only, see ops_block_mutations() in
-- 20260630120000_ops_hub_document_schema.sql), so this cost only grows with
-- time and usage, never shrinks. This is the leading suspected contributor to
-- intermittent /api/ops-state Gateway Timeouts (investigated read-only,
-- 2026-09-12) — this migration is the first, lowest-risk part of that fix.
--
-- Three indexes:
--   1. ops_feed(created_at desc)                    — supports the general
--      feedQ query (Live Feed, top 300 by recency across all event types).
--   2. ops_feed((data->>'type'), created_at desc)    — supports
--      recentClientFeedQ's exact filter shape:
--      .eq('data->>type','client').neq('data->>user','System')
--        .order('created_at',{ascending:false}).limit(50)
--      A composite on (type, created_at) lets Postgres jump straight to the
--      type='client' rows in created_at order; the NOT-System filter is a
--      row-level check applied after the index narrows to type='client', not
--      something an index can usefully pre-filter on regardless of shape, so
--      it's intentionally not part of the index key.
--   3. ops_notifications(created_at desc)            — supports
--      notificationsQ (top 200 by recency, before the per-recipient filter
--      that already happens in Node).
--
-- CREATE INDEX CONCURRENTLY is used throughout — it takes no exclusive lock
-- that would block reads/writes on these tables while building (unlike a
-- plain CREATE INDEX), appropriate for tables the live app is actively
-- reading/writing every few seconds. This is also WHY this file is written
-- the way it is:
--
--   *** CREATE INDEX CONCURRENTLY CANNOT RUN INSIDE A TRANSACTION BLOCK. ***
--   Run these three statements OUTSIDE of any explicit BEGIN/COMMIT, and if
--   the tool you're using to apply this (a SQL editor, a migration runner)
--   auto-wraps a whole file/session in one transaction, run these three
--   statements ONE AT A TIME instead of pasting the whole file at once — the
--   Supabase Dashboard's SQL Editor does NOT auto-wrap a submitted query in a
--   transaction by default, so pasting this whole file there and running it
--   should work directly; a stricter migration tool may not.
--
-- IF NOT EXISTS makes each statement safe to re-run / re-attempt after a
-- partial failure (e.g. a dropped connection mid-build leaves a Postgres
-- "invalid" index behind under CONCURRENTLY, which IF NOT EXISTS will then
-- correctly skip — see the note at the bottom of this file for how to detect
-- and clean up an invalid index if that happens).
--
-- NOT applied by this agent — no live Supabase/DB access is available from
-- this environment (see CLAUDE.md rule #11). This file is for the DB owner
-- to run by hand against production (Supabase Dashboard → SQL Editor, or
-- `psql` against the direct :5432 connection string — see
-- supabase/MIGRATIONS.md), same as every other migration in this repo today.
-- ============================================================================

create index concurrently if not exists idx_ops_feed_created_at
  on public.ops_feed (created_at desc);

create index concurrently if not exists idx_ops_feed_type_created_at
  on public.ops_feed ((data->>'type'), created_at desc);

create index concurrently if not exists idx_ops_notifications_created_at
  on public.ops_notifications (created_at desc);

-- ── If a CONCURRENTLY build is ever interrupted (e.g. connection dropped
--    mid-build), Postgres can leave an "invalid" index behind that still
--    shows up under the name above but is never used and blocks a plain
--    re-run of the same CREATE INDEX CONCURRENTLY IF NOT EXISTS (it exists,
--    so IF NOT EXISTS skips it, but it's useless). Check for this with:
--
--      select indexrelid::regclass, indisvalid
--      from pg_index
--      where indexrelid::regclass::text in (
--        'idx_ops_feed_created_at', 'idx_ops_feed_type_created_at',
--        'idx_ops_notifications_created_at'
--      );
--
--    If indisvalid is false for any of them, drop it with
--    `DROP INDEX CONCURRENTLY <name>;` and re-run that one CREATE statement.
