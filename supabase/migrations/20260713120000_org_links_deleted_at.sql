-- Adds soft-delete support to ops_org_links, matching the deleted_at
-- column ops_org_nodes already carries. Org chart node/link deletes are
-- never a hard SQL DELETE — see api/ops-sync.js.
alter table public.ops_org_links add column if not exists deleted_at timestamptz;
