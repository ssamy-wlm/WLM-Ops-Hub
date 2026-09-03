// Never lands a due/next-due date on a weekend (2026-09-02): Saturday
// snaps to the Friday before, Sunday snaps to the Monday after. Shared by
// every SERVER-SIDE path that sets or estimates a due date
// (api/process-transcript.js's parser estimation, api/ops-sync.js's
// self-assign auto-daily) — the one place server-side code can actually
// share this, since api/*.js files are otherwise independent serverless
// functions. The three browser-side portals (client.html/user.html/
// index.html) each carry their OWN copy of the identical algorithm under
// the same name, per this codebase's zero-shared-code rule for frontends
// (CLAUDE.md rule #3) — client.html's/user.html's pre-existing
// `adjustOffWeekend()` already implements this same rule for recurring
// service due dates; this file is the new, equivalent piece for
// server-side task due dates.
export function clampToWeekday(dateStr) {
  if (!dateStr) return dateStr;
  const parts = String(dateStr).slice(0, 10).split('-').map(Number);
  if (parts.length !== 3 || parts.some(n => Number.isNaN(n))) return dateStr;
  const [y, m, dd] = parts;
  const d = new Date(y, m - 1, dd);
  const day = d.getDay(); // 0=Sun...6=Sat
  if (day === 6) d.setDate(d.getDate() - 1);      // Saturday -> Friday before
  else if (day === 0) d.setDate(d.getDate() + 1); // Sunday -> Monday after
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
