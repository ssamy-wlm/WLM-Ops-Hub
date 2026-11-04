-- ============================================================================
-- Automatic pruning for the four disposable log tables
-- ----------------------------------------------------------------------------
-- ops_session_activity, ops_feed, ops_error_log, and ops_notifications all
-- accumulate rows with no retention policy — a one-time manual purge already
-- ran against production (outside this migration, by hand) to clear the
-- existing backlog; this migration is what stops it from recurring.
--
-- Three of the four are append-only at the DATABASE level, not just by
-- app-code convention:
--   * ops_feed, ops_session_activity          -> ops_block_mutations()
--   * ops_error_log                           -> ops_error_log_archive_guard()
-- Those guards are NOT weakened or removed here. Instead, both guard
-- functions get a single, narrow, sanctioned bypass: they only ever permit
-- the mutation they'd otherwise block when the current transaction has set
-- current_setting('ops.allow_prune', true) = 'on'. 'ops.allow_prune' is a
-- placeholder GUC (never predefined in postgresql.conf — current_setting's
-- second arg, missing_ok=true, means it reads as NULL, never an error, for
-- every ordinary transaction that never sets it). This keeps ONE enforcement
-- point (the trigger itself still fires and still judges every mutation)
-- instead of the alternative of disabling/dropping the trigger around the
-- prune job, which would remove DB-level protection for the whole duration
-- of that job with nothing left enforcing it if the job's own SQL ever had
-- a bug.
--
-- ops_prune_logs() is the ONLY place that ever sets this flag, and it sets
-- it with SET LOCAL semantics (set_config(..., is_local := true)) — the
-- setting reverts automatically at the end of its own transaction, so it
-- can never leak into a later, unrelated statement on the same connection/
-- session (relevant since pg_cron and connection poolers can reuse
-- sessions). ops_notifications has no append-only guard at all (mark-as-
-- read is a normal UPDATE already) — its own deletion needs no bypass.
--
-- Retention windows (per the explicit instruction this migration implements):
--   * ops_session_activity : created_at older than 7 days
--   * ops_feed             : created_at older than 45 days, OR a 'nav'/
--                            'login' event of any age (those two event
--                            types are also stopped at the source in this
--                            same change — see index.html/user.html's
--                            logActivity() call-site removals — so this
--                            OR-branch only ever cleans up what already
--                            exists from before that source change, plus
--                            closes the gap for any future 'nav'/'login'
--                            row by anything that doesn't go through the
--                            changed call sites)
--   * ops_error_log        : created_at older than 30 days
--   * ops_notifications    : read AND older than 3 days (read is stored as
--                            data->>'read' — checked against the exact
--                            string forms this app's own JSON serialization
--                            can produce: 'true'/'1'/'t')
--
-- NOTE on ops_notifications specifically, flagged rather than silently
-- left ambiguous (rule #7): api/cron-prune-notifications.js + its
-- vercel.json entry already prune this same table (read:true AND older
-- than 30 days, via the service-role key over the API, on its own daily
-- Vercel cron — no append-only guard to bypass there since none exists on
-- this table). This migration's 3-day window is strictly tighter, so once
-- it starts running weekly, nothing will ever survive to 30 days old for
-- that older job to find — it becomes a harmless, always-empty no-op
-- rather than broken, but it is now effectively dead weight. Deliberately
-- NOT removed here (every other prior change in this codebase's history
-- has kept one feature per PR) — a separate, explicit decision.
--
-- pg_cron scheduling: Supabase's hosted pg_cron evaluates its schedule in
-- the database's own timezone, which is UTC — there is no per-job
-- timezone parameter. "Sundays 4am ET" is only exactly correct for one of
-- the two US Eastern offsets at a time (see CLAUDE.md's own "Cron /
-- utcHour lockstep" lesson for the general shape of this problem with
-- Vercel's crons, which has the identical root cause and the identical
-- fix-cost: nobody has wired real DST-aware time-zone math into a cron
-- schedule string here). 09:00 UTC = 4:00 AM EST (correct from early
-- November to mid-March) / 5:00 AM EDT (one hour late the rest of the
-- year) — picked deliberately since this is a low-stakes weekly
-- maintenance job where "within about an hour of 4am ET" is good enough,
-- not something worth adding real timezone-aware gating logic for.
-- cron.schedule() with a job name that already exists updates that job's
-- schedule/command in place rather than erroring or duplicating it — this
-- migration is safe to re-run. (Documented from pg_cron's own upsert-by-
-- name behavior; not independently verified against this project's live
-- database, since this agent has no live Supabase access — see CLAUDE.md
-- rule #11. Dry-run the prune counts on the Vercel preview, and confirm
-- `select * from cron.job where jobname='ops-prune-logs';` shows exactly
-- one row after this applies, before merging.)
-- ============================================================================

create extension if not exists pg_cron;

-- ── 1. Sanctioned bypass on the two append-only-guard functions ───────────

create or replace function public.ops_block_mutations()
returns trigger language plpgsql
set search_path = public, pg_catalog
as $$
begin
  if current_setting('ops.allow_prune', true) = 'on' then
    return coalesce(new, old);
  end if;
  raise exception 'append-only table %: UPDATE/DELETE is not permitted', tg_table_name;
end;
$$;

create or replace function public.ops_error_log_archive_guard()
returns trigger language plpgsql
set search_path = public, pg_catalog
as $$
begin
  if current_setting('ops.allow_prune', true) = 'on' then
    return coalesce(new, old);
  end if;
  if tg_op = 'DELETE' then
    raise exception 'append-only table ops_error_log: DELETE is not permitted';
  end if;
  if new.id is distinct from old.id
     or new.data is distinct from old.data
     or new.created_at is distinct from old.created_at then
    raise exception 'append-only table ops_error_log: only archived_at may be updated';
  end if;
  return new;
end;
$$;

-- ── 2. The one function allowed to flip the bypass, and nothing else ──────

create or replace function public.ops_prune_logs()
returns void language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  perform set_config('ops.allow_prune', 'on', true); -- true = SET LOCAL semantics, reverts at end of this transaction

  delete from public.ops_session_activity
    where created_at < now() - interval '7 days';

  delete from public.ops_feed
    where created_at < now() - interval '45 days'
       or coalesce(data->>'type', data->>'kind', '') in ('nav', 'login');

  delete from public.ops_error_log
    where created_at < now() - interval '30 days';

  delete from public.ops_notifications
    where (data->>'read') in ('true', '1', 't')
      and created_at < now() - interval '3 days';
end;
$$;

comment on function public.ops_prune_logs() is
  'Weekly retention sweep for ops_session_activity/ops_feed/ops_error_log/ops_notifications. Scheduled via pg_cron (job name: ops-prune-logs). See migration 20261104120000_ops_prune_logs.sql for the full rationale.';

-- Runs as this function's OWNER (SECURITY DEFINER), so the caller only ever
-- needs EXECUTE — not direct DELETE grants on any of the four tables.
-- pg_cron jobs on Supabase run as the role that scheduled them (postgres),
-- which already has this privilege as the function's owner; this grant is
-- what lets any other already-trusted role invoke it too, without widening
-- who can delete from these tables directly.
grant execute on function public.ops_prune_logs() to postgres;

-- ── 3. Weekly schedule ──────────────────────────────────────────────────────

select cron.schedule(
  'ops-prune-logs',
  '0 9 * * 0',
  $$select public.ops_prune_logs();$$
);
