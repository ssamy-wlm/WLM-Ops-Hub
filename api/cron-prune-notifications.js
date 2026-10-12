// Vercel Cron: prunes old, already-read ops_notifications rows so the bell
// reflects recent activity, not an unbounded all-time backlog.
//
// *** FLAGGED FOR REVIEW (CLAUDE.md rule #13) *** — this is a new automated
// write path: a scheduled job that deletes records with no human clicking
// save. Reviewed-and-intended behavior, documented here so the reviewer
// can confirm the deletion boundary before this merges:
//   - ONLY rows with read:true are ever eligible. An unread notification —
//     however old — is NEVER deleted by this job, no matter how long it's
//     sat unread; a person's genuine backlog of things they haven't seen
//     yet must stay visible until they actually read or dismiss it.
//   - A 30-day-since-createdAt cutoff on TOP of read:true (both must hold).
//   - This endpoint only ever runs on this own schedule (vercel.json,
//     daily) — never on a page load or client timer (CLAUDE.md rule #2).
//
// Reported bug this addresses: ops_notifications accumulates unbounded
// (one real account: 68 taskAssignment + 41 taskReminder + 31 focusDigest
// rows, going back to whenever that account was created) with no retention
// policy at all — every one of those rows ships down through
// /api/ops-state on every single pull, forever. This doesn't change
// mark-as-read persistence (that was PR #450/#455's fix, confirmed intact
// — see DECISIONS.md) or notification creation (already correctly
// deduped: fireOpsTaskAssignmentNotifications() only ever fires on a real
// assigneeChanged() transition, never a resave) — this is purely
// retention hygiene for what accumulates legitimately over time.
//
// Auth: same CRON_SECRET Bearer-token pattern every other cron endpoint in
// this app already uses.
//
// Idempotency: trivially so — re-running finds nothing newly eligible
// beyond whatever has aged into the window since the last run, and
// deleting an already-deleted id is simply a no-op match.
import { getSupabaseAdmin } from '../lib/supabaseAdmin.js';
import { logError } from '../lib/errorLog.js';

const RETENTION_DAYS = 30;

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  const header = req.headers.authorization || '';
  if (!secret || header !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  let supabase;
  try { supabase = getSupabaseAdmin(); }
  catch (err) { await logError({ endpoint: 'cron-prune-notifications', error: err }); return res.status(500).json({ error: err.message }); }

  try {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();

    const { data: rows, error: selErr } = await supabase.from('ops_notifications').select('id, data');
    if (selErr) throw new Error(selErr.message);

    const staleIds = (rows || [])
      .filter(r => r.data?.read === true && typeof r.data?.createdAt === 'string' && r.data.createdAt < cutoff)
      .map(r => r.id);

    if (!staleIds.length) {
      return res.status(200).json({ ok: true, pruned: 0 });
    }

    const { error: delErr } = await supabase.from('ops_notifications').delete().in('id', staleIds);
    if (delErr) throw new Error(delErr.message);

    return res.status(200).json({ ok: true, pruned: staleIds.length });
  } catch (err) {
    await logError({ endpoint: 'cron-prune-notifications', error: err });
    return res.status(500).json({ error: err.message });
  }
}
