-- ============================================================================
-- Client data migration — pre-write backup snapshots
-- ----------------------------------------------------------------------------
-- Durable, server-side safety net for the client-data delete-and-replace
-- import (see api/migrate-client-data.js). A snapshot of every ops_clients
-- row is written here BEFORE any delete/insert runs, independent of whether
-- the admin's browser successfully downloads the same snapshot as a file.
-- Same access model as every other ops_* table: RLS enabled, no policies —
-- only the server-side service-role key (used from api/*.js) can read/write.
-- ============================================================================

create table if not exists public.ops_backups (
  id         text primary key,
  kind       text not null,
  data       jsonb not null,
  created_at timestamptz not null default now()
);

alter table public.ops_backups enable row level security;
