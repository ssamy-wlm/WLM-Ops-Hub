-- ============================================================================
-- Durable task-delete tombstones, keyed by STABLE CONTENT, not the random
-- row id (2026-10-20 — "Deleted tasks must stay deleted" fix, Part 2).
-- ----------------------------------------------------------------------------
-- Mirrors ops_deleted_user_ids (20260630120000_ops_hub_document_schema.sql)
-- in spirit — "removed from the active set only when recorded here" — but
-- CANNOT reuse its user_id-as-PK shape: ops_tasks has no deleted_at column
-- and a hard-deleted task's row id (`id text primary key` on ops_tasks) is
-- never reused by whatever re-creates it. A real production incident (2
-- whole-team/imported tasks that kept reappearing after every delete, each
-- time under a BRAND-NEW ops_tasks.id) showed that an id-keyed tombstone
-- structurally cannot catch this class of bug — it can only ever recognize
-- the exact id it was told to forget, and a re-materialization by
-- definition produces a different one.
--
-- `delete_key` is a stable signature computed from content that SURVIVES
-- re-materialization — see api/ops-sync.js's computeTaskDeleteKey() for the
-- exact formula (importBatchId + subject + assigneeId) and why it's
-- deliberately scoped to only tasks that carry an importBatchId (parsed/
-- imported or "Everyone"-committed tasks — the exact class this incident
-- involved): a plain one-off manually-created task has no importBatchId
-- and nothing ever re-derives it from a template, so there is no
-- resurrection risk to tombstone in the first place, and extending this to
-- arbitrary free-form subjects would risk a genuinely unrelated future task
-- colliding on subject text alone.
--
-- Append-only at the DATABASE level (same ops_block_mutations() trigger
-- already enforcing this on ops_feed/ops_time_off_ledger/ops_error_log/
-- ops_session_activity) — a tombstone, once written, can never be edited or
-- deleted, including by a future bug in this same endpoint. Writers use
-- INSERT ... ON CONFLICT (delete_key) DO NOTHING (ignoreDuplicates) so a
-- repeat delete of the same stable content is a harmless no-op, never a
-- unique-constraint error.
--
-- DELIBERATE deviation from the document-model convention (CLAUDE.md rule
-- #5: every other ops_* table is `id text primary key, data jsonb not
-- null`) — flagged, not silently done, same reasoning ops_session_activity
-- already established: the one thing this table needs to do efficiently is
-- look up by delete_key and by task_id, which named columns serve directly.
-- ============================================================================

create table if not exists public.ops_deleted_task_ids (
  delete_key  text primary key,
  task_id     text not null,
  deleted_at  timestamptz not null default now(),
  deleted_by  text
);

drop trigger if exists ops_deleted_task_ids_block_mutations on public.ops_deleted_task_ids;
create trigger ops_deleted_task_ids_block_mutations
  before update or delete on public.ops_deleted_task_ids
  for each row execute procedure public.ops_block_mutations();

alter table public.ops_deleted_task_ids enable row level security;

create index if not exists idx_odti_task_id on public.ops_deleted_task_ids (task_id);
