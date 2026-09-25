// Per-team weekend email quiet hours (2026-09-13) — shared by every
// sendResendEmail() NOTIFICATION path (api/ops-sync.js's insertNotifications(),
// api/cron-overdue-check.js's digests/escalations/reminders,
// api/send-assignment-email.js, api/inbound-email.js's confirmation reply).
// Deliberately NOT applied to api/cron-backup.js's off-site backup email —
// that's data safety, not a notification, and always sends regardless of
// day/time (see that file's own header comment).
//
// Suppression is email-only: a suppressed notification's in-app row (the
// bell/ops_notifications insert) still happens exactly as before — only the
// Resend send is skipped. Nothing is lost long-term: an overdue/digest item
// that would have emailed on a Saturday just re-surfaces in the very next
// (Monday-morning-or-later) run once quiet hours end, same as any other day
// this cron/endpoint didn't happen to fire.
//
// Real IANA timezone conversion via Intl.DateTimeFormat({timeZone}) — never
// a hardcoded UTC offset — so both US daylight saving (EST/EDT) and Egypt's
// own DST are handled automatically by the ICU/tz database Node already
// ships with, with no manual date math to get wrong across a DST boundary.
const WEEKDAY_INDEX = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

// Same "midnight sometimes reports as hour 24 under hour12:false" fix
// api/cron-overdue-check.js's own cairoLocalParts() already established —
// reused here as the identical, already-proven technique, not reinvented.
// Exported (2026-09-25) so api/cron-weekly-team-completion.js and
// api/cron-pto-report.js can gate their own send times on true
// America/New_York local time (DST-aware, via the real IANA tz database —
// never a hardcoded UTC offset) the same way this file already gates email
// quiet hours — rather than each duplicating its own copy of this exact
// Intl.DateTimeFormat technique. `day` (day-of-month) is additive: every
// existing caller here only ever reads `.weekday`/`.hour`/`.minute`, so
// this stays a strictly backward-compatible extension.
export function localPartsInTz(date, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false, weekday: 'short', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric',
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map(p => [p.type, p.value]));
  let hour = parseInt(parts.hour, 10);
  if (hour === 24) hour = 0;
  const minute = parseInt(parts.minute, 10);
  return {
    weekday: parts.weekday, hour, minute,
    day: parseInt(parts.day, 10), month: parseInt(parts.month, 10), year: parseInt(parts.year, 10),
  };
}

// Expresses a local weekday+hour+minute as minutes elapsed since Monday
// 00:00 local time (0..10079) — turns the Friday-evening-to-Monday-morning
// window, which otherwise wraps across the end of a Mon-start week, into a
// single "before X or after Y" comparison with no date-boundary arithmetic.
function minutesSinceMonday({ weekday, hour, minute }) {
  const dayIdx = WEEKDAY_INDEX[weekday];
  return dayIdx * 1440 + hour * 60 + minute;
}

const QUIET_WINDOWS = {
  // Friday 18:00 -> Monday 08:00, America/New_York.
  US: { timeZone: 'America/New_York', startMinutes: 4 * 1440 + 18 * 60, endMinutes: 0 * 1440 + 8 * 60 },
  // Friday 19:00 -> Monday 10:00, Africa/Cairo. Also the default for an
  // unset/unrecognized team, matching this codebase's existing convention
  // (index.html: `u.team || 'Egypt'`).
  Egypt: { timeZone: 'Africa/Cairo', startMinutes: 4 * 1440 + 19 * 60, endMinutes: 0 * 1440 + 10 * 60 },
};

// isWithinQuietHours(recipientTeam, now?) -> boolean. `now` defaults to the
// real current time; accepting it as a parameter is what makes this
// deterministically unit-testable without mocking global Date.
export function isWithinQuietHours(recipientTeam, now = new Date()) {
  const win = QUIET_WINDOWS[recipientTeam] || QUIET_WINDOWS.Egypt;
  const minutes = minutesSinceMonday(localPartsInTz(now, win.timeZone));
  return minutes >= win.startMinutes || minutes < win.endMinutes;
}
