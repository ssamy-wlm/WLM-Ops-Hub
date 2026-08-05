-- ============================================================================
-- Error log archive — narrow the append-only exception to archived_at only
-- ----------------------------------------------------------------------------
-- 20260730093000_ops_error_log_archive.sql added the archived_at column and
-- then dropped ops_error_log_block_mutations outright so the archive endpoint
-- (api/error-log.js) could set it. That migration was never applied to
-- production — confirmed live: an UPDATE on ops_error_log still raises
-- "append-only table ops_error_log: UPDATE/DELETE is not permitted" — so
-- the archive control in Business Setup currently errors instead of working.
--
-- Rather than assume that prior migration ran (or apply it as written), this
-- migration supersedes it: dropping the trigger entirely, as it did, goes
-- further than intended — it removes ALL DB-level protection from this
-- table, not just for archived_at, leaving the real audit trail (data,
-- created_at) mutable/deletable by anything using the service-role key, with
-- nothing enforcing the "only archived_at, only via this endpoint" intent
-- except application code discipline.
--
-- This migration instead replaces the trigger with a narrower guard that:
--   * still blocks DELETE outright, exactly as the original did
--   * still blocks any UPDATE that touches id, data, or created_at
--   * allows only an UPDATE that changes archived_at (nothing else)
-- The real audit trail (data/created_at) stays exactly as tamper-proof as
-- it always was. Only the soft-archive flag is now mutable.
--
-- Written to be safe to run whether or not 20260730093000 was ever applied —
-- every statement below is idempotent against either starting state.
-- ============================================================================

alter table public.ops_error_log add column if not exists archived_at timestamptz;

create or replace function public.ops_error_log_archive_guard()
returns trigger language plpgsql as $$
begin
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

drop trigger if exists ops_error_log_block_mutations on public.ops_error_log;
create trigger ops_error_log_block_mutations
  before update or delete on public.ops_error_log
  for each row execute procedure public.ops_error_log_archive_guard();
