-- ============================================================================
-- ops_backups — daily automated + on-demand manual data snapshots
-- ----------------------------------------------------------------------------
-- One row per snapshot. `data` holds the full multi-table JSON blob (see
-- lib/opsBackup.js's buildBackupSnapshot() for the exact shape written by
-- both api/cron-backup.js — the daily Vercel Cron job — and the manual
-- "Create Manual Snapshot" action in Admin Controls). `size_bytes` is
-- computed once at insert time so the admin viewer's list view never has to
-- pull the (potentially large) `data` blob just to show a size column.
--
-- Guard trigger (mirrors the narrow-exception pattern
-- 20260805120000_ops_error_log_archive_guard.sql already established for
-- ops_error_log, adapted to this table's actual need):
--   * UPDATE is always blocked — a snapshot's contents must never be edited
--     in place, no exceptions (unlike error_log's archived_at carve-out,
--     there's no legitimate partial-update case here).
--   * DELETE is blocked UNLESS the row being deleted has kind = 'daily-auto'
--     — this is what lets the daily cron job's retention trim (keep the
--     last ~30 daily-auto rows) actually run, while making a manual
--     snapshot permanently undeletable at the DB level, not just by
--     application-code convention.
-- ============================================================================

create table if not exists public.ops_backups (
  id         text primary key,
  kind       text not null check (kind in ('daily-auto','manual')),
  data       jsonb not null,
  size_bytes integer not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists idx_ops_backups_kind_created_at on public.ops_backups(kind, created_at);

create or replace function public.ops_backups_guard()
returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' then
    raise exception 'ops_backups: a snapshot may never be modified after it is written';
  end if;
  if tg_op = 'DELETE' then
    if old.kind is distinct from 'daily-auto' then
      raise exception 'ops_backups: only a daily-auto snapshot may ever be deleted (retention trim only) — % snapshots are permanent', old.kind;
    end if;
  end if;
  return old;
end;
$$;

drop trigger if exists ops_backups_guard on public.ops_backups;
create trigger ops_backups_guard
  before update or delete on public.ops_backups
  for each row execute procedure public.ops_backups_guard();

alter table public.ops_backups enable row level security;
-- (No policies, no GRANTs to anon/authenticated — same convention as every
--  other ops_* table. Only the service-role key, used server-side in
--  api/cron-backup.js and api/ops-backups.js, can read or write this table.)
