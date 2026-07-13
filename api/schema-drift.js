// Read-only check for pending Supabase migrations (Business Setup tab,
// Super Admin/CEO only — same tier gate as the error log). Never applies
// anything to the database; only reports whether the schema this app's
// server-side code depends on is actually present in the live project.
//
// The two real outages that motivated this (ops_notifications, then
// ops_org_links.deleted_at — see CLAUDE.md) both came from a migration file
// merging without a step guaranteeing it was actually applied to production.
// This is that missing step, made visible instead of discovered via an
// outage.
//
// Deliberately does NOT parse supabase/migrations/*.sql at request time:
// (1) a Vercel serverless function isn't guaranteed to have non-imported
// project files available in its bundle at runtime, and (2) several early
// migration files were abandoned mid-redesign before this app's current
// document-model schema was settled on — 20260629120000_init_realtime_schema.sql
// (public.profiles/clients/tasks — a different, superseded schema entirely)
// and most of 20260629130000_ops_hub_core_schema.sql's tables (ops_services,
// ops_projects, ops_project_users, ops_subprojects, ops_subproject_users,
// ops_tasks, ops_admin_assigned_users, ops_settings_singleton,
// ops_pending_task_notifications — all superseded by
// 20260630120000_ops_hub_document_schema.sql before any api/*.js code ever
// queried them). Checking those would produce permanent, misleading
// "pending" noise for schema nobody needs. Instead, EXPECTED_TABLES/
// EXPECTED_COLUMNS below list exactly the tables/columns api/*.js code
// actually queries today — update this list by hand alongside any future
// migration that adds a new table or bolts a column onto an existing one.
import { getSupabaseAdmin } from '../lib/supabaseAdmin.js';
import { requireSession, tierOf } from '../lib/opsSession.js';
import { logError } from '../lib/errorLog.js';

const EXPECTED_TABLES = [
  { table: 'ops_users', migration: '20260630120000_ops_hub_document_schema.sql' },
  { table: 'ops_admins', migration: '20260630120000_ops_hub_document_schema.sql' },
  { table: 'ops_clients', migration: '20260630120000_ops_hub_document_schema.sql' },
  { table: 'ops_goals', migration: '20260630120000_ops_hub_document_schema.sql' },
  { table: 'ops_feed', migration: '20260630120000_ops_hub_document_schema.sql' },
  { table: 'ops_messages', migration: '20260630120000_ops_hub_document_schema.sql' },
  { table: 'ops_roadmap_tasks', migration: '20260630120000_ops_hub_document_schema.sql' },
  { table: 'ops_time_off_requests', migration: '20260630120000_ops_hub_document_schema.sql' },
  { table: 'ops_time_off_ledger', migration: '20260630120000_ops_hub_document_schema.sql' },
  { table: 'ops_summaries', migration: '20260630120000_ops_hub_document_schema.sql' },
  { table: 'ops_settings', migration: '20260630120000_ops_hub_document_schema.sql' },
  { table: 'ops_deleted_user_ids', migration: '20260630120000_ops_hub_document_schema.sql' },
  { table: 'ops_org_nodes', migration: '20260630120000_ops_hub_document_schema.sql' },
  { table: 'ops_org_links', migration: '20260630120000_ops_hub_document_schema.sql' },
  { table: 'ops_catalog_suggestions', migration: '20260703120000_ops_catalog_suggestions.sql' },
  { table: 'ops_notifications', migration: '20260707140000_ops_notifications.sql' },
  { table: 'ops_error_log', migration: '20260707150000_ops_error_log.sql' },
];

// Columns bolted onto an existing table via a dedicated migration file
// (rather than present in the table's original CREATE) — the specific
// pattern that caused the ops_org_links outage, since a table can exist and
// answer queries for a while without one of these. Skipped if the table
// itself is already flagged missing above, to avoid double-reporting.
const EXPECTED_COLUMNS = [
  { table: 'ops_org_links', column: 'deleted_at', migration: '20260713120000_org_links_deleted_at.sql' },
];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  let session;
  try { session = requireSession(req); }
  catch (err) { await logError({ endpoint: 'schema-drift', error: err }); return res.status(500).json({ error: err.message }); }
  if (!session) return res.status(401).json({ error: 'Missing or invalid session' });
  if (tierOf(session) !== 'super') return res.status(403).json({ error: 'Super Admin/Owner only' });

  let supabase;
  try { supabase = getSupabaseAdmin(); }
  catch (err) { await logError({ endpoint: 'schema-drift', error: err, session }); return res.status(500).json({ error: err.message }); }

  try {
    const missingTables = [];
    for (const item of EXPECTED_TABLES) {
      // head:true — no rows returned, just confirms the table answers a
      // query at all. The cheapest possible existence check.
      const { error } = await supabase.from(item.table).select('*', { count: 'exact', head: true });
      if (error) missingTables.push({ ...item, error: error.message });
    }

    const missingTableNames = new Set(missingTables.map(t => t.table));
    const missingColumns = [];
    for (const item of EXPECTED_COLUMNS) {
      if (missingTableNames.has(item.table)) continue;
      const { error } = await supabase.from(item.table).select(item.column, { head: true });
      if (error) missingColumns.push({ ...item, error: error.message });
    }

    return res.status(200).json({
      pending: missingTables.length + missingColumns.length,
      missingTables,
      missingColumns,
      checkedAt: new Date().toISOString(),
    });
  } catch (err) {
    await logError({ endpoint: 'schema-drift', error: err, session });
    return res.status(500).json({ error: err.message || 'Schema drift check failed' });
  }
}
