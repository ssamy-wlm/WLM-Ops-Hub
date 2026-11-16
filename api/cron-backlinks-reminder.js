// Vercel Cron: monthly "backlinks renewal" reminder to David — urgent,
// forces a check-in (renewed or not), repeats every 3 days until he
// responds, and escalates to Sarah once if he still hasn't acknowledged
// it 3 days after the first send.
//
// Auth: same CRON_SECRET Bearer-token pattern every other cron endpoint in
// this app already uses (see cron-overdue-check.js's own header comment).
//
// Schedule: fires on the 15th of the month, weekend-adjusted (Saturday ->
// the 14th, Sunday -> the 16th, else the 15th — see
// scheduledReminderDay()), at ~9:00 AM America/New_York, DST-aware — the
// same hourly-Vercel-cron + in-handler localPartsInTz() gate pattern
// api/cron-pto-report.js already established (vercel.json: "0 * * * *",
// every hour, every day; this handler is a fast no-op for almost every
// invocation). Unlike cron-pto-report.js's fixed two-UTC-day schedule,
// this one genuinely needs to run EVERY day of the month — the weekend-
// adjusted target day moves between the 14th/15th/16th depending on the
// month, and the 3-day repeat/escalation checks below need to run daily
// regardless of which day the month's initial send landed on.
//
// State: one ops_settings row per month, key
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
import { getSupabaseAdmin } from '../lib/supabaseAdmin.js';
import { logError } from '../lib/errorLog.js';
import { localPartsInTz } from '../lib/quietHours.js';
import { sendResendEmail, buildPlainEmailHtml, DAVID_EMAIL } from '../lib/resendClient.js';
import { signBacklinksToken } from '../lib/backlinksToken.js';

const SARAH_EMAIL = 'ssamy@weblightmedia.com';
const REPEAT_DAYS = 3;

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
// now," this is just "what weekday does the 15th fall on").
export function scheduledReminderDay(year, month) {
  const dow = new Date(Date.UTC(year, month - 1, 15)).getUTCDay(); // 0=Sun..6=Sat
  if (dow === 6) return 14; // Saturday -> Friday
  if (dow === 0) return 16; // Sunday -> Monday
  return 15;
}

function monthKeyOf(year, month) { return `${year}-${String(month).padStart(2, '0')}`; }

function confirmUrl(month, answer) {
  const token = signBacklinksToken({ purpose: 'backlinksConfirm', month, answer });
  const base = process.env.APP_URL || 'https://opshub.weblightmedia.com';
  return `${base}/api/backlinks-confirm?token=${encodeURIComponent(token)}`;
}

function reminderEmailBody(month) {
  return [
    'URGENT: the monthly backlinks renewal is due.',
    '',
    'Please confirm below — one click, no login needed:',
    '',
    `✅ I renewed it: ${confirmUrl(month, 'renewed')}`,
    '',
    `❌ Not done yet: ${confirmUrl(month, 'not_yet')}`,
    '',
    `This will keep reminding you every ${REPEAT_DAYS} days until you respond.`,
  ].join('\n');
}

async function sendDavidReminder(month) {
  const html = buildPlainEmailHtml({ body: reminderEmailBody(month) });
  await sendResendEmail({
    to: DAVID_EMAIL,
    subject: 'URGENT: Monthly backlinks renewal — action needed',
    html,
    type: 'backlinksReminder',
    from: 'notifications@opshub.wlmsend.com',
    headers: { 'X-Priority': '1', 'Importance': 'high' },
  });
}

async function sendSarahEscalation(month) {
  const html = buildPlainEmailHtml({
    body: `David hasn't responded to the ${month} backlinks renewal reminder sent ${REPEAT_DAYS} days ago — it's still unacknowledged.`,
  });
  await sendResendEmail({
    to: SARAH_EMAIL,
    subject: `Unacknowledged: ${month} backlinks renewal reminder to David`,
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
  const month = monthKeyOf(ny.year, ny.month);
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
