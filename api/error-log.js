// Admin-only error log viewer (Business Setup tab) — Super Admin/CEO only,
// same tier gate as business settings/org chart/roadmap.
//
// GET: read-only fetch, unchanged in spirit — nothing here writes.
// POST: the ONE narrow, manually-triggered exception to this table's
// append-only design (see supabase/migrations/20260730093000_ops_error_log_archive.sql).
// Hard-scoped to ops_error_log — the table name below is a literal string,
// never influenced by the request body, and no other table is ever touched
// here. Archiving is a soft flag (archived_at), never a hard DELETE, so a
// cleanup is always reversible. Every write requires a fresh cutoff-count
// dry run (action:'preview') before the real action:'archive' — the client
// shows that count to the admin and requires an explicit confirm before
// calling archive, same "review before you commit" shape as every other
// destructive control in this app (CLAUDE.md rule #6), scaled to this
// table's much lower blast radius (a diagnostic log, reversible, not
// client/user/business data).
import { getSupabaseAdmin } from '../lib/supabaseAdmin.js';
import { requireSession, tierOf } from '../lib/opsSession.js';
import { logError } from '../lib/errorLog.js';

const TABLE = 'ops_error_log';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let session;
  try { session = await requireSession(req); }
  catch (err) { await logError({ endpoint: 'error-log', error: err }); return res.status(500).json({ error: err.message }); }
  if (!session) return res.status(401).json({ error: 'Missing or invalid session' });
  if (tierOf(session) !== 'super') return res.status(403).json({ error: 'Super Admin/Owner only' });

  let supabase;
  try { supabase = getSupabaseAdmin(); }
  catch (err) { await logError({ endpoint: 'error-log', error: err, session }); return res.status(500).json({ error: err.message }); }

  if (req.method === 'GET') {
    try {
      const { data, error } = await supabase
        .from(TABLE)
        .select('id, data, created_at, archived_at')
        .order('created_at', { ascending: false })
        .limit(100);
      if (error) { await logError({ endpoint: 'error-log', error, session }); return res.status(500).json({ error: error.message }); }

      const entries = (data || []).map(r => ({ id: r.id, createdAt: r.created_at, archivedAt: r.archived_at, ...r.data }));
      return res.status(200).json({ entries });
    } catch (err) {
      await logError({ endpoint: 'error-log', error: err, session });
      return res.status(500).json({ error: err.message || 'Failed to read error log' });
    }
  }

  // POST — preview or archive, gated to Super Admin/Owner (already checked
  // above), scoped hard to TABLE ('ops_error_log') regardless of anything in
  // the body.
  const { action, cutoffDate } = req.body || {};
  if (action !== 'preview' && action !== 'archive') return res.status(400).json({ error: 'action must be "preview" or "archive"' });
  const cutoff = new Date(cutoffDate);
  if (!cutoffDate || Number.isNaN(cutoff.getTime())) return res.status(400).json({ error: 'cutoffDate is required and must be a valid date' });
  const cutoffIso = cutoff.toISOString();

  try {
    if (action === 'preview') {
      const { count, error } = await supabase
        .from(TABLE)
        .select('id', { count: 'exact', head: true })
        .lt('created_at', cutoffIso)
        .is('archived_at', null);
      if (error) { await logError({ endpoint: 'error-log', error, session }); return res.status(500).json({ error: error.message }); }
      return res.status(200).json({ count: count ?? 0, cutoffDate: cutoffIso });
    }

    // action === 'archive' — soft-flag rows older than cutoff, never a
    // hard delete, never touching any table but ops_error_log.
    const nowIso = new Date().toISOString();
    const { data: archived, error } = await supabase
      .from(TABLE)
      .update({ archived_at: nowIso })
      .lt('created_at', cutoffIso)
      .is('archived_at', null)
      .select('id');
    if (error) { await logError({ endpoint: 'error-log', error, session }); return res.status(500).json({ error: error.message }); }
    return res.status(200).json({ archivedCount: (archived || []).length, cutoffDate: cutoffIso });
  } catch (err) {
    await logError({ endpoint: 'error-log', error: err, session });
    return res.status(500).json({ error: err.message || 'Failed to archive error log entries' });
  }
}
