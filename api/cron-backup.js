// Vercel Cron: dedicated off-site + in-DB data snapshot job (2026-09-13).
//
// History: this used to be its own endpoint, then got folded into
// api/cron-overdue-check.js (2026-08-18) because the Vercel Hobby plan this
// app ran on at the time capped both the number of scheduled crons AND the
// total number of serverless functions per project (12) — this app was over
// that function limit, and a second, separately-scheduled cron would have
// exceeded the cron cap too. Now on Vercel Pro (no such caps), the backup
// step is split back out here, on its own, more frequent schedule
// ("0 */6 * * *", every 6 hours — see vercel.json) — cron-overdue-check.js
// goes back to doing only its own (overdue/task-attention/digest/
// escalation) work, untouched by this change.
//
// Auth: same CRON_SECRET Bearer-token pattern every other cron endpoint in
// this app already uses (see cron-overdue-check.js's own header comment) —
// no new secret for this endpoint.
//
// Writes: still just the ops_backups row (via lib/opsBackup.js, unchanged —
// the in-Supabase fast-restore copy this app already relies on for
// api/ops-backups.js's restore flow) plus, new here, one outbound email
// per super-admin recipient carrying the same snapshot as a JSON file
// attachment — an off-site copy that lives outside Supabase entirely, in
// case Supabase itself is ever unavailable when a restore is needed. No
// other table is ever written by this endpoint.
import { getSupabaseAdmin } from '../lib/supabaseAdmin.js';
import { logError, pruneErrorLog } from '../lib/errorLog.js';
import { resolveReportRecipients } from './ops-sync.js';
import { buildBackupSnapshot, insertBackupRow, pruneOldDailyBackups, TABLE_READ_MAX_ATTEMPTS } from '../lib/opsBackup.js';
import { sendResendEmail } from '../lib/resendClient.js';

// Error-log retention window (2026-09-20) — see pruneErrorLog()'s own
// comment in lib/errorLog.js for why this is a soft-archive, not a delete.
const ERROR_LOG_RETENTION_DAYS = 90;

// Retention (tightened 2026-09-13, from 120 to 28): the in-DB copy only ever
// needs to cover a short fast-restore window on this constrained instance —
// the real deep-history safety net is the off-site email copy this same job
// sends every run (below), which is never pruned. 28 = 7 days * 4 runs/day
// at this endpoint's every-6h cadence. Only kind==='daily-auto' rows are
// ever eligible for pruning (pruneOldDailyBackups() in lib/opsBackup.js) —
// a manual snapshot (Admin Controls -> Data Backups -> Create Manual
// Snapshot) is a different `kind` and is never touched by this call, and
// the DB-level ops_backups_guard trigger additionally refuses to DELETE any
// row that isn't kind==='daily-auto' regardless, so a manual snapshot stays
// permanent/undeletable even if this code ever had a bug.
const DAILY_AUTO_KEEP_COUNT = 28;

function pad2(n) { return String(n).padStart(2, '0'); }

// backup-YYYY-MM-DD-HHMM.json, UTC, matching this cron's own UTC schedule.
function backupFilename(now) {
  const y = now.getUTCFullYear();
  const mo = pad2(now.getUTCMonth() + 1);
  const d = pad2(now.getUTCDate());
  const hh = pad2(now.getUTCHours());
  const mm = pad2(now.getUTCMinutes());
  return `backup-${y}-${mo}-${d}-${hh}${mm}.json`;
}

// Not imported from ops-sync.js's own getDirectory() — that helper isn't
// exported (it's memoized per-request via a module-level cache scoped to
// that file's own handler lifecycle) and this endpoint only ever needs the
// admins half of it, to resolve recipients via resolveReportRecipients().
async function loadAdmins(supabase) {
  const { data } = await supabase.from('ops_admins').select('id, data');
  return (data || []).map(r => ({ id: r.id, ...r.data }));
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

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
    const { warnings: backupWarnings, failedTables, complete, snapshot } = await buildBackupSnapshot(supabase);
    const id = await insertBackupRow(supabase, 'daily-auto', snapshot);
    const prune = await pruneOldDailyBackups(supabase, DAILY_AUTO_KEEP_COUNT);
    // Loud, not swallowed: logged with the SPECIFIC tables affected (not
    // just a count), so a real incident can actually be diagnosed from
    // ops_error_log alone rather than needing to pull the snapshot row and
    // eyeball which table counts look suspiciously like zero.
    if (!complete) {
      await logError({ endpoint: 'cron-backup', error: `snapshot INCOMPLETE — ${failedTables.length} table(s) failed to capture after retries: ${failedTables.join(', ')}`, extra: { backupId: id, failedTables, warnings: backupWarnings } });
    }

    // Error-log retention (2026-09-20) — own try/catch, never allowed to
    // affect the backup response above (already succeeded) or the email
    // step below. Piggybacks on this endpoint's existing every-6h schedule
    // rather than a new cron/endpoint, matching this file's own established
    // "housekeeping rides the existing schedule" convention — never runs on
    // page load, capture-side only, touches nothing but ops_error_log (see
    // pruneErrorLog()'s own comment in lib/errorLog.js for why this is a
    // soft-archive, never a hard delete).
    let errorLogPrune = { ok: false, archivedCount: 0 };
    try {
      const result = await pruneErrorLog(supabase, ERROR_LOG_RETENTION_DAYS);
      errorLogPrune = { ok: true, ...result };
    } catch (err) {
      await logError({ endpoint: 'cron-backup:errorLogPrune', error: err });
      errorLogPrune.error = err.message;
    }

    const json = JSON.stringify(snapshot);
    const sizeBytes = Buffer.byteLength(json, 'utf8');
    const now = new Date();
    const filename = backupFilename(now);

    // Off-site email copy — additive, never allowed to fail the backup
    // itself. Recipients resolved dynamically the same way every other
    // "notify the super admins" call site in this codebase already does
    // (resolveReportRecipients(null, admins): the primary-admin sentinel by
    // her literal id, plus every real super/owner admin) — never a
    // hardcoded email address.
    let email = { ok: false, sent: 0, recipients: 0 };
    if (!process.env.RESEND_API_KEY) {
      email.error = 'RESEND_API_KEY not configured — off-site email copy skipped, DB backup unaffected';
      await logError({ endpoint: 'cron-backup:email', error: email.error, extra: { backupId: id } });
    } else {
      try {
        const admins = await loadAdmins(supabase);
        const recipients = resolveReportRecipients(null, admins);
        email.recipients = recipients.length;
        const attachment = { filename, content: Buffer.from(json, 'utf8').toString('base64'), type: 'application/json' };
        const subject = complete
          ? `Ops Hub backup — ${now.toISOString().slice(0, 10)} (${formatBytes(sizeBytes)})`
          : `⚠️ INCOMPLETE Ops Hub backup — ${now.toISOString().slice(0, 10)} — ${failedTables.length} table(s) failed to capture`;
        // A "0" in this list is now unambiguous even without opening the
        // raw snapshot: tableLines only ever lists a table that actually
        // read successfully (even if it genuinely has zero rows); a failed
        // table is called out separately below instead, so a reader can
        // never mistake "failed to capture" for "genuinely empty."
        const tableLines = Object.entries(snapshot.meta.tableCounts)
          .filter(([t]) => !failedTables.includes(t))
          .map(([t, c]) => `${t}: ${c}`).join('\n');
        const incompleteBanner = complete ? '' : (
          `<div style="background:#fff3f3;border:1px solid #e8b4b4;border-radius:8px;padding:12px 14px;margin:0 0 14px;">`
          + `<p style="font-size:13px;font-weight:700;color:#a33;margin:0 0 4px;">⚠️ This backup is INCOMPLETE</p>`
          + `<p style="font-size:12px;color:#a33;margin:0;">Failed to capture (retried ${TABLE_READ_MAX_ATTEMPTS} time(s) each): ${failedTables.join(', ')}</p>`
          + `</div>`
        );
        const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#1a1a1a;">`
          + `<p style="font-size:15px;font-weight:700;margin:0 0 10px;">Ops Hub daily backup</p>`
          + incompleteBanner
          + `<p style="font-size:13px;color:#555;margin:0 0 6px;">Generated: ${now.toISOString()}</p>`
          + `<p style="font-size:13px;color:#555;margin:0 0 14px;">Size: ${formatBytes(sizeBytes)} · Backup ID: ${id}</p>`
          + `<pre style="font-size:12px;background:#f7f7f7;border-radius:8px;padding:12px;white-space:pre-wrap;">${tableLines}</pre>`
          + `<p style="font-size:11px;color:#aaa;margin-top:20px;">Attached as ${filename}. This is an automated off-site copy of the same snapshot already stored in Supabase (ops_backups).</p>`
          + `</div>`;
        let sent = 0;
        for (const r of recipients) {
          const isPrimary = r.id === 'primary-admin';
          const to = isPrimary ? 'ssamy@weblightmedia.com' : (admins.find(a => a.id === r.id)?.email || '');
          if (!to) continue;
          try {
            await sendResendEmail({ to, subject, html, attachments: [attachment] });
            sent++;
          } catch (err) {
            await logError({ endpoint: 'cron-backup:email', error: err, extra: { backupId: id, recipient: to } });
            (email.errors ||= []).push(`${to}: ${err.message}`);
          }
        }
        email.sent = sent;
        email.ok = sent > 0;
      } catch (err) {
        // Anything unexpected while resolving recipients/building the email —
        // still non-fatal to the DB backup, which already succeeded above.
        await logError({ endpoint: 'cron-backup:email', error: err, extra: { backupId: id } });
        email.error = err.message;
      }
    }

    return res.status(200).json({
      ok: true,
      backup: { id, tableCounts: snapshot.meta.tableCounts, complete, failedTables, sizeBytes, warnings: backupWarnings, trimmed: prune.trimmed, pruneError: prune.error || null, keepCount: DAILY_AUTO_KEEP_COUNT },
      email,
      errorLogPrune,
    });
  } catch (err) {
    await logError({ endpoint: 'cron-backup', error: err });
    return res.status(500).json({ ok: false, error: err.message });
  }
}
