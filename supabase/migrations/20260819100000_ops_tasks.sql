-- ============================================================================
-- ops_tasks — Task Assignments (admin) + Daily Tasks (employee)
-- ----------------------------------------------------------------------------
-- Port of the standalone WebLight Media Email Tracker into Ops Hub. Same
-- document-model convention as every other ops_* table: `id text primary
-- key, data jsonb not null` — the full task shape (subject, notes, tags,
-- clientId/clientName, assigneeId/assignedById, category, type, priority,
-- status, dueDate, source, origin, email-only fields when
-- source='parsed-email') lives entirely in `data`, nothing bespoke at the
-- column level. A plain mutable table (not append-only) — admins can edit
-- any field, including reassigning a task to a different employee, exactly
-- like ops_clients/ops_users. RLS enabled, no policies — only the
-- server-side service-role key (used from api/ops-sync.js and
-- api/ops-state.js) can read/write, same as every other ops_* table.
-- ============================================================================

create table if not exists public.ops_tasks (
  id         text primary key,
  data       jsonb not null,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

drop trigger if exists ops_tasks_set_updated_at on public.ops_tasks;
create trigger ops_tasks_set_updated_at
  before update on public.ops_tasks
  for each row execute procedure public.ops_set_updated_at();

alter table public.ops_tasks enable row level security;
