-- ops_task_seen — per-user "I've seen this task" acknowledgement, server-synced so the
-- employee "N new assigned" badge is identical on every device instead of living in each
-- browser's localStorage (wl_dt_seen_ids).
--
-- Insert-only, instrumentation-style — same discipline as ops_session_activity: written ONLY by
-- api/ops-task-seen.js with the service-role key from a verified session; read per-user in
-- api/ops-state.js. Never participates in cloudPushAll/dirty-sync; never touches ops_tasks or any
-- app-data table. Once a (user, task) row exists it can never be updated or deleted — enforced by
-- the shared ops_block_mutations() trigger (same guard on ops_feed/ops_error_log/
-- ops_session_activity) so no bug here can ever mutate or wipe data. Purely additive: touches zero
-- existing tables/rows.
--
-- DELIBERATE deviation from the document-model (CLAUDE.md rule #5: id text pk + data jsonb) —
-- flagged, not silent — same rationale as ops_session_activity: a per-user capture keyed for an
-- efficient (user_id, task_id) lookup, not editable app data, so named columns + a composite PK
-- fit better than a jsonb payload. The composite PK gives idempotent inserts and serves the
-- per-user read with no extra index.

create table if not exists public.ops_task_seen (
  user_id  text not null,
  task_id  text not null,
  seen_at  timestamptz not null default now(),
  primary key (user_id, task_id)
);

drop trigger if exists ops_task_seen_block_mutations on public.ops_task_seen;
create trigger ops_task_seen_block_mutations
  before update or delete on public.ops_task_seen
  for each row execute procedure public.ops_block_mutations();

alter table public.ops_task_seen enable row level security;
