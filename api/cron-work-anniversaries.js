// Vercel Cron: work-anniversary milestone reminders to the super admins,
// ~3 days ahead of every 6-month mark (6, 12, 18, 24, 30, 36... months,
// forever) from each person's startDate.
//
// Auth: same CRON_SECRET Bearer-token pattern every other cron endpoint in
// this app already uses (see cron-overdue-check.js's own header comment) —
// no new secret for this endpoint.
//
// Schedule: EVERY day (see vercel.json — "0 12 * * *", no weekday
// restriction), not tied to any utcHour gate the way cron-overdue-check.js's
// multi-purpose dispatch is — a weekend milestone must still get its 3-day
// notice, so this can never skip Sat/Sun the way a weekday-only cron would.
// Never runs on page load or any client timer (CLAUDE.md rule #2) — this is
// the only place a milestone is ever computed.
//
// Recipients: resolveTimeOffSubmittedRecipients(admins) (#403's own
// resolver) — the primary-admin sentinel + every real super/owner admin,
// reused as-is rather than writing a parallel "who are the super admins"
// resolver. Routed through insertNotifications() so it inherits quiet
// hours + in-app + email exactly like every other notification type in
// this app; deliberately no opts.bypassQuietHours here (unlike
// cron-overdue-check.js's own digest/nag sends) — a birthday-style
// reminder has no same-day urgency that would justify waking someone
// outside their team's quiet hours, so a run that lands inside one simply
// delivers by email once quiet hours end, same as any other notification.
//
// Idempotency: read-based, never a write to the celebrated person's own
// ops_users/ops_admins row (this endpoint touches ops_notifications only,
// nothing else — no clobber-class risk of the kind CLAUDE.md's "key
// present but stale" class documents for record writes). Before sending,
// every ops_notifications row of type 'workAnniversary' is read and
// checked for a matching {personId, months} in its own context — a
// candidate milestone that already has one is skipped. Both the write
// (insertNotifications) and this read run inside the SAME request, so
// there is no "diff old vs new on a timer" pattern here (CLAUDE.md rule
// #2) — this is a single scheduled action reacting once, computing and
// then immediately writing/skipping, not a background reconciliation pass.
//
// Only active (status:'active') users/admins are considered — matching
// every other roster-building convention in this codebase (e.g.
// api/process-transcript.js's activeRoster()) — a terminated employee's
// old startDate should never generate a reminder. This is a judgment
// call, not stated explicitly in the original spec; flagged in the PR
// description for review.
import { getSupabaseAdmin } from '../lib/supabaseAdmin.js';
import { logError } from '../lib/errorLog.js';
import { resolveTimeOffSubmittedRecipients, personOf, insertNotifications } from './ops-sync.js';

function todayIsoUtc() { return new Date().toISOString().slice(0, 10); }

// Adds `months` calendar months to a YYYY-MM-DD date, UTC — matches this
// codebase's own existing precedent for month math (advanceRecurringDate()
// in ops-sync.js uses the identical native Date setMonth()/setUTCMonth()
// rollover behavior for a 'monthly' recurring task, un-clamped) rather than
// introducing a different end-of-month clamping scheme here. Returns null
// for a malformed startDate — never guessed at, matching validDueDate()'s
// own "malformed input never reaches downstream logic as if it were real"
// convention in api/process-transcript.js.
function addMonthsUtc(dateStr, months) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || '').slice(0, 10));
  if (!m) return null;
  const dt = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  dt.setUTCMonth(dt.getUTCMonth() + months);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

function daysBetweenUtc(fromIso, toIso) {
  const from = new Date(`${fromIso}T00:00:00Z`);
  const to = new Date(`${toIso}T00:00:00Z`);
  return Math.round((to - from) / 86400000);
}

// Bounds the search — 200 half-year marks is 100 years of tenure, far past
// any real employee's startDate; the early-return below (once a candidate
// milestone is already MORE than 5 days out) is what actually stops this
// in 1-2 iterations for a real date, this cap only guards against a
// malformed/garbage startDate that could otherwise loop indefinitely.
const MAX_MILESTONE_K = 200;

// Finds the one upcoming milestone (if any) that falls 3-5 days ahead of
// `todayIso`, for a person's given `startDate`. Milestones are 6-month
// multiples (6, 12, 18, 24...) counted forward from startDate, forever —
// k increases monotonically further into the future, so the first
// candidate found more than 5 days out means every later k is even
// further out too; safe to stop there. A milestone whose date has already
// passed (days < 0, or more generally days < 3) is skipped by simply
// continuing to the next k — this function never returns a past milestone,
// satisfying "skip any milestone already in the past" without a separate
// explicit check.
function findUpcomingMilestone(startDate, todayIso) {
  for (let k = 1; k <= MAX_MILESTONE_K; k++) {
    const months = 6 * k;
    const milestoneDate = addMonthsUtc(startDate, months);
    if (!milestoneDate) return null;
    const days = daysBetweenUtc(todayIso, milestoneDate);
    if (days > 5) return null;
    if (days >= 3 && days <= 5) return { months, date: milestoneDate, daysAhead: days };
  }
  return null;
}

function milestoneLabel(months) {
  return months % 12 === 0 ? `${months / 12}-year` : `${months}-month`;
}

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  const header = req.headers.authorization || '';
  if (!secret || header !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  let supabase;
  try { supabase = getSupabaseAdmin(); }
  catch (err) { await logError({ endpoint: 'cron-work-anniversaries', error: err }); return res.status(500).json({ error: err.message }); }

  try {
    const todayIso = todayIsoUtc();

    const [{ data: userRows, error: uErr }, { data: adminRows, error: aErr }, { data: existingRows, error: nErr }] = await Promise.all([
      supabase.from('ops_users').select('id, data'),
      supabase.from('ops_admins').select('id, data'),
      supabase.from('ops_notifications').select('id, data').eq('data->>type', 'workAnniversary'),
    ]);
    if (uErr) throw new Error(uErr.message);
    if (aErr) throw new Error(aErr.message);
    if (nErr) throw new Error(nErr.message);

    const users = (userRows || []).map(r => ({ id: r.id, kind: 'user', ...r.data })).filter(u => u.status === 'active' && u.name);
    const admins = (adminRows || []).map(r => ({ id: r.id, kind: 'admin', ...r.data })).filter(a => a.status === 'active' && a.name);
    const people = [...users, ...admins];

    // Already-sent {personId, months} pairs — read-based dedup, per this
    // endpoint's own header comment. A Set of composite keys, not a
    // per-person lookup map, since this only ever needs membership tests.
    const alreadySent = new Set(
      (existingRows || [])
        .map(r => r.data?.context)
        .filter(c => c && c.personId && c.months)
        .map(c => `${c.personId}:${c.months}`)
    );

    const candidates = [];
    for (const p of people) {
      if (!p.startDate) continue;
      const milestone = findUpcomingMilestone(p.startDate, todayIso);
      if (!milestone) continue;
      if (alreadySent.has(`${p.id}:${milestone.months}`)) continue;
      candidates.push({ person: p, milestone });
    }

    if (!candidates.length) {
      return res.status(200).json({ ok: true, sent: 0 });
    }

    const recipients = resolveTimeOffSubmittedRecipients(admins);
    const warnings = [];
    const rows = [];
    for (const { person, milestone } of candidates) {
      const label = milestoneLabel(milestone.months);
      const dayWord = milestone.daysAhead === 1 ? 'day' : 'days';
      const title = `${person.name}'s ${label} work anniversary is coming up`;
      const body = `${person.name}'s ${label} anniversary is on ${milestone.date} (in ${milestone.daysAhead} ${dayWord}).`;
      recipients.forEach(r => {
        const isPrimary = r.id === 'primary-admin';
        const recipientPerson = isPrimary ? null : personOf(r.id, r.kind, { users, admins });
        rows.push({
          type: 'workAnniversary', recipientId: r.id, recipientKind: r.kind,
          recipientName: isPrimary ? 'Sarah Samy' : (recipientPerson?.name || ''),
          recipientEmail: isPrimary ? 'ssamy@weblightmedia.com' : (recipientPerson?.email || ''),
          title, body, link: '',
          // context is what the dedup read above matches against next run
          // — personId/months, never anything the person could rename
          // (e.g. not their name) so a later name change can never make
          // this fire twice.
          context: { personId: person.id, personKind: person.kind, months: milestone.months, milestoneDate: milestone.date },
        });
      });
    }

    await insertNotifications(supabase, rows, warnings);
    if (warnings.length) {
      await logError({ endpoint: 'cron-work-anniversaries', error: warnings.join('; '), extra: { candidateCount: candidates.length } });
    }

    return res.status(200).json({ ok: true, sent: candidates.length, milestones: candidates.map(c => ({ personId: c.person.id, months: c.milestone.months, date: c.milestone.date })) });
  } catch (err) {
    await logError({ endpoint: 'cron-work-anniversaries', error: err });
    return res.status(500).json({ ok: false, error: err.message });
  }
}
