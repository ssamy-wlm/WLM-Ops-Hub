// Vercel Cron: monthly "backlinks renewal" reminder to David — urgent,
// forces a check-in (renewed or not), repeats every 3 days until he
// responds, and escalates to Sarah once if he still hasn't acknowledged
// it 3 days after the first send.
//
// Auth: same CRON_SECRET Bearer-token pattern every other cron endpoint in
// this app already uses (see cron-overdue-check.js's own header comment).
//
// Schedule (2026-11-17 — rescheduled from the 15th, per David's feedback):
// fires on the 1ST of the month, weekend-adjusted FORWARD to the next
// business day (Saturday -> the following Monday, Sunday -> the following
// Monday, else the 1st itself — see scheduledReminderDay()), at ~9:00 AM
// America/New_York, DST-aware — the same hourly-Vercel-cron + in-handler
// localPartsInTz() gate pattern api/cron-pto-report.js already established
// (vercel.json: "0 * * * *", every hour, every day; this handler is a fast
// no-op for almost every invocation). This one genuinely needs to run
// EVERY day of the month — the weekend-adjusted target day moves between
// the 1st/2nd/3rd depending on the month, and the 3-day repeat/escalation
// checks below need to run daily regardless of which day the month's
// initial send landed on.
//
// Tracked month (2026-11-17 fix): the reminder is about the PRIOR
// calendar month's backlinks — a run firing in December (even though it's
// triggered by December's own 1st-of-month schedule) is reminding David
// to confirm NOVEMBER's renewal. priorMonthKeyOf() derives that tracked
// month from the firing date; everything keyed off it (the ops_settings
// row, the confirm token's `month`, the wording, the 3-day repeat and the
// escalation-to-Sarah) all use that SAME tracked month consistently.
//
// State: one ops_settings row per TRACKED month, key
// `backlinksReminder:<YYYY-MM>` — no new table/migration, per the ticket's
// own instruction. Shape:
//   { status: 'pending' | 'renewed' | 'not_yet',
//     firstSentAt, lastSentAt: ISO timestamps,
//     nextReminderDate, escalationDueDate: 'YYYY-MM-DD' America/New_York
//       calendar dates — once today's NY date reaches one, that action is
//       due this run,
//     escalatedAt: ISO timestamp, set once, or null,
//     respondedAt: ISO timestamp or null, via: 'email-link' or null }
// Any response (renewed OR not_yet) moves status away from 'pending',
// which stops every further reminder/escalation for that month — the
// goal is forcing a check-in either way, not collecting a specific
// answer (see api/backlinks-confirm.js, which is what actually records
// the response).
//
// Idempotency (CLAUDE.md rule #7 — flagged, not silently assumed):
// `nextReminderDate`/`escalationDueDate` are compared against TODAY's NY
// calendar date with a plain `>=`, and both are always advanced to
// `today + 3 days` immediately after the matching send, in the SAME
// request that sends it — so a second invocation later the same day (a
// platform retry, or another hourly tick that also happens to land on
// hour 9 somehow) always finds "not due yet" and sends nothing further.
// This is the same level of race-tolerance every other cron in this
// codebase already accepts (e.g. cron-pto-report.js's own "check
// ops_notifications for an already-sent marker before sending") — Vercel
// fires one invocation per scheduled tick, not concurrently, so a true
// simultaneous double-send is not a realistic case this needs to defend
// against beyond that. Likewise, if the scheduled day for a given month
// is somehow missed entirely (e.g. a deploy outage), this does NOT catch
// up on a later day — matching the same "same-day-only, no backfill"
// behavior cron-pto-report.js already has; not a gap introduced here.
//
// Confirmation flow (api/backlinks-confirm.js): the email's two buttons
// are tokenized links (lib/backlinksToken.js) to a tiny confirmation page
// that only RENDERS on GET — it never records anything on load, because a
// bare record-on-GET link is exactly the shape an email client's own
// link-prescanning/security-scanning bot auto-fetches before a human ever
// opens the email, which would falsely mark the month done. The actual
// write only happens on that page's own POST (a real form submission a
// prescanning bot does not perform).
//
// Link fix (2026-11-17, David's feedback — the confirm link 404'd):
// `confirmUrl()` used to join `process.env.APP_URL` directly onto
// `/api/backlinks-confirm`, but APP_URL in production is set to the USER
// portal's own URL (every other caller's own fallback default already
// documents this convention — see e.g. lib/resendClient.js's
// `.../user` default), so the link came out as `.../user/api/backlinks-
// confirm` and 404'd. siteRoot() fixes this at the root rather than by
// guessing at APP_URL's exact value: it parses whatever APP_URL resolves
// to and keeps only the protocol+host, discarding any path — correct
// regardless of which portal path APP_URL happens to be set to.
import { getSupabaseAdmin } from '../lib/supabaseAdmin.js';
import { logError } from '../lib/errorLog.js';
import { localPartsInTz } from '../lib/quietHours.js';
import { sendResendEmail, buildEmailHtml, buildPlainEmailHtml, DAVID_EMAIL } from '../lib/resendClient.js';
import { signBacklinksToken } from '../lib/backlinksToken.js';

const SARAH_EMAIL = 'ssamy@weblightmedia.com';
const REPEAT_DAYS = 3;
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function dateStr(y, m, d) { return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`; }

function addDaysToDateStr(ds, days) {
  const [y, m, d] = ds.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dateStr(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

// Weekend-adjusted target day for the month (exported for direct unit
// testing, CLAUDE.md rule #9) — pure calendar math: a calendar date's
// weekday doesn't depend on time zone, so Date.UTC() is exact here with
// no timezone-conversion concern at all (unlike "what time is it right
// now," this is just "what weekday does the 1st fall on"). The 1st is the
// target; a weekend 1st moves FORWARD to the next business day (Monday),
// never backward — unlike the old mid-month (15th) schedule, which could
// move either direction, there's no earlier business day to move the 1st
// to within the same month.
export function scheduledReminderDay(year, month) {
  const dow = new Date(Date.UTC(year, month - 1, 1)).getUTCDay(); // 0=Sun..6=Sat
  if (dow === 6) return 3; // Saturday the 1st -> Monday the 3rd
  if (dow === 0) return 2; // Sunday the 1st -> Monday the 2nd
  return 1;
}

function monthKeyOf(year, month) { return `${year}-${String(month).padStart(2, '0')}`; }

// The reminder always refers to the PRIOR calendar month's backlinks
// (exported for direct unit testing) — a cron firing in December, even
// though it's December's own 1st-of-month schedule that triggered it, is
// reminding David about NOVEMBER's renewal. Handles the January ->
// December-of-the-prior-year rollover.
export function priorMonthKeyOf(year, month) {
  return month === 1 ? monthKeyOf(year - 1, 12) : monthKeyOf(year, month - 1);
}

function monthLabel(monthKey) {
  const [y, m] = monthKey.split('-').map(Number);
  return `${MONTH_NAMES[m - 1]} ${y}`;
}

// Strips any path off APP_URL (or the hardcoded fallback), keeping only
// the origin — see the header comment above for why this is the actual
// fix, not just swapping in a different hardcoded string: it's correct
// regardless of which portal path APP_URL happens to be configured to in
// production.
function siteRoot() {
  const raw = process.env.APP_URL || 'https://opshub.weblightmedia.com';
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}`;
  } catch {
    return 'https://opshub.weblightmedia.com';
  }
}

function confirmUrl(month, answer) {
  const token = signBacklinksToken({ purpose: 'backlinksConfirm', month, answer });
  return `${siteRoot()}/api/backlinks-confirm?token=${encodeURIComponent(token)}`;
}

async function sendDavidReminder(month) {
  const label = monthLabel(month);
  const html = buildEmailHtml({
    title: `${label} backlinks renewal — action needed`,
    body: `The ${label} backlinks renewal is due. Please confirm below — one click, no login needed.\n\nThis will keep reminding you every ${REPEAT_DAYS} days until you respond.`,
    buttons: [
      { label: '✅ I renewed it', href: confirmUrl(month, 'renewed'), background: '#1F9D55' },
      { label: '❌ Not done yet', href: confirmUrl(month, 'not_yet'), background: '#C0392B' },
    ],
  });
  await sendResendEmail({
    to: DAVID_EMAIL,
    subject: `URGENT: ${label} backlinks renewal — action needed`,
    html,
    type: 'backlinksReminder',
    from: 'notifications@opshub.wlmsend.com',
    headers: { 'X-Priority': '1', 'Importance': 'high' },
  });
}

async function sendSarahEscalation(month) {
  const label = monthLabel(month);
  const html = buildPlainEmailHtml({
    body: `David hasn't responded to the ${label} backlinks renewal reminder sent ${REPEAT_DAYS} days ago — it's still unacknowledged.`,
  });
  await sendResendEmail({
    to: SARAH_EMAIL,
    subject: `Unacknowledged: ${label} backlinks renewal reminder to David`,
    html,
    type: 'backlinksEscalation',
    from: 'notifications@opshub.wlmsend.com',
  });
}

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  const header = req.headers.authorization || '';
  if (!secret || header !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const ny = localPartsInTz(new Date(), 'America/New_York');
  if (ny.hour !== 9) {
    return res.status(200).json({ ok: true, acted: false, reason: 'not 9:00 AM America/New_York (this hourly invocation is a no-op)' });
  }

  let supabase;
  try { supabase = getSupabaseAdmin(); }
  catch (err) { await logError({ endpoint: 'cron-backlinks-reminder', error: err }); return res.status(500).json({ error: err.message }); }

  const todayStr = dateStr(ny.year, ny.month, ny.day);
  const month = priorMonthKeyOf(ny.year, ny.month);
  const settingsKey = `backlinksReminder:${month}`;

  try {
    const { data: row, error: readErr } = await supabase.from('ops_settings').select('data').eq('key', settingsKey).maybeSingle();
    if (readErr) throw new Error(readErr.message);
    let state = row?.data || null;

    if (!state) {
      const scheduledDay = scheduledReminderDay(ny.year, ny.month);
      if (ny.day !== scheduledDay) {
        return res.status(200).json({ ok: true, acted: false, reason: `not the scheduled day for ${month} (day ${scheduledDay})` });
      }
      await sendDavidReminder(month);
      const nowIso = new Date().toISOString();
      state = {
        status: 'pending',
        firstSentAt: nowIso, lastSentAt: nowIso,
        nextReminderDate: addDaysToDateStr(todayStr, REPEAT_DAYS),
        escalationDueDate: addDaysToDateStr(todayStr, REPEAT_DAYS),
        escalatedAt: null, respondedAt: null, via: null,
      };
      const { error: writeErr } = await supabase.from('ops_settings').upsert({ key: settingsKey, data: state }, { onConflict: 'key' });
      if (writeErr) throw new Error(writeErr.message);
      return res.status(200).json({ ok: true, acted: true, actions: ['initial'], month });
    }

    if (state.status !== 'pending') {
      return res.status(200).json({ ok: true, acted: false, reason: `already resolved for ${month} (${state.status})` });
    }

    const actions = [];
    let changed = false;

    if (!state.escalatedAt && todayStr >= state.escalationDueDate) {
      await sendSarahEscalation(month);
      state = { ...state, escalatedAt: new Date().toISOString() };
      changed = true;
      actions.push('escalated');
    }
    if (todayStr >= state.nextReminderDate) {
      await sendDavidReminder(month);
      state = { ...state, lastSentAt: new Date().toISOString(), nextReminderDate: addDaysToDateStr(todayStr, REPEAT_DAYS) };
      changed = true;
      actions.push('repeat');
    }
    if (changed) {
      const { error: writeErr } = await supabase.from('ops_settings').upsert({ key: settingsKey, data: state }, { onConflict: 'key' });
      if (writeErr) throw new Error(writeErr.message);
    }
    return res.status(200).json({ ok: true, acted: changed, actions, month });
  } catch (err) {
    await logError({ endpoint: 'cron-backlinks-reminder', error: err });
    return res.status(500).json({ ok: false, error: err.message });
  }
}
