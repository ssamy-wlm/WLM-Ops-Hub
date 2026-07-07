-- ============================================================================
-- Notification system — assignment / time-off decision / new message
-- ----------------------------------------------------------------------------
-- Rows are created ONLY server-side, inside api/ops-sync.js, at the exact
-- moment the triggering write happens (a service/task assignment, a time-off
-- approve/deny, a new message) — never by a page-load or scheduled scan that
-- diffs old vs new state. Each row is its own record; the notification list
-- is never rewritten wholesale — mark-as-read is a single-row update by id,
-- same append-then-update model as every other mutable ops_* table.
-- Same access model as every other ops_* table: RLS enabled, no policies —
-- only the server-side service-role key (used from api/*.js) can read/write.
-- ============================================================================

create table if not exists public.ops_notifications (
  id         text primary key,
  data       jsonb not null,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

drop trigger if exists ops_notifications_set_updated_at on public.ops_notifications;
create trigger ops_notifications_set_updated_at
  before update on public.ops_notifications
  for each row execute procedure public.ops_set_updated_at();

alter table public.ops_notifications enable row level security;
