// Admin viewer + guarded restore for ops_backups snapshots (daily-auto from
// api/cron-backup.js, or manual — created here). Super Admin/Owner only,
// same tier gate as Import Clients/Error Log/Schema Drift — a full-data
// restore is exactly the kind of high-blast-radius operation CLAUDE.md rule
// #6 reserves for the strictest access band.
//
// GET  (no query)        -> list snapshots: id, kind, created_at, size_bytes
//                            (never the full `data` blob, so listing stays
//                            cheap regardless of how large a snapshot is).
// GET  ?download=<id>     -> that one snapshot's full data, for the
//                            viewer's Download button.
// POST {action:'manual'}  -> creates a kind:'manual' snapshot right now.
// POST {action:'restore-dry-run', id}
//                          -> read-only per-table diff (toRestoreCount,
//                             unchanged, notInSnapshotCount, a capped list
//                             of affected ids) + a reviewToken bound to
//                             that exact diff. Writes nothing.
// POST {action:'restore-confirm', id, reviewToken, confirmPhrase}
//                          -> re-validates confirmPhrase === "RESTORE <id>"
//                             AND re-derives the diff fresh, recomputing the
//                             token and comparing it to reviewToken — if
//                             live data changed since the dry run (so the
//                             token wouldn't recompute the same), this is
//                             refused with 409 rather than acting on a
//                             stale review. Only then does it write.
import { getSupabaseAdmin } from '../lib/supabaseAdmin.js';
import { requireSession, tierOf } from '../lib/opsSession.js';
import { logError } from '../lib/errorLog.js';
import {
  buildBackupSnapshot, insertBackupRow, computeRestoreDiff, computeReviewToken, applyRestore,
} from '../lib/opsBackup.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  let session;
  try { session = await requireSession(req); }
  catch (err) { await logError({ endpoint: 'ops-backups', error: err }); return res.status(500).json({ error: err.message }); }
  if (!session) return res.status(401).json({ error: 'Missing or invalid session' });
  if (tierOf(session) !== 'super') return res.status(403).json({ error: 'Super Admin/Owner only' });

  let supabase;
  try { supabase = getSupabaseAdmin(); }
  catch (err) { await logError({ endpoint: 'ops-backups', error: err, session }); return res.status(500).json({ error: err.message }); }

  if (req.method === 'GET') {
    const downloadId = req.query?.download;
    if (downloadId) {
      const { data: row, error } = await supabase.from('ops_backups').select('id, kind, created_at, data').eq('id', downloadId).maybeSingle();
      if (error) { await logError({ endpoint: 'ops-backups', error, session }); return res.status(500).json({ error: error.message }); }
      if (!row) return res.status(404).json({ error: 'Snapshot not found' });
      return res.status(200).json({ ok: true, snapshot: row });
    }
    const { data: rows, error } = await supabase.from('ops_backups').select('id, kind, created_at, size_bytes').order('created_at', { ascending: false });
    if (error) { await logError({ endpoint: 'ops-backups', error, session }); return res.status(500).json({ error: error.message }); }
    return res.status(200).json({ ok: true, snapshots: rows || [] });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action, id, reviewToken, confirmPhrase } = req.body || {};

  if (action === 'manual') {
    try {
      const { warnings, snapshot } = await buildBackupSnapshot(supabase);
      const newId = await insertBackupRow(supabase, 'manual', snapshot);
      return res.status(200).json({ ok: true, id: newId, tableCounts: snapshot.meta.tableCounts, warnings });
    } catch (err) {
      await logError({ endpoint: 'ops-backups', error: err, session });
      return res.status(500).json({ error: err.message });
    }
  }

  if (action === 'restore-dry-run') {
    if (!id) return res.status(400).json({ error: '"id" is required' });
    const { data: row, error } = await supabase.from('ops_backups').select('id, data').eq('id', id).maybeSingle();
    if (error) { await logError({ endpoint: 'ops-backups', error, session }); return res.status(500).json({ error: error.message }); }
    if (!row) return res.status(404).json({ error: 'Snapshot not found' });
    try {
      const diff = await computeRestoreDiff(supabase, row.data);
      const token = computeReviewToken(id, diff);
      return res.status(200).json({ ok: true, diff, reviewToken: token });
    } catch (err) {
      await logError({ endpoint: 'ops-backups', error: err, session });
      return res.status(500).json({ error: err.message });
    }
  }

  if (action === 'restore-confirm') {
    if (!id || !reviewToken || !confirmPhrase) {
      return res.status(400).json({ error: '"id", "reviewToken", and "confirmPhrase" are all required' });
    }
    if (confirmPhrase !== `RESTORE ${id}`) {
      return res.status(400).json({ error: `Confirmation phrase must be exactly: RESTORE ${id}` });
    }
    const { data: row, error } = await supabase.from('ops_backups').select('id, data').eq('id', id).maybeSingle();
    if (error) { await logError({ endpoint: 'ops-backups', error, session }); return res.status(500).json({ error: error.message }); }
    if (!row) return res.status(404).json({ error: 'Snapshot not found' });
    try {
      // Recompute the diff FRESH, right now — never trust the diff the
      // browser is holding from an earlier dry-run call. If live data has
      // changed since that dry run, this recomputed token will not match
      // the one the browser is echoing back, and the restore is refused.
      const freshDiff = await computeRestoreDiff(supabase, row.data);
      const freshToken = computeReviewToken(id, freshDiff);
      if (freshToken !== reviewToken) {
        return res.status(409).json({ error: 'Live data has changed since your dry run — please run the dry run again before confirming.' });
      }
      const results = await applyRestore(supabase, row.data);
      return res.status(200).json({ ok: true, results });
    } catch (err) {
      await logError({ endpoint: 'ops-backups', error: err, session });
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(400).json({ error: `Unknown action: ${action}` });
}
