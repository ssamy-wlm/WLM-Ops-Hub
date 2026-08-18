// Daily automated data snapshot into ops_backups. Genuinely a scheduled-job
// shape — not a disguised load-time scan (CLAUDE.md rule #2's banned pattern
// doesn't apply here; this never reads or reacts to anything a browser sent,
// it just reads every table fresh and inserts one new row) — but NOT wired
// into vercel.json's `crons` list: the Vercel plan this app runs on caps the
// number of scheduled crons at one, and api/cron-overdue-check.js already
// holds that slot, so it calls this same logic (buildBackupSnapshot /
// insertBackupRow / pruneOldDailyBackups from lib/opsBackup.js) directly at
// the end of its own run instead. This endpoint is left in place, unchanged,
// as a normal CRON_SECRET-gated HTTP endpoint — still directly callable
// (e.g. `curl -H "Authorization: Bearer $CRON_SECRET" .../api/cron-backup`)
// for a manual backfill or one-off snapshot outside the daily schedule.
//
// Auth: same CRON_SECRET pattern as api/cron-overdue-check.js — fails closed
// if CRON_SECRET isn't configured, whether the caller is Vercel Cron or a
// manual request.
//
// Writes: exactly one INSERT into ops_backups (never touches any other
// table's data), plus the retention trim, which only ever DELETEs
// kind='daily-auto' rows beyond the most recent ~30 — the DB-level guard
// trigger (see the migration) refuses anything else regardless of what
// this code does.
import { getSupabaseAdmin } from '../lib/supabaseAdmin.js';
import { logError } from '../lib/errorLog.js';
import { buildBackupSnapshot, insertBackupRow, pruneOldDailyBackups } from '../lib/opsBackup.js';

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  const header = req.headers.authorization || '';
  if (!secret || header !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  let supabase;
  try { supabase = getSupabaseAdmin(); }
  catch (err) { await logError({ endpoint: 'cron-backup', error: err }); return res.status(500).json({ error: err.message }); }

  try {
    const { warnings, snapshot } = await buildBackupSnapshot(supabase);
    const id = await insertBackupRow(supabase, 'daily-auto', snapshot);
    const prune = await pruneOldDailyBackups(supabase, 30);
    if (warnings.length) {
      await logError({ endpoint: 'cron-backup', error: `snapshot completed with ${warnings.length} table warning(s)`, extra: { warnings } });
    }
    return res.status(200).json({
      ok: true, id, tableCounts: snapshot.meta.tableCounts, warnings, trimmed: prune.trimmed, pruneError: prune.error || null,
    });
  } catch (err) {
    await logError({ endpoint: 'cron-backup', error: err });
    return res.status(500).json({ error: err.message });
  }
}
