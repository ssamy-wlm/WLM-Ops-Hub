// Vercel Cron: daily automated data snapshot into ops_backups. Genuinely
// scheduled — not a disguised load-time scan (CLAUDE.md rule #2's banned
// pattern doesn't apply here; this never reads or reacts to anything a
// browser sent, it just reads every table fresh and inserts one new row).
//
// Auth: same CRON_SECRET pattern as api/cron-overdue-check.js — Vercel
// invokes this with `Authorization: Bearer $CRON_SECRET` per the `crons`
// entry in vercel.json. Fails closed if CRON_SECRET isn't configured.
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
