// Vercel Cron: bi-monthly PTO report — David's 1st-and-16th digest of
// Jacob, Abby, and Michael's approved time off in the just-completed
// half-month. One of only three email types David still receives after the
// "David email overhaul" ticket (2026-09-25) — see api/ops-sync.js's
// isEmailSuppressedForDavid()/DAVID_EMAIL_ALLOWED_TYPES for the other two
// and the full suppression rationale.
//
// Auth: same CRON_SECRET Bearer-token pattern every other cron endpoint in
// this app already uses (see cron-overdue-check.js's own header comment).
//
// Schedule (2026-09-25 DST correction): vercel.json "0 * 1,16 * *" — runs
// EVERY hour on the 1st and 16th (UTC calendar day — see the note below on
// why that's safe). The actual send only happens when the current moment
// is genuinely 7:00 AM America/New_York LOCAL time on the 1st or 16th,
// checked via lib/quietHours.js's localPartsInTz() (real IANA tz database
// conversion, DST-aware) — every other invocation is a fast, cheap no-op.
// This replaces an earlier version that used a single fixed "0 12 1,16 * *"
// UTC cron matching only EST (UTC-5) — wrong for roughly 8 months of the
// year while the US observes EDT (UTC-4), same class of drift
// cron-weekly-team-completion.js's own header comment documents for its
// equivalent fix. Restricting the vercel.json schedule to UTC days 1/16
// (rather than every hour of every day, all year) is still safe and
// correct: New York is always UTC-4 or UTC-5 (always BEHIND UTC), so 7 AM
// New York time on calendar day N always falls within UTC calendar day N
// too — there's no midnight-boundary case where the target local moment
// could land on a different UTC day than expected.
//
// Window: the 16th's run covers the 1st–15th of the CURRENT month; the
// 1st's run covers the 16th–end of the PRIOR month, per the ticket's own
// spec — computed from the real America/New_York calendar date (ny.year/
// ny.month/ny.day from localPartsInTz()), not a UTC one, so the window
// itself is also correct right at a UTC/local day-boundary edge. A request
// is INCLUDED if its [startDate, endDate] range overlaps the window at
// all (not only if fully contained) — a PTO stretch that starts before or
// ends after the half-month boundary still gets reported, with its own
// real dates shown, rather than silently dropped at the boundary.
// Judgment call, flagged here since the ticket didn't specify
// partial-overlap handling explicitly (same "flagged in the PR description
// for review" precedent cron-work-anniversaries.js's own header comment
// already sets for an unstated judgment call).
//
// "Taken" = status 'approved' only (a pending or denied request was never
// actually PTO taken).
//
// Always sends, every run, even when all three people took zero PTO in
// the period (2026-09-25 correction) — a person with nothing to report
// gets an explicit "No PTO taken during <start> – <end>" line rather than
// being silently omitted or the whole email being skipped. There is no
// "skip if empty" branch anywhere in this file.
//
// Recipient: David only, resolved fresh against the live ops_admins table
// by email — never a hardcoded id, same discipline api/inbound-email.js's
// resolveInboundSender() already established for him.
//
// Jacob/Abby/Michael are resolved by FIRST NAME against the live
// users+admins roster (never a hardcoded id — same "resolve fresh, don't
// guess" discipline as David's own lookup), because the ticket names them
// only by first name and this codebase spans two tables for exactly this
// trio (Jacob and Abby are ops_admins, Michael is ops_users — see
// DECISIONS.md). A first name matching zero or 2+ roster entries is NOT
// guessed at (CLAUDE.md rule #7) — it's called out by name in both the
// report body itself and a logError() entry, rather than silently picking
// one or dropping the person from the report.
//
// Idempotency: read-based, same shape as cron-work-anniversaries.js — a
// 'biMonthlyPtoReport' notification whose context.startDate/endDate
// already match this run's computed window is treated as already sent, so
// a duplicate/retried invocation within the same target hour never
// double-sends.
import { getSupabaseAdmin } from '../lib/supabaseAdmin.js';
import { logError } from '../lib/errorLog.js';
import { localPartsInTz } from '../lib/quietHours.js';
import { insertNotifications, DAVID_EMAIL } from './ops-sync.js';

function dateStr(y, m, d) { return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`; }

// Exported for direct unit testing (CLAUDE.md rule #9) — the pure date-math
// core of this endpoint, with no Supabase/network/timezone dependency.
// Takes already-resolved calendar components (year, month 1-indexed, day)
// — the caller (handler, below) is responsible for resolving those from
// real America/New_York local time; this function itself has no notion of
// "now" or timezones at all, which is what keeps it trivially testable.
// Returns null for any day other than 1/16 — defensive only; the caller's
// own local-time gate already restricts real invocations to those two.
export function computeHalfMonthWindow(year, month, day) {
  if (day === 16) {
    return { startDate: dateStr(year, month, 1), endDate: dateStr(year, month, 15) };
  }
  if (day === 1) {
    const priorYear = month === 1 ? year - 1 : year;
    const priorMonth = month === 1 ? 12 : month - 1;
    const lastDayPriorMonth = new Date(Date.UTC(year, month - 1, 0)).getUTCDate();
    return { startDate: dateStr(priorYear, priorMonth, 16), endDate: dateStr(priorYear, priorMonth, lastDayPriorMonth) };
  }
  return null;
}

const TARGET_FIRST_NAMES = ['Jacob', 'Abby', 'Michael'];
export function firstNameOf(name) { return String(name || '').trim().split(/\s+/)[0].toLowerCase(); }

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  const header = req.headers.authorization || '';
  if (!secret || header !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const ny = localPartsInTz(new Date(), 'America/New_York');
  if ((ny.day !== 1 && ny.day !== 16) || ny.hour !== 7) {
    return res.status(200).json({ ok: true, sent: false, reason: 'not 7:00 AM America/New_York on the 1st or 16th (this hourly invocation is a no-op)' });
  }

  let supabase;
  try { supabase = getSupabaseAdmin(); }
  catch (err) { await logError({ endpoint: 'cron-pto-report', error: err }); return res.status(500).json({ error: err.message }); }

  try {
    const window = computeHalfMonthWindow(ny.year, ny.month, ny.day);

    const { data: existingRows, error: nErr } = await supabase.from('ops_notifications')
      .select('id, data').eq('data->>type', 'biMonthlyPtoReport');
    if (nErr) throw new Error(nErr.message);
    if ((existingRows || []).some(r => r.data?.context?.startDate === window.startDate && r.data?.context?.endDate === window.endDate)) {
      return res.status(200).json({ ok: true, sent: false, reason: 'already sent for this period' });
    }

    const [{ data: userRows, error: uErr }, { data: adminRows, error: aErr }, { data: timeOffRows, error: tErr }] = await Promise.all([
      supabase.from('ops_users').select('id, data'),
      supabase.from('ops_admins').select('id, data'),
      supabase.from('ops_time_off_requests').select('id, data'),
    ]);
    if (uErr) throw new Error(uErr.message);
    if (aErr) throw new Error(aErr.message);
    if (tErr) throw new Error(tErr.message);

    const users = (userRows || []).map(r => ({ id: r.id, ...r.data }));
    const admins = (adminRows || []).map(r => ({ id: r.id, ...r.data }));
    const roster = [...users, ...admins];
    const requests = (timeOffRows || []).map(r => r.data).filter(Boolean);

    const warnings = [];
    // Always one line per target person — never omitted, never skipped,
    // regardless of whether they took any PTO this period (see the header
    // comment's "always sends" note).
    const sections = TARGET_FIRST_NAMES.map(first => {
      const matches = roster.filter(p => firstNameOf(p.name) === first.toLowerCase());
      if (matches.length !== 1) {
        const msg = `PTO report: could not uniquely resolve "${first}" (${matches.length} roster match(es))`;
        warnings.push(msg);
        return `${first}: ${matches.length === 0 ? 'not found in the roster' : `${matches.length} ambiguous roster matches`} this run — check Business Setup's error log.`;
      }
      const person = matches[0];
      const nameLower = String(person.name || '').toLowerCase();
      const items = requests
        .filter(req => req.status === 'approved')
        .filter(req => req.userId === person.id || String(req.userName || '').toLowerCase() === nameLower)
        .filter(req => {
          const start = req.startDate, end = req.endDate || req.startDate;
          if (!start) return false;
          return start <= window.endDate && end >= window.startDate;
        })
        .sort((a, b) => String(a.startDate).localeCompare(String(b.startDate)));
      if (!items.length) return `${person.name}: No PTO taken during ${window.startDate} – ${window.endDate}.`;
      const lines = items.map(req => {
        const range = req.endDate && req.endDate !== req.startDate ? `${req.startDate} – ${req.endDate}` : req.startDate;
        return `  • ${range}${req.reason ? ` — ${req.reason}` : ''}`;
      }).join('\n');
      return `${person.name} (${items.length}):\n${lines}`;
    });

    const david = admins.find(a => String(a.email || '').toLowerCase() === DAVID_EMAIL);
    if (!david) {
      await logError({ endpoint: 'cron-pto-report', error: 'David not found in ops_admins by email — report not sent' });
      return res.status(200).json({ ok: true, sent: false, reason: 'David not resolved' });
    }

    const resolutionWarningCount = warnings.length;

    await insertNotifications(supabase, [{
      type: 'biMonthlyPtoReport', recipientId: david.id, recipientKind: 'admin',
      recipientName: david.name || '', recipientEmail: david.email,
      title: `PTO report — ${window.startDate} to ${window.endDate}`,
      body: sections.join('\n\n'), link: '', context: { startDate: window.startDate, endDate: window.endDate },
    }], warnings, { bypassQuietHours: true });

    // Logged once, after both phases, so a post-insert warning (e.g. the
    // notifications insert itself failing) is never silently dropped —
    // insertNotifications() pushes onto this same `warnings` array rather
    // than throwing.
    if (warnings.length) await logError({ endpoint: 'cron-pto-report', error: warnings.join('; '), extra: { resolutionWarningCount } });

    return res.status(200).json({ ok: true, sent: true, window });
  } catch (err) {
    await logError({ endpoint: 'cron-pto-report', error: err });
    return res.status(500).json({ ok: false, error: err.message });
  }
}
