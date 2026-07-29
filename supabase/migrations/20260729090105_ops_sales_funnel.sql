-- ============================================================================
-- Sales Funnel — shared, synced prospect pipeline
-- ----------------------------------------------------------------------------
-- Replaces the previous localStorage-only, per-browser funnel in client.html
-- with a real synced table. No delete anywhere in this feature, including
-- for Super Admin — archive is a plain data.archived boolean, never a row
-- removal, so there is deliberately no deleted_at column here (unlike
-- ops_org_links/ops_catalog_suggestions): an archived row must stay fully
-- readable for the "Show Archived" view, not filtered out of every read the
-- way deleted_at rows are.
-- Same access model as every other ops_* table: RLS enabled, no policies —
-- only the server-side service-role key (used from api/*.js) can read/write.
-- Read/write access itself is gated in code (api/ops-state.js,
-- api/ops-sync.js) on a per-person salesFunnelAccess flag stored inside the
-- existing ops_users/ops_admins data jsonb — no schema change needed there.
-- ============================================================================

create table if not exists public.ops_sales_funnel (
  id         text primary key,
  data       jsonb not null,
  updated_at timestamptz not null default now()
);

drop trigger if exists ops_sales_funnel_set_updated_at on public.ops_sales_funnel;
create trigger ops_sales_funnel_set_updated_at
  before update on public.ops_sales_funnel
  for each row execute procedure public.ops_set_updated_at();

alter table public.ops_sales_funnel enable row level security;
