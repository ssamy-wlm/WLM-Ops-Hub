// Vercel Cron: the ONLY place "overdue" is detected server-side — never on
// login/page-load or any other timer-driven scan of live browser state
// (CLAUDE.md rule #2 forbids that pattern; this is a genuine scheduled job,
// not a disguised load-time diff, and it never touches anything a browser
// sent in the same request the way ops-sync.js's other event collectors do).
//
// Auth: Vercel invokes cron endpoints with `Authorization: Bearer
// $CRON_SECRET` when a `crons` entry is configured in vercel.json (see
// https://vercel.com/docs/cron-jobs) — verified here so nothing else can
// trigger this endpoint. Fails closed if CRON_SECRET isn't configured.
//
// Idempotency: each currently-overdue service gets a stamped
// `overdueNotifiedFor` field set to the exact `due` value that was active
// when the notification fired. A repeat run against the SAME due date sees
// `overdueNotifiedFor === due` and skips it — never a second notification
// for the same missed cycle. If the due date later rolls over (a new cycle
// came and went without ever being marked done), `due` no longer matches the
// stamp, so it correctly re-fires exactly once for the new cycle.
//
// Writes are per-record only: only the specific clients whose service
// objects were actually stamped in this run get upserted, each with its full
// existing `data` (mutated in place, in memory, before the write) — never a
// whole-table rewrite, same rule as every write in api/ops-sync.js.
//
// Recipients are manager/higher-admin escalation ONLY — the assignee's own
// row is filtered out of every notification this endpoint creates, so the
// member's own (pre-existing, local-only) overdue awareness is left exactly
// as it was before this feature; this cron never notifies the assignee.
//
// The daily ops_backups snapshot (see lib/opsBackup.js) used to run at the
// end of every invocation of THIS endpoint — folded in here back when the
// Vercel Hobby plan's caps (2 crons, 12 serverless functions) made a
// dedicated cron-backup.js endpoint too expensive to keep deployed. Now on
// Vercel Pro (no such caps), the backup step has been moved back out to its
// own dedicated endpoint (api/cron-backup.js) on its own, more frequent
// schedule ("0 */6 * * *", every 6h — see that file), so this endpoint goes
// back to doing only overdue/task-attention/digest/escalation work, exactly
// as before backups were ever folded in here. A manual/on-demand snapshot is
// still available via api/ops-backups.js's `action:'manual'` (Admin
// Controls → Data Backups → Create Manual Snapshot), unaffected either way.
import { getSupabaseAdmin } from '../lib/supabaseAdmin.js';
import { logError } from '../lib/errorLog.js';
import { resolveNotifyRecipients, resolveReportRecipients, insertNotifications, personOf, DEFAULT_TEAM_NOTIF_PREFS } from './ops-sync.js';
import { buildEmailHtml, sendResendEmail } from '../lib/resendClient.js';
import { isWithinQuietHours } from '../lib/quietHours.js';

// Weekday morning "log your tasks" reminder (2026-09-07) — v1 hardcoded
// recipients, can become a per-user toggle later. Sent via the same Resend
// setup every other notification email already uses (lib/resendClient.js),
// NOT through insertNotifications()/ops_notifications, since this isn't tied
// to a real event on a real record — it's a fixed daily nudge to 3 specific
// people, so a plain direct send is the simpler, more literal fit.
const DAILY_TASK_REMINDER_RECIPIENTS = [
  { name: 'Rana Ayman', email: 'ranaa@weblightmedia.com' },
  { name: 'Sherine Amin', email: 'sherinea@weblightmedia.com' },
  { name: 'Assmaa Fouad', email: 'assmaaf@weblightmedia.com' },
];

// Shared by the hierarchy-escalation block (tier 2, below) and the
// twice-daily overdue self-nag block (2026-09-18, below) — hoisted to
// module scope so both agree on the exact same threshold; was previously
// declared inside the hierarchy-escalation block alone.
const OVERDUE_ESCALATION_THRESHOLD = 5;

// Twice-daily overdue self-nag (2026-09-18) — 8 AM + 2 PM EST, fixed
// UTC-5 (no DST adjustment), matching this file's own established
// EST-as-a-fixed-offset convention (see cairoLocalParts()'s own comment
// on the identical tradeoff for Cairo). vercel.json's matching cron
// entries are "0 13 * * *"/"0 19 * * *" — deliberately EVERY day, not
// weekday-only like the 07:00/11:00 jobs, because this block deliberately
// does NOT bypass quiet hours (see its own comment below) — per-team
// quiet hours are what suppresses a weekend send here, not the schedule.
const OVERDUE_NAG_HOURS = new Set([13, 19]);

// Vercel Hobby crons are fixed-UTC and don't shift for DST, but Cairo does
// (UTC+2 in winter, UTC+3 in summer). The originally-preferred design —
// firing this endpoint at BOTH 07:00 and 08:00 UTC so whichever one lands on
// the real Cairo 10:00 hour sends — turned out not to work: Vercel's Hobby
// plan rejects any SINGLE cron expression that fires more than once a day
// (confirmed live: "0 7,8,22 * * *" failed the preview deploy with exactly
// that error), even though two SEPARATE entries, each firing at most once a
// day, deploy fine (also confirmed live). So vercel.json instead has two
// entries: the pre-existing digest-cron entry (then "0 22 * * *", since
// retimed to "0 11 * * 1-5" — see the weekday-mornings retiming entry) and a new
// "0 7 * * 1-5" (weekdays only) for this reminder — the single-trigger
// fallback the original task spec explicitly authorized for exactly this
// case, with the accepted tradeoff that in winter (Cairo UTC+2) this lands
// at ~9:00am Cairo instead of 10:00am; in summer (Cairo UTC+3) it's exactly
// 10:00am. Flagged to Sarah in the PR description — not silently absorbed.
function cairoLocalParts(now) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Africa/Cairo', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', weekday: 'short',
  });
  const parts = Object.fromEntries(fmt.formatToParts(now).map(p => [p.type, p.value]));
  let hour = parseInt(parts.hour, 10);
  if (hour === 24) hour = 0; // some engines report midnight as "24" with hour12:false
  return { dateStr: `${parts.year}-${parts.month}-${parts.day}`, hour, weekday: parts.weekday };
}

function isInactiveService(s) { return s.status === 'cancelled' || s.status === 'archived'; }
// Same rule as client.html's _svcIsDoneThisCycle/_svcDueStatus — kept in sync
// deliberately (not imported; this endpoint has no access to that browser-side
// file), single source of truth documented in both places.
function isDoneThisCycle(svc, t) { return !!(svc.lastDone && !(svc.due && svc.due < t)); }
function isOverdue(svc, t) { return !isInactiveService(svc) && !isDoneThisCycle(svc, t) && !!svc.due && svc.due < t; }

// Same predicates as index.html's _taIsOverdue()/_taIsDueToday() — kept in
// sync deliberately (task-scope "Needs Attention" digest/reminders below,
// 2026-08-20), never imported since this is a completely separate runtime
// from the browser-side file.
function taskIsOverdue(t, today) { return !!t.dueDate && t.dueDate < today && t.status !== 'Done'; }
function taskIsDueToday(t, today) { return t.dueDate === today && t.status !== 'Done'; }
// Recurring tasks (2026-09-08) — same predicate as index.html's own
// _taCountsAsOverdueBurden(), kept in sync deliberately for the same
// "completely separate runtime" reason as taskIsOverdue()/taskIsDueToday()
// above. A recurring task due again on schedule shouldn't inflate the
// owner digest's/self-reminder's overdue tally or the hierarchy-escalation
// counts below — both are genuinely "burden"/escalation signals, unlike
// the per-task dueToday/blocked/unassigned counts, which are left as
// literal, unfiltered truth.
function taskCountsAsOverdueBurden(t, today) { return taskIsOverdue(t, today) && !t.recurring; }

// Linked dual-role identity merge (2026-09-17) — an ops_admins row may carry
// linkedUserId, pointing at the ops_users row for the SAME real person (see
// CLAUDE.md's dual-mode permission project; api/ops-auth.js is the only
// other place this field is read, for login resolution). That is the ONLY
// link that exists today — there is no reverse linkedAdminId on ops_users —
// so a pair is always discovered from the admin side, mirroring
// api/ops-auth.js's own precedence exactly (an admin row's linkedUserId is
// checked first, and once a valid link exists the admin row is never a
// separate person for that resolution).
//
// Canonical id = the EMPLOYEE (ops_users) id for a linked pair. This matches
// api/ops-auth.js's own session resolution: a real login through a linked
// pair always sets session.id to employeeRow.id, never the admin row's id
// (see that file's dual-role branch) — so every write this app makes under
// that person's real session (a task self-assign, session-ping activity,
// etc.) already lands under this same id today. Treating the admin id as an
// alias of it here, rather than the reverse, means the merged totals below
// agree with what that person's own real session already produces, not an
// arbitrary pick — and it's what makes a HISTORICAL record still sitting
// under the admin id (e.g. from before a dual-role account was granted, or
// from a write path that used the raw admin identity) merge correctly too.
function buildCanonicalIdMap(users, admins) {
  const map = new Map(); // adminId -> canonical employeeId, one entry per valid linked pair
  admins.forEach(a => {
    if (a.linkedUserId && users.some(u => u.id === a.linkedUserId)) map.set(a.id, a.linkedUserId);
  });
  return map;
}
function canonicalId(id, canonMap) { return id ? (canonMap.get(id) || id) : id; }

// Notification hierarchy + escalation (2026-09-03) — "1 full working day" of
// inactivity means since the START of the previous WEEKDAY, skipping back
// over a weekend rather than a flat 24h (a Monday-morning run should compare
// against Friday, not Saturday/Sunday when nobody's expected to be active
// anyway). Returns midnight UTC of that day.
function previousWorkingDayStart(now) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - 1);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() - 1);
  return d;
}

async function loadDirectory(supabase) {
  const [{ data: usersData }, { data: adminsData }, { data: teamPrefRows }] = await Promise.all([
    supabase.from('ops_users').select('id, data'),
    supabase.from('ops_admins').select('id, data'),
    supabase.from('ops_settings').select('key, data').like('key', 'teamNotifPrefs_%'),
  ]);
  const prefsByAdminId = new Map((teamPrefRows || []).map(r => [r.key.slice('teamNotifPrefs_'.length), r.data]));
  return {
    users: (usersData || []).map(r => ({ id: r.id, ...r.data })),
    admins: (adminsData || []).map(r => ({
      id: r.id, ...r.data,
      teamNotifPrefs: { ...DEFAULT_TEAM_NOTIF_PREFS, ...(prefsByAdminId.get(r.id) || {}) },
    })),
  };
}

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  const header = req.headers.authorization || '';
  if (!secret || header !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  let supabase;
  try { supabase = getSupabaseAdmin(); }
  catch (err) { await logError({ endpoint: 'cron-overdue-check', error: err }); return res.status(500).json({ error: err.message }); }

  const warnings = [];
  const summary = { scanned: 0, overdueFound: 0, newlyStamped: 0, clientsUpdated: 0, notificationsSent: 0 };
  const utcHour = new Date().getUTCHours();

  try {
    // ── Weekday morning "log your tasks" reminder — the 07:00 UTC weekday
    // invocation only (vercel.json's own "0 7 * * 1-5" entry — see the header
    // comment on cairoLocalParts() above for why this is a single trigger,
    // not a 07:00/08:00 pair). Entirely independent of the 11:00 UTC block
    // below — runs in its own try/catch so a failure here can never affect
    // the overdue/backup work, and vice versa. The Cairo weekday check below
    // is a defense-in-depth safety net (the cron's own "1-5" already
    // restricts this), not the primary guard.
    if (utcHour === 7) {
      try {
        const cairo = cairoLocalParts(new Date());
        const isWeekday = cairo.weekday !== 'Sat' && cairo.weekday !== 'Sun';
        if (isWeekday) {
          const { data: reminderState } = await supabase.from('ops_settings').select('data').eq('key', 'dailyTaskReminderState').maybeSingle();
          if (reminderState?.data?.lastSentDate === cairo.dateStr) {
            summary.dailyTaskReminder = 'already sent today';
          } else {
            // Stamp BEFORE sending, so this can never fire twice for the same
            // Cairo calendar day — including if every send below fails, or on
            // any duplicate/retry invocation.
            const { error: stampErr } = await supabase.from('ops_settings')
              .upsert({ key: 'dailyTaskReminderState', data: { lastSentDate: cairo.dateStr } }, { onConflict: 'key' });
            if (stampErr) warnings.push(`dailyTaskReminderState stamp: ${stampErr.message}`);

            // Quiet-hours check (2026-09-13) — this send site is the one
            // place in this file that emails via sendResendEmail() DIRECTLY
            // rather than through insertNotifications() (see this block's
            // own header comment above: hardcoded name/email pairs, no
            // recipientId to look a team up from the way every other
            // notification type in this codebase already does). Resolved by
            // matching each hardcoded email against the live directory, same
            // "never trust a hardcoded default, resolve fresh" discipline
            // already used elsewhere in this file — falls back to the
            // Egypt/default window (matching this codebase's own established
            // `team || 'Egypt'` convention) only if no matching row exists.
            // In practice this cron only ever fires weekday mornings
            // (vercel.json's "0 7 * * 1-5"), which never overlaps either
            // team's Fri-evening-through-Mon-morning window — so this is a
            // defensive, always-correct check, not one expected to actually
            // suppress anything under the current schedule.
            const { users: dtrUsers, admins: dtrAdmins } = await loadDirectory(supabase);
            const teamForEmail = (email) => {
              const lower = (email || '').toLowerCase();
              const rec = [...dtrUsers, ...dtrAdmins].find(p => (p.email || '').toLowerCase() === lower);
              return rec?.team;
            };
            let sent = 0;
            let suppressed = 0;
            for (const r of DAILY_TASK_REMINDER_RECIPIENTS) {
              if (isWithinQuietHours(teamForEmail(r.email), new Date())) { suppressed++; continue; }
              try {
                const html = buildEmailHtml({
                  name: r.name,
                  title: 'Good morning — add your tasks for today.',
                  body: "Quick reminder to log today's workload/tasks in the Ops Hub before the morning meeting.",
                  link: process.env.APP_URL || 'https://opshub.weblightmedia.com/user',
                });
                await sendResendEmail({ to: r.email, subject: 'Good morning — add your tasks for today.', html });
                sent++;
              } catch (err) {
                await logError({ endpoint: 'cron-overdue-check:dailyTaskReminder', error: err, extra: { recipient: r.email } });
                warnings.push(`dailyTaskReminder send (${r.email}): ${err.message}`);
              }
            }
            summary.dailyTaskReminder = `sent ${sent}/${DAILY_TASK_REMINDER_RECIPIENTS.length}${suppressed ? ` (${suppressed} suppressed — quiet hours)` : ''}`;
          }
        } else {
          summary.dailyTaskReminder = 'not a Cairo weekday (safety-net check — the cron schedule itself already restricts to weekdays)';
        }
      } catch (err) {
        await logError({ endpoint: 'cron-overdue-check:dailyTaskReminder', error: err });
        warnings.push(`dailyTaskReminder: ${err.message}`);
      }
    }

    // ── Overdue self-nag, twice daily (2026-09-18) — fires at BOTH new
    // cron hours (OVERDUE_NAG_HOURS, module-scope above), entirely
    // independent of the once-daily 11:00 UTC job below: that job (and
    // Sarah/David's "big-issue" summary + the manager/super-admin
    // escalation it produces) is completely untouched by this block —
    // this is a genuinely separate, ADDITIVE notification a person gets
    // about their own personal overdue backlog, not a replacement for or
    // change to any existing escalation.
    //
    // Anyone — a plain user OR an admin, at ANY level, including
    // super/owner — with a MERGED overdue count >= OVERDUE_ESCALATION_
    // THRESHOLD gets nagged. Deliberately no super/owner exemption the
    // way tier-2 escalation (below) has one: that exemption exists
    // because tier 2 is about escalating TO the top, and the super admins
    // are already the top; this is a purely personal "clear your own
    // backlog" nudge, which applies just as much to a super admin's own
    // items as anyone else's.
    //
    // Uses the exact same linked-identity merge as the hierarchy-
    // escalation block below (buildCanonicalIdMap/canonicalId/
    // taskCountsAsOverdueBurden/isOverdue, and the identical "skip a
    // linked ADMIN row, evaluate once via its employee counterpart"
    // convention the inactivePeople roster already established) — a
    // dual-role person is nagged exactly once, with their real combined
    // count, never twice and never a partial fraction of it. Independent
    // query, own try/catch, same "each block owns its own data" and
    // "a failure here can never affect a sibling block" conventions the
    // 07:00/11:00 blocks already establish in this file.
    //
    // Deliberately does NOT pass bypassQuietHours — unlike every other
    // insertNotifications() call in this file, per the ticket's own
    // explicit "respect quiet-hours" instruction. This cron is scheduled
    // EVERY day (not weekdays-only, see OVERDUE_NAG_HOURS' own comment
    // above), so per-team quiet hours are what actually suppresses a
    // weekend send here, not the cron schedule itself.
    if (OVERDUE_NAG_HOURS.has(utcHour)) {
      try {
        const { users: nUsers, admins: nAdmins } = await loadDirectory(supabase);
        const nCanonMap = buildCanonicalIdMap(nUsers, nAdmins);
        const { data: nTaskRows, error: nTaskErr } = await supabase.from('ops_tasks').select('id, data');
        if (nTaskErr) warnings.push(`overdueNag tasks: ${nTaskErr.message}`);
        const nTasks = (nTaskRows || []).map(r => ({ id: r.id, ...r.data }));
        const { data: nClientRows, error: nClientErr } = await supabase.from('ops_clients').select('id, status, data').eq('status', 'active');
        if (nClientErr) warnings.push(`overdueNag clients: ${nClientErr.message}`);
        const nToday = new Date().toISOString().slice(0, 10);
        const nOverdueCounts = new Map();
        const nBump = (id) => { if (!id) return; const cid = canonicalId(id, nCanonMap); nOverdueCounts.set(cid, (nOverdueCounts.get(cid) || 0) + 1); };
        nTasks.forEach(t => { if (!t.mergedIntoId && taskCountsAsOverdueBurden(t, nToday)) nBump(t.assigneeId); });
        const nScanServiceOverdue = (list) => (list || []).forEach(s => { if (s?.assigneeId && isOverdue(s, nToday)) nBump(s.assigneeId); });
        (nClientRows || []).forEach(row => {
          const client = row.data; if (!client) return;
          nScanServiceOverdue(client.services);
          (client.locations || []).forEach(loc => nScanServiceOverdue(loc.services));
        });

        const nagRows = [];
        const considerForNag = (p, kind) => {
          if (!p.id) return;
          if (kind === 'admin' && nCanonMap.has(p.id)) return; // a linked admin row — represented once via its employee counterpart
          const count = nOverdueCounts.get(p.id) || 0;
          if (count < OVERDUE_ESCALATION_THRESHOLD) return;
          if (!p.email) return;
          nagRows.push({
            type: 'overdueNag', recipientId: p.id, recipientKind: kind,
            recipientName: p.name || '', recipientEmail: p.email,
            title: 'You have overdue items',
            body: `You have ${count} overdue item${count !== 1 ? 's' : ''} — please log in and clear what you can when you get a chance.`,
            link: '', context: {},
          });
        };
        nUsers.forEach(p => considerForNag(p, 'user'));
        nAdmins.forEach(p => considerForNag(p, 'admin'));

        summary.overdueNagSent = nagRows.length;
        // opts.directory (2026-09-18) — passes this block's own just-fetched
        // {nUsers, nAdmins} straight through as insertNotifications()'s
        // quiet-hours team lookup, rather than letting it call
        // api/ops-sync.js's own getDirectory() implicitly. That function's
        // _directoryCache is a MODULE-level cache reset only inside
        // api/ops-sync.js's own handler() — which never runs as part of
        // THIS file's serverless function — so on a warm container that's
        // already called getDirectory() once (e.g. this same nag block's
        // own EARLIER invocation, hours ago), it would silently serve
        // stale team data to the one call site in this file that actually
        // NEEDS an accurate team lookup for quiet hours to work correctly
        // (every other insertNotifications() call in this file passes
        // bypassQuietHours:true and so never exercises this path at all —
        // this is the first one that does). Exact same fix/precedent
        // api/process-transcript.js's fireMeetingParseNotifyEvents()
        // already established for the identical cross-function risk.
        await insertNotifications(supabase, nagRows, warnings, { directory: { users: nUsers, admins: nAdmins } });
      } catch (err) {
        await logError({ endpoint: 'cron-overdue-check:overdueNag', error: err });
        warnings.push(`overdueNag: ${err.message}`);
      }
    }

    // Everything below (overdue escalation, task attention, focus digest,
    // hierarchy escalation) is the ORIGINAL once-daily job — retimed from
    // 22:00 UTC (6 PM EDT / 5 PM EST) to 11:00 UTC weekdays-only (7 AM EDT /
    // 6 AM EST — always 6-7 AM ET, DST-safe) so these land as a morning
    // briefing instead of an end-of-day one; vercel.json's own cron entry
    // for this job is now "0 11 * * 1-5" (Mon-Fri), so this gate gets to
    // stay a plain hour check — the weekday restriction is the schedule's
    // job, not this code's. Still gated to one specific hour, not "not 7,"
    // so folding the unrelated 07:00 UTC morning-reminder trigger and the
    // 13:00/19:00 UTC overdue-nag trigger (see above) into this same
    // handler can never double-run this block.
    // The daily backup snapshot no longer runs here — see api/cron-backup.js.
    if (utcHour !== 11) {
      return res.status(200).json({
        ok: true, summary, warnings,
        skipped: OVERDUE_NAG_HOURS.has(utcHour) ? 'overdue-nag hour only — not the main 11:00 UTC job' : 'not a scheduled job hour for this endpoint',
      });
    }

    // Org-wide on/off toggle (Super Admin-visible in Settings, same as the
    // other notification types) — a direct read, not the memoized
    // getNotificationSettings() in ops-sync.js, since that cache is scoped to
    // ops-sync.js's own handler lifecycle and isn't reset here.
    const { data: settingsRow } = await supabase.from('ops_settings').select('data').eq('key', 'notificationSettings').maybeSingle();
    const overdueEnabled = settingsRow?.data?.overdue !== false; // default ON, matching every other event type
    if (!overdueEnabled) {
      summary.skipped = 'overdue notifications disabled';
    } else {
      const { data: clientRows, error: clientErr } = await supabase.from('ops_clients').select('id, status, data').eq('status', 'active');
      if (clientErr) {
        warnings.push(`clients: ${clientErr.message}`);
      } else {
        const t = new Date().toISOString().slice(0, 10);
        const events = [];
        const clientsToUpdate = [];

        for (const row of clientRows || []) {
          const client = row.data;
          if (!client) continue;
          summary.scanned++;
          let changed = false;
          const scan = (list, locationName) => {
            (list || []).forEach(s => {
              if (!s?.id || !isOverdue(s, t)) return;
              summary.overdueFound++;
              if (s.overdueNotifiedFor === s.due) return; // already notified for this exact cycle
              s.overdueNotifiedFor = s.due;
              changed = true;
              events.push({
                serviceId: s.id, serviceName: s.name, locationName,
                assigneeId: s.assigneeId, clientId: client.id, clientName: client.name, due: s.due,
              });
            });
          };
          scan(client.services, null);
          (client.locations || []).forEach(loc => scan(loc.services, loc.name));
          if (changed) clientsToUpdate.push({ id: row.id, status: row.status, data: client });
        }

        summary.newlyStamped = events.length;

        if (clientsToUpdate.length) {
          const payload = clientsToUpdate.map(c => ({ id: c.id, data: c.data, status: c.status }));
          const { error } = await supabase.from('ops_clients').upsert(payload, { onConflict: 'id' });
          if (error) warnings.push(`clients update: ${error.message}`);
          else summary.clientsUpdated = payload.length;
        }

        if (events.length) {
          // bypassQuietHours (2026-09-15): applied to all four
          // insertNotifications() calls in this file, not only the ones
          // producing the five literally-named daily digest types — this
          // 'overdue' escalation notification fires from the same
          // weekday-11:00-UTC run as those digests, so it would hit the
          // identical Monday-morning quiet-window suppression bug if left
          // ungated (see the fuller reasoning on insertNotifications()'s own
          // opts.bypassQuietHours comment in api/ops-sync.js).
          const { users, admins } = await loadDirectory(supabase);
          const rows = [];
          events.forEach(ev => {
            if (!ev.assigneeId) return;
            resolveNotifyRecipients(ev.assigneeId, users, admins, 'overdue')
              .filter(r => r.id !== ev.assigneeId)
              .forEach(r => {
                const person = personOf(r.id, r.kind, { users, admins });
                rows.push({
                  type: 'overdue', recipientId: r.id, recipientKind: r.kind,
                  recipientName: person?.name || '', recipientEmail: person?.email || '',
                  title: `Overdue: ${ev.serviceName}`,
                  body: `${ev.clientName}${ev.locationName ? ' — ' + ev.locationName : ''} — was due ${ev.due}`,
                  link: '',
                  context: { clientId: ev.clientId, serviceId: ev.serviceId },
                });
              });
          });
          await insertNotifications(supabase, rows, warnings, { bypassQuietHours: true });
          summary.notificationsSent = rows.length;
        }
      }
    }

    // ── Task "Needs Attention" digest + self-reminders (2026-08-20) —
    // entirely separate from the service-overdue escalation block above
    // (different table, different notification types, different
    // recipients) and deliberately NOT gated behind the `overdueEnabled`
    // toggle above, which only ever governed service-overdue escalation —
    // runs every invocation this endpoint fires (11:00 UTC, weekdays). No
    // per-item idempotency stamp (unlike the service block above): a
    // digest/reminder is SUPPOSED to repeat every single day the
    // underlying task is still overdue/due-today, so "today's real state"
    // computed fresh each run is exactly correct, not a bug to guard
    // against.
    //
    // Owner digest -> every super/owner admin, one row each, with the
    // team-wide counts + who's affected. Employee self-reminders -> one
    // row per person who has at least one of their OWN overdue/due-today
    // tasks, framed as a nudge to them, not a report about them (worded in
    // second person, no mention of what admins/managers see).
    try {
      const { data: taskRows, error: taskErr } = await supabase.from('ops_tasks').select('id, data');
      if (taskErr) {
        warnings.push(`tasks: ${taskErr.message}`);
      } else {
        const today = new Date().toISOString().slice(0, 10);
        const tasks = (taskRows || []).map(r => ({ id: r.id, ...r.data }));
        // taskCountsAsOverdueBurden (2026-09-08), not the raw taskIsOverdue
        // — a recurring task due again on schedule doesn't belong in the
        // "Overdue" figure this digest/self-reminder treats as a burden
        // signal. Due-today/Blocked/Unassigned are untouched — different,
        // literal concepts a recurring task can still legitimately be.
        const overdueTasks = tasks.filter(t => taskCountsAsOverdueBurden(t, today));
        const dueTodayTasks = tasks.filter(t => taskIsDueToday(t, today));
        const blockedTasks = tasks.filter(t => t.status === 'Blocked');
        const unassignedTasks = tasks.filter(t => !t.assigneeId);
        summary.tasksOverdue = overdueTasks.length;
        summary.tasksDueToday = dueTodayTasks.length;
        summary.tasksBlocked = blockedTasks.length;
        summary.tasksUnassigned = unassignedTasks.length;

        const { users, admins } = await loadDirectory(supabase);
        const notifRows = [];

        // Owner digest.
        const affectedIds = new Set([...overdueTasks, ...dueTodayTasks, ...blockedTasks].map(t => t.assigneeId).filter(Boolean));
        const affectedNames = [...affectedIds].map(id => personOf(id, users.find(u => u.id === id) ? 'user' : 'admin', { users, admins })?.name).filter(Boolean);
        const digestBody = `Overdue: ${overdueTasks.length} · Due today: ${dueTodayTasks.length} · Blocked: ${blockedTasks.length} · Unassigned: ${unassignedTasks.length}`
          + (affectedNames.length ? ` — affecting ${affectedNames.join(', ')}` : '');
        admins.filter(a => a.level === 'super' || a.level === 'owner').forEach(a => {
          notifRows.push({
            type: 'attentionDigest', recipientId: a.id, recipientKind: 'admin',
            recipientName: a.name || '', recipientEmail: a.email || '',
            title: 'Daily task summary', body: digestBody, link: '', context: {},
          });
        });
        summary.digestSent = admins.filter(a => a.level === 'super' || a.level === 'owner').length;

        // Employee self-reminders — one row per affected person, counting
        // only THEIR own overdue/due-today tasks (never Blocked/Unassigned,
        // which aren't "your own work" concepts).
        const ownCounts = new Map();
        [...overdueTasks, ...dueTodayTasks].forEach(t => {
          if (!t.assigneeId) return;
          const bucket = ownCounts.get(t.assigneeId) || { overdue: 0, dueToday: 0 };
          if (taskCountsAsOverdueBurden(t, today)) bucket.overdue++;
          if (taskIsDueToday(t, today)) bucket.dueToday++;
          ownCounts.set(t.assigneeId, bucket);
        });
        let remindersSent = 0;
        ownCounts.forEach((counts, personId) => {
          const kind = users.find(u => u.id === personId) ? 'user' : 'admin';
          const person = personOf(personId, kind, { users, admins });
          if (!person) return;
          const parts = [];
          if (counts.overdue) parts.push(`${counts.overdue} overdue`);
          if (counts.dueToday) parts.push(`${counts.dueToday} due today`);
          notifRows.push({
            type: 'taskReminder', recipientId: personId, recipientKind: kind,
            recipientName: person.name || '', recipientEmail: person.email || '',
            title: 'You have tasks that need attention',
            body: `You have ${parts.join(' and ')}. Take a look when you get a chance!`,
            link: '', context: {},
          });
          remindersSent++;
        });
        summary.remindersSent = remindersSent;

        await insertNotifications(supabase, notifRows, warnings, { bypassQuietHours: true });
      }
    } catch (err) {
      await logError({ endpoint: 'cron-overdue-check:taskAttention', error: err });
      warnings.push(`taskAttention: ${err.message}`);
    }

    // ── Daily "your focus today" digest (2026-09-02) — one email per
    // active team member, summarizing their OWN overdue / due-soon (today
    // through the next 7 days) / in-progress work, across BOTH ops_tasks
    // AND ops_clients services. Entirely separate from every notification
    // type above (different shape: one full picture per person, not a
    // single-signal escalation or reminder) — runs every invocation,
    // unconditional on any toggle, same as the task-attention block above,
    // and independently re-queries ops_clients (never reuses
    // clientRows/events from the overdue-escalation block above, which
    // only runs when overdueEnabled is true) so this digest is never
    // silently skipped by an unrelated toggle.
    //
    // Deliberately excludes any TASK with assignedDate===today — a
    // same-day assignment already fired its own immediate email via the
    // assignment-notification path (api/ops-sync.js's
    // fireOpsTaskAssignmentNotifications()/fireAssignmentNotifications()),
    // so repeating it in today's digest would be a real duplicate. Services
    // have no equivalent "when was this assigned" field to apply the same
    // check to — flagged in CLAUDE.md rather than guessed at with a proxy.
    try {
      const { data: clientRowsForDigest, error: clientDigestErr } = await supabase.from('ops_clients').select('id, status, data').eq('status', 'active');
      if (clientDigestErr) {
        warnings.push(`clients (focus digest): ${clientDigestErr.message}`);
      } else {
        const today = new Date().toISOString().slice(0, 10);
        const weekOutDate = new Date(); weekOutDate.setDate(weekOutDate.getDate() + 7);
        const weekOut = weekOutDate.toISOString().slice(0, 10);
        const isDueSoon = (due) => !!due && due >= today && due <= weekOut;

        const { users: directoryUsers, admins: directoryAdmins } = await loadDirectory(supabase);
        const isActivePerson = (p) => p && p.status !== 'inactive';

        const focus = new Map(); // personId -> { kind, overdue: [], dueSoon: [], inProgress: [] }
        const bucketFor = (id, kind) => {
          if (!focus.has(id)) focus.set(id, { kind, overdue: [], dueSoon: [], inProgress: [] });
          return focus.get(id);
        };

        // Tasks — independently re-queries ops_tasks (never reuses the
        // `tasks` array from the task-attention block above, which is
        // scoped to that block's own try/catch and unavailable here — same
        // "each block loads its own data" convention as the client query
        // above).
        const { data: taskRowsForDigest, error: taskDigestErr } = await supabase.from('ops_tasks').select('id, data');
        if (taskDigestErr) warnings.push(`tasks (focus digest): ${taskDigestErr.message}`);
        const tasksForDigest = (taskRowsForDigest || []).map(r => ({ id: r.id, ...r.data }));
        tasksForDigest.forEach(t => {
          if (!t.assigneeId || t.status === 'Done' || t.mergedIntoId) return;
          if (t.assignedDate === today) return; // just assigned today -> already emailed
          const kind = directoryUsers.find(u => u.id === t.assigneeId) ? 'user' : 'admin';
          const person = personOf(t.assigneeId, kind, { users: directoryUsers, admins: directoryAdmins });
          if (!isActivePerson(person)) return;
          const b = bucketFor(t.assigneeId, kind);
          const label = t.subject || 'Untitled task';
          if (taskIsOverdue(t, today)) b.overdue.push(`${label} — due ${t.dueDate}`);
          else if (isDueSoon(t.dueDate)) b.dueSoon.push(`${label} — due ${t.dueDate}`);
          if (t.status === 'In progress') b.inProgress.push(label);
        });

        // Services — active clients + franchise locations, same scan shape
        // the service-overdue-escalation block above uses, reusing its
        // isOverdue()/isInactiveService() predicates directly so this can
        // never disagree with that block on what counts as overdue.
        (clientRowsForDigest || []).forEach(row => {
          const client = row.data;
          if (!client) return;
          const scanServices = (list, locationName) => {
            (list || []).forEach(s => {
              if (!s?.id || !s.assigneeId || isInactiveService(s)) return;
              const kind = directoryUsers.find(u => u.id === s.assigneeId) ? 'user' : 'admin';
              const person = personOf(s.assigneeId, kind, { users: directoryUsers, admins: directoryAdmins });
              if (!isActivePerson(person)) return;
              const b = bucketFor(s.assigneeId, kind);
              const label = `${s.name}${locationName ? ' (' + locationName + ')' : ''} — ${client.name}`;
              if (isOverdue(s, today)) b.overdue.push(`${label} — due ${s.due}`);
              else if (!isDoneThisCycle(s, today) && isDueSoon(s.due)) b.dueSoon.push(`${label} — due ${s.due}`);
              if (s.workStatus === 'in_progress') b.inProgress.push(label);
            });
          };
          scanServices(client.services, null);
          (client.locations || []).forEach(loc => scanServices(loc.services, loc.name));
        });

        const focusRows = [];
        focus.forEach((b, personId) => {
          if (!b.overdue.length && !b.dueSoon.length && !b.inProgress.length) return; // empty list -> skip entirely, no email
          const person = personOf(personId, b.kind, { users: directoryUsers, admins: directoryAdmins });
          if (!person || !person.email) return;
          const sections = [];
          if (b.overdue.length) sections.push(`Overdue (${b.overdue.length}):\n${b.overdue.map(x => `• ${x}`).join('\n')}`);
          if (b.dueSoon.length) sections.push(`Due soon (${b.dueSoon.length}):\n${b.dueSoon.map(x => `• ${x}`).join('\n')}`);
          if (b.inProgress.length) sections.push(`In progress (${b.inProgress.length}):\n${b.inProgress.map(x => `• ${x}`).join('\n')}`);
          focusRows.push({
            type: 'focusDigest', recipientId: personId, recipientKind: b.kind,
            recipientName: person.name || '', recipientEmail: person.email,
            title: 'Your focus today',
            body: sections.join('\n\n'),
            link: '', context: {},
          });
        });
        summary.focusDigestSent = focusRows.length;
        // insertNotifications() batches its own outgoing email per
        // recipient (see its own header comment) — one row per person here
        // means exactly one email per person, never per-item.
        await insertNotifications(supabase, focusRows, warnings, { bypassQuietHours: true });
      }
    } catch (err) {
      await logError({ endpoint: 'cron-overdue-check:focusDigest', error: err });
      warnings.push(`focusDigest: ${err.message}`);
    }

    // ── Notification hierarchy + escalation (2026-09-03) — three tiers,
    // one combined block, its own independent query (never reuses the
    // focus-digest block's `focus` map above: that map deliberately drops a
    // task assigned THIS SAME DAY to avoid double-emailing the ASSIGNEE
    // their own new-assignment email — a concern specific to that digest,
    // not to a manager who's never been told about it, so reusing it here
    // would silently UNDER-count a real overdue item for escalation
    // purposes). Runs every invocation, unconditional on any toggle, same
    // convention as the task-attention/focus-digest blocks above.
    //
    // 1. Employee -> manager rollup: any USER with >=5 overdue items whose
    //    managerId is set gets their manager ONE rolled-up email covering
    //    every one of that manager's qualifying reports (Rana->Sherine,
    //    Michael->David, Assmaa->Abby are today's real managerId chains —
    //    this itself is fully generic, not hardcoded to those three names).
    // 2. Manager/admin -> super-admin escalation: any non-super/owner ADMIN
    //    (Sherine, Abby, David today) with >=5 overdue of their OWN work
    //    escalates straight to the super admins, bypassing their own
    //    managerId chain entirely (an admin's overdue load is everyone's
    //    concern at the top, not just their own manager's, if they have one
    //    at all).
    // 3. Super-admin "big-issue" alert: the tier-2 escalation above PLUS a
    //    genuinely separate inactivity signal — anyone (employee or admin)
    //    with no ops_session_activity row (session-ping.js; "no login" is
    //    read as "no session activity of any kind," since a heartbeat can't
    //    exist without a prior start) AND no completed work (a task's
    //    completedAt, or a service's lastDone) since the start of the
    //    previous WORKING day (previousWorkingDayStart() above, skips back
    //    over a weekend). Both halves combine into ONE email per super-admin
    //    recipient, reusing resolveReportRecipients()'s existing "always
    //    Sarah's primary-admin sentinel by her literal id, plus every real
    //    super/owner admin" resolution — the exact "super-admin resolution"
    //    this feature's own spec says to reuse, not a new invented rule.
    try {
      // OVERDUE_ESCALATION_THRESHOLD is now module-level — shared with the
      // overdue self-nag block above (2026-09-18).
      const now = new Date();
      const today2 = now.toISOString().slice(0, 10);
      const cutoff = previousWorkingDayStart(now);
      const cutoffIso = cutoff.toISOString();
      const cutoffDateStr = cutoffIso.slice(0, 10);

      const { users: hUsers, admins: hAdmins } = await loadDirectory(supabase);
      // Linked dual-role pairing (2026-09-17) — see buildCanonicalIdMap()'s
      // own comment above. Applied everywhere below a person's id is used to
      // accumulate or check a per-person signal (overdue count, activity,
      // completed work), so a dual-role person's admin-id-keyed and
      // employee-id-keyed data merge into one total instead of two partial
      // ones, and the inactivity roster reports them exactly once.
      const canonMap = buildCanonicalIdMap(hUsers, hAdmins);

      const { data: hTaskRows, error: hTaskErr } = await supabase.from('ops_tasks').select('id, data');
      if (hTaskErr) warnings.push(`hierarchyEscalation tasks: ${hTaskErr.message}`);
      const hTasks = (hTaskRows || []).map(r => ({ id: r.id, ...r.data }));

      const { data: hClientRows, error: hClientErr } = await supabase.from('ops_clients').select('id, status, data').eq('status', 'active');
      if (hClientErr) warnings.push(`hierarchyEscalation clients: ${hClientErr.message}`);

      // Per-person overdue counts, tasks + services, no same-day exclusion.
      // taskCountsAsOverdueBurden (2026-09-08) — a recurring task due again
      // on schedule never contributes to the escalation-threshold count
      // this tier-1/tier-2 logic is built on; services have no recurring
      // concept, unaffected. bump() canonicalizes the raw assignee id first
      // (2026-09-17) so a linked pair's counts land in one shared bucket.
      const overdueCounts = new Map();
      const bump = (id) => { if (!id) return; const cid = canonicalId(id, canonMap); overdueCounts.set(cid, (overdueCounts.get(cid) || 0) + 1); };
      hTasks.forEach(t => { if (!t.mergedIntoId && taskCountsAsOverdueBurden(t, today2)) bump(t.assigneeId); });
      const scanServiceOverdue = (list) => (list || []).forEach(s => { if (s?.assigneeId && isOverdue(s, today2)) bump(s.assigneeId); });
      (hClientRows || []).forEach(row => {
        const client = row.data; if (!client) return;
        scanServiceOverdue(client.services);
        (client.locations || []).forEach(loc => scanServiceOverdue(loc.services));
      });

      const hierarchyRows = [];

      // Tier 1 — employee -> manager rollup. u.id is already canonical for a
      // linked employee row (canonical = the employee id, see
      // buildCanonicalIdMap()), so overdueCounts.get(u.id) already reflects
      // the merged total with no further lookup change needed here.
      // u.managerId is canonicalized (2026-09-17) so a report whose manager
      // happens to be stored as that manager's linked ADMIN id still merges
      // into the SAME rollup bucket as a report stored against their
      // employee id, instead of splitting one manager's summary into two.
      // Skip-if-linked (2026-09-19, Task 5): a dual-role person (linked via
      // some admin row's linkedUserId, i.e. a VALUE in canonMap) already
      // holds an admin/manager role, so leadership visibility is the right
      // channel for their overdue load — Tier 2 already escalates them.
      // Reporting them here too, in a Tier-1 manager rollup, would
      // double-report the same merged total. Mirrors the skip-if-linked
      // guard Tier 3 already uses (canonMap.has(p.id) there, against the
      // admin row; this is the employee-row equivalent, against the value).
      const linkedEmployeeIds = new Set(canonMap.values());
      const byManager = new Map();
      hUsers.forEach(u => {
        if (linkedEmployeeIds.has(u.id)) return;
        const count = overdueCounts.get(u.id) || 0;
        if (count < OVERDUE_ESCALATION_THRESHOLD) return;
        if (!u.managerId) return;
        const managerId = canonicalId(u.managerId, canonMap);
        if (managerId === u.id) return;
        if (!byManager.has(managerId)) byManager.set(managerId, []);
        byManager.get(managerId).push({ name: u.name || 'A team member', count });
      });
      let managerSummariesSent = 0;
      byManager.forEach((reports, managerId) => {
        const mKind = hUsers.find(u => u.id === managerId) ? 'user' : 'admin';
        const manager = personOf(managerId, mKind, { users: hUsers, admins: hAdmins });
        if (!manager || !manager.email) return;
        hierarchyRows.push({
          type: 'managerOverdueSummary', recipientId: managerId, recipientKind: mKind,
          recipientName: manager.name || '', recipientEmail: manager.email,
          title: 'Overdue summary for your team',
          body: reports.map(r => `${r.name}: ${r.count} overdue`).join('\n'),
          link: '', context: {},
        });
        managerSummariesSent++;
      });

      // Tier 2 — manager/admin -> super-admin escalation. a.id is
      // canonicalized (2026-09-17) — a linked admin row's own id is an
      // ALIAS in canonMap, so this now reads the same merged total
      // overdueCounts bump() already accumulated under the person's
      // employee id, instead of only ever seeing whatever fraction of their
      // work happened to be assigned under the bare admin id.
      const escalatingAdmins = hAdmins.filter(a => a.level !== 'super' && a.level !== 'owner' && (overdueCounts.get(canonicalId(a.id, canonMap)) || 0) >= OVERDUE_ESCALATION_THRESHOLD);

      // Tier 3 — inactivity: no session activity and no completed work since
      // the previous working day. Every raw id is canonicalized the instant
      // it's added to activeSince/completedSince (2026-09-17) — a real login
      // through a linked pair always logs session-ping activity under the
      // employee id already (api/ops-auth.js's dual-role branch always sets
      // session.id to employeeRow.id), but canonicalizing here too is what
      // correctly merges any HISTORICAL activity/completed-work still
      // sitting under the admin id from before the accounts were linked, or
      // from any other write path that used the bare admin identity.
      const { data: activityRows, error: activityErr } = await supabase.from('ops_session_activity').select('user_id').gte('created_at', cutoffIso);
      if (activityErr) warnings.push(`hierarchyEscalation activity: ${activityErr.message}`);
      const activeSince = new Set((activityRows || []).map(r => canonicalId(r.user_id, canonMap)));
      const completedSince = new Set();
      hTasks.forEach(t => { if (t.assigneeId && t.completedAt && t.completedAt >= cutoffIso) completedSince.add(canonicalId(t.assigneeId, canonMap)); });
      const scanServiceCompleted = (list) => (list || []).forEach(s => { if (s?.assigneeId && s.lastDone && s.lastDone >= cutoffDateStr) completedSince.add(canonicalId(s.assigneeId, canonMap)); });
      (hClientRows || []).forEach(row => {
        const client = row.data; if (!client) return;
        scanServiceCompleted(client.services);
        (client.locations || []).forEach(loc => scanServiceCompleted(loc.services));
      });
      const inactivePeople = [];
      [...hUsers, ...hAdmins].forEach(p => {
        if (!p.id || p.id === 'primary-admin' || p.status === 'inactive') return;
        // A linked admin row is never evaluated here as a second, separate
        // person (2026-09-17) — canonMap.has(p.id) is true exactly for a
        // valid-link admin id, and that person is already represented once,
        // canonically, via their employee row's own iteration below.
        if (canonMap.has(p.id)) return;
        if (activeSince.has(p.id) || completedSince.has(p.id)) return;
        inactivePeople.push(p.name || p.id);
      });

      // Tiers 2+3 combine into one "big-issue" email per super-admin recipient.
      if (escalatingAdmins.length || inactivePeople.length) {
        const sections = [];
        if (escalatingAdmins.length) {
          // overdueCounts.get(canonicalId(a.id, canonMap)) (2026-09-17) —
          // same canonicalization as the escalatingAdmins filter itself
          // above; must match it exactly, or a linked admin's DISPLAYED
          // count would silently disagree with the merged total that
          // decided she belongs in this section at all.
          sections.push(`Manager/admin overdue (${OVERDUE_ESCALATION_THRESHOLD}+):\n`
            + escalatingAdmins.map(a => `• ${a.name}: ${overdueCounts.get(canonicalId(a.id, canonMap))} overdue`).join('\n'));
        }
        if (inactivePeople.length) {
          sections.push(`Inactive since ${cutoffDateStr} (no login, no completed work):\n`
            + inactivePeople.map(n => `• ${n}`).join('\n'));
        }
        const body = sections.join('\n\n');
        resolveReportRecipients(null, hAdmins).forEach(r => {
          // Same primary-admin-sentinel special case resolveReportRecipients()'s
          // own other callers already need — she has no ops_admins row.
          const isPrimary = r.id === 'primary-admin';
          const person = isPrimary ? null : personOf(r.id, r.kind, { users: hUsers, admins: hAdmins });
          hierarchyRows.push({
            type: 'superAdminAlert', recipientId: r.id, recipientKind: r.kind,
            recipientName: isPrimary ? 'Sarah Samy' : (person?.name || ''),
            recipientEmail: isPrimary ? 'ssamy@weblightmedia.com' : (person?.email || ''),
            title: 'Daily big-issue alert',
            body, link: '', context: {},
          });
        });
      }

      summary.managerSummariesSent = managerSummariesSent;
      summary.escalatingAdminsCount = escalatingAdmins.length;
      summary.inactivePeopleCount = inactivePeople.length;
      await insertNotifications(supabase, hierarchyRows, warnings, { bypassQuietHours: true });
    } catch (err) {
      await logError({ endpoint: 'cron-overdue-check:hierarchyEscalation', error: err });
      warnings.push(`hierarchyEscalation: ${err.message}`);
    }

    return res.status(200).json({ ok: true, summary, warnings });
  } catch (err) {
    await logError({ endpoint: 'cron-overdue-check', error: err });
    return res.status(500).json({ error: err.message });
  }
}
