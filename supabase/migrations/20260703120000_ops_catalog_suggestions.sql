-- ============================================================================
-- Service Catalog — member suggestions queue
-- ----------------------------------------------------------------------------
-- Members propose a new service or an edit to an existing one; the proposal
-- lands here as a pending row and does NOT touch the live catalog
-- (public.ops_settings, key 'serviceCatalog') until an admin approves it.
-- Same access model as every other ops_* table: RLS enabled, no policies —
-- only the server-side service-role key (used from api/*.js) can read/write.
-- ============================================================================

create table if not exists public.ops_catalog_suggestions (
  id         text primary key,
  data       jsonb not null,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

drop trigger if exists ops_catalog_suggestions_set_updated_at on public.ops_catalog_suggestions;
create trigger ops_catalog_suggestions_set_updated_at
  before update on public.ops_catalog_suggestions
  for each row execute procedure public.ops_set_updated_at();

alter table public.ops_catalog_suggestions enable row level security;
