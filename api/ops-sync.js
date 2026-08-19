// Replaces PUT /api/cloud-data. Instead of overwriting the whole shared
// record, this endpoint upserts ONLY the specific rows the caller says
// changed. There is no "replace all" code path anywhere in this file, which
// is what makes the old "empty/stale browser silently wipes everyone else's
// data" bug structurally impossible here — a browser with a stale or empty
// local cache simply has nothing to send.
//
// Body shape: { changes: { users?, admins?, clients?, goals?, feed?,
// messages?, roadmapTasks?, timeOffRequests?, timeOffLedger?, payroll?,
// summaries?, settings?, orgNodes?, orgLinks?, catalogSuggestions?,
// notifications?, salesFunnel?, salesFunnelGrants? },
// tombstones?: { users?: [ids], orgNodes?: [ids], orgLinks?: [ids] },
// restoreUserIds?: [ids] }
//
// orgNodes/orgLinks tombstones set `deleted_at` on the targeted row(s) in
// place (ops_org_nodes/ops_org_links) rather than a separate exclusion
// table — those tables already carry/gain a `deleted_at` column for this
// exact purpose (see the migration adding it to ops_org_links). ops-state.js
// filters both on `deleted_at is null`. Never a hard SQL DELETE.
//
// Every array in `changes` is a list of ONLY the records that actually
// changed (new or edited) — never the full dataset. Role comes from the
// signed session token, never from the request body.
//
// Notifications (assignment / time-off decision / new message) are NEVER
// created via `changes.notifications` — the client can only mark its own
// rows read there. Every notification row is created server-side, inside
// the clients/timeOffRequests/messages write paths below, at the exact
// moment the triggering write happens in THIS request (current row already
// fetched vs. incoming row in the same request body) — never by a
// page-load or scheduled scan diffing old vs new state over time. That
// load-time whole-record diffing pattern is what corrupted data before and
// is deliberately not used anywhere in this file.

import { getSupabaseAdmin } from '../lib/supabaseAdmin.js';
import { requireSession, tierOf, canEditUsers } from '../lib/opsSession.js';
import { sendResendEmail, buildEmailHtml } from '../lib/resendClient.js';
import { logError } from '../lib/errorLog.js';
import { isHashed, hashPassword, verifyPassword } from '../lib/passwordHash.js';

// NOTE: the Blob-era task-change email notifications (api/_task-notifications.js)
// are deferred to a follow-up PR — they depended on the whole-record diffing
// this endpoint intentionally no longer does. On-demand assignment emails
// (api/send-assignment-email.js) are untouched and still work.

// Three access bands (see lib/opsSession.js tierOf() for the level mapping):
//   'super'   — unrestricted.
//   'manager' — every other admin level: team + client management, but NOT
//               payroll/pay rates and NOT business settings/org chart/roadmap.
//   'member'  — clients only, restricted to their own assigned items.
// Dropped for members outright (never a legitimate member write); within the
// isAdmin branch below, admins/roadmapTasks/orgNodes/orgLinks/timeOffLedger/
// settings are further narrowed to tier === 'super' only.
const ADMIN_TABLES = new Set(['users', 'admins', 'roadmapTasks', 'timeOffLedger', 'payroll', 'summaries', 'orgNodes', 'orgLinks', 'settings']);
const PAYROLL_FIELDS = ['payRate', 'hours'];

// Sales Funnel access level resolution — kept identical to (but deliberately
// not imported from) api/ops-state.js's own copy, same duplicate-not-shared
// convention as every other cross-file helper in this codebase. A row whose
// own admin `level` is super/owner always resolves to 'owner'; otherwise an
// explicit salesFunnelLevel wins, falling back to 'editor' for a legacy
// salesFunnelAccess:true (from before the 3-tier upgrade) so nobody's access
// silently changes — this is read-only, recomputed fresh every request,
// never written back, so there is no migration step to run.
const FUNNEL_SUPER_LEVELS = new Set(['super', 'owner']);
function funnelLevelOf(row) {
  if (FUNNEL_SUPER_LEVELS.has(row?.level)) return 'owner';
  if (row?.salesFunnelLevel) return row.salesFunnelLevel;
  if (row?.salesFunnelAccess === true) return 'editor';
  return null;
}

function hasContent(v) { return v !== undefined && v !== null && v !== ''; }

// ── per-table row guards: never let an empty/missing record overwrite a real one ──
function validUserOrAdmin(row) {
  return row && typeof row === 'object' && hasContent(row.id) && (hasContent(row.name) || hasContent(row.email));
}
function validClient(row) {
  return row && typeof row === 'object' && hasContent(row.id) && hasContent(row.name);
}
function validGeneric(row) {
  return row && typeof row === 'object' && hasContent(row.id);
}

// A NEW incoming ops_users/ops_admins row may carry a plaintext password
// (account creation, an admin/manager password reset, "Grant manager role"'s
// initial password) — the client only ever sends a fresh plaintext value
// here, never an existing hash round-tripped back (see api/ops-state.js's
// unconditional password strip), so hash any password field present before
// it reaches storage. isHashed() guards against double-hashing in the
// unlikely event a hash rides along anyway.
function hashIncomingPasswords(rows) {
  return rows.map(r => (hasContent(r.password) && !isHashed(r.password)) ? { ...r, password: hashPassword(r.password) } : r);
}

// api/ops-state.js strips `password` from every user/admin record before it
// ever reaches a browser, for every tier — so the client-side cache an
// ordinary edit (title, phone, role, etc., no new password typed) is built
// from NEVER has a password field to begin with, and the resulting payload
// carries no `password` key at all. upsertRows() below does a full JSONB
// replace of `data`, not a merge, so without this the account's stored
// password/hash would be silently deleted by any unrelated field edit —
// same class of bug preserveMissingPayrollFields() above exists to prevent
// for payRate/hours, after the real incident that pattern is named for.
// Only fills the gap when the incoming row is missing the field entirely;
// an incoming row that DOES carry a password (a deliberate new one) always
// wins, same "incoming wins if present" rule as the payroll helper.
function preserveMissingPasswordField(incoming, current) {
  if (!current || hasContent(incoming.password)) return incoming;
  return { ...incoming, password: current.password };
}

// A genuine password change (this row existed before, and the incoming
// payload itself carries a new password value — not one merely carried
// forward by preserveMissingPasswordField above, which is why this must run
// BEFORE that) invalidates that account's existing sessions, so a stolen
// pre-change token can't keep riding on the old credentials. Must run on the
// RAW incoming row, before any other transform fills in a missing password
// field, or a same-value carry-forward would be indistinguishable from a
// real change by the time it reaches here.
export function stampSessionRevocationOnPasswordChange(incoming, current) {
  if (!current || !hasContent(incoming.password)) return incoming;
  return { ...incoming, sessionsRevokedAt: new Date().toISOString() };
}

// Manager tier may edit users (team management) but never payroll/pay-rate
// fields — those stay Super Admin/CEO exclusive. Preserves the CURRENT value
// for any protected field rather than silently accepting whatever the payload
// carried, so an unrelated title/role edit isn't blocked by a stale payRate
// riding along in the same payload.
function stripPayrollFields(incoming, current) {
  const row = { ...incoming };
  PAYROLL_FIELDS.forEach(f => { row[f] = current ? current[f] : undefined; });
  return row;
}

// Super/CEO tier MAY write payroll fields, but a save must never CLEAR them
// as a side effect of an unrelated write — only an explicit edit should. A
// broad dirty-sync push (cloudAutoSync()) can carry a user record whose
// local cache copy of payRate/hours is genuinely missing (stale/partial
// cache, a form that never round-tripped those fields, etc.), with no way
// for the server to otherwise tell that apart from a deliberate clear. So:
// fall back to the CURRENT db value only when the incoming field is
// actually missing (undefined/null/''); a real, deliberate value — including
// an explicit 0 — always wins. Brand-new users (no current row) pass through
// unmodified, same as `stripPayrollFields` above.
function preserveMissingPayrollFields(incoming, current) {
  if (!current) return incoming;
  const row = { ...incoming };
  PAYROLL_FIELDS.forEach(f => { if (!hasContent(row[f])) row[f] = current[f]; });
  return row;
}

// ── member client-write validation ──────────────────────────────────────────
// A member may edit ONLY items they're assigned to: services[]/
// recurringServices[] (matched by assigneeId/assigneeName/assignedUserIds —
// the actual convention this app uses, see index.html ~5722-5723) and
// projects whose progress/progressLog they're updating (userUpdateProgress())
// via an assigned service, or whose tasks are assigned to them directly
// (userMarkTaskDone()). ANY other change — to the client itself, to another
// person's items — REJECTS THE WHOLE WRITE with a clear reason; nothing is
// silently merged or dropped.
export function isAssignedToMember(item, memberId, memberName) {
  if (!item) return false;
  if (item.assigneeId === memberId) return true;
  if (Array.isArray(item.assigneeIds) && item.assigneeIds.includes(memberId)) return true;
  if (Array.isArray(item.assignedUserIds) && item.assignedUserIds.includes(memberId)) return true;
  // Assignment-module Feature B: a member assigned ONLY to one sub-item
  // (not the whole service) still needs to be able to save that one write
  // (checking their own step off) — checkMemberClientWrite() authorizes at
  // the whole-service granularity, there's no per-field write path, so this
  // is a write-authorization allowance, not a scoping widening: it doesn't
  // touch _svcAssignedTo()/badge counts/the Services-tab filter, which stay
  // scoped to the service's own assigneeIds exactly as before.
  if (Array.isArray(item.subitems) && item.subitems.some(si => si && si.assigneeId === memberId)) return true;
  const assigneeName = String(item.assigneeName || item.assignee || '').trim().toLowerCase();
  const nameLower = String(memberName || '').trim().toLowerCase();
  return !!nameLower && assigneeName === nameLower;
}

// A currently-non-empty list key that's entirely ABSENT from the incoming
// payload is NOT the same as the member explicitly clearing it to [] — an
// absent key collapses to [] downstream (diffArrayById's `oldArr || []`)
// and reads as "every item removed," which gets authorized if the member
// happens to be assigned to all of them. Catch it before that diff ever
// runs, so an omitted key (a client bug, a partial payload) can never
// silently wipe a list nobody meant to touch.
function listKeyMissingButNonEmpty(current, incoming, key) {
  return Array.isArray(current[key]) && current[key].length > 0 && !(key in incoming);
}

function diffArrayById(oldArr, newArr) {
  const oldById = new Map((oldArr || []).filter(x => x && x.id != null).map(x => [String(x.id), x]));
  const newById = new Map((newArr || []).filter(x => x && x.id != null).map(x => [String(x.id), x]));
  const changed = [];
  for (const [id, item] of newById) {
    const prev = oldById.get(id);
    if (!prev || JSON.stringify(prev) !== JSON.stringify(item)) changed.push({ id, prev, next: item });
  }
  for (const [id, item] of oldById) {
    if (!newById.has(id)) changed.push({ id, prev: item, next: null });
  }
  return changed;
}

const CLIENT_SCALAR_KEYS_MEMBER_MAY_NOT_TOUCH = [
  'name', 'status', 'pinned', 'color', 'code', 'industry', 'accountManager',
  'clientName', 'clientEmail', 'clientPhone', 'referredBy', 'notes',
  'internalNotes', 'website', 'logo', 'brandColors', 'brandDetails', 'startDate',
  // Task-assignment email-matching data (Task Assignments feature) — loaded
  // via a one-time admin salvage import, never a member-facing edit.
  'clientEmails',
];

// A member editing an EXISTING task assigned to them (Daily Tasks) may only
// touch status/notes/tags — everything else (who it's for, what it's
// about, where it lives) is admin-only, same allow-list-of-untouchable-
// fields pattern as CLIENT_SCALAR_KEYS_MEMBER_MAY_NOT_TOUCH above.
const TASK_KEYS_MEMBER_MAY_NOT_TOUCH = [
  'subject', 'clientId', 'clientName', 'assigneeId', 'assignedById',
  'category', 'type', 'priority', 'dueDate', 'source', 'origin',
  'emailReceivedDate', 'emailThreadId',
];

// Returns { allowed: true } or { allowed: false, reason } — never a partial merge.
export function checkMemberClientWrite(current, incoming, memberId, memberName) {
  for (const key of CLIENT_SCALAR_KEYS_MEMBER_MAY_NOT_TOUCH) {
    if (JSON.stringify(current[key]) !== JSON.stringify(incoming[key])) {
      return { allowed: false, reason: `members cannot edit client.${key}` };
    }
  }

  for (const listKey of ['services', 'recurringServices']) {
    if (listKeyMissingButNonEmpty(current, incoming, listKey)) {
      return { allowed: false, reason: `client.${listKey} is missing from the payload — refusing to treat that as "remove everything"` };
    }
    for (const { id, prev, next } of diffArrayById(current[listKey], incoming[listKey])) {
      const item = next || prev;
      if (!isAssignedToMember(item, memberId, memberName)) {
        return { allowed: false, reason: `not assigned to ${listKey} item ${id}` };
      }
    }
  }

  // Franchises/locations (e.g. Servpro -> Yonkers): each holds its own
  // services[], diffed the same way as top-level services above. Members can
  // never add/remove/rename a location itself — that's structural, admin-only,
  // like the scalar keys above.
  // Compared by id-set, not array position — a client-side reorder of
  // locations[] (e.g. a drag-reorder, or an unrelated resave that happens to
  // resort the array) must never look like "members renamed/removed a
  // franchise" just because index i no longer lines up.
  const curLocs = current.locations || [], incLocs = incoming.locations || [];
  const incLocsById = new Map(incLocs.map(l => [l.id, l]));
  const locsStructurallyEqual = curLocs.length === incLocs.length
    && curLocs.every(l => incLocsById.get(l.id)?.name === l.name);
  if (!locsStructurallyEqual) {
    return { allowed: false, reason: 'members cannot add/remove/rename franchises (locations)' };
  }
  for (const loc of curLocs) {
    const incLoc = incLocs.find(l => l.id === loc.id);
    if (incLoc && listKeyMissingButNonEmpty(loc, incLoc, 'services')) {
      return { allowed: false, reason: `location ${loc.id} services is missing from the payload — refusing to treat that as "remove everything"` };
    }
    for (const { id, prev, next } of diffArrayById(loc.services, incLoc?.services)) {
      const item = next || prev;
      if (!isAssignedToMember(item, memberId, memberName)) {
        return { allowed: false, reason: `not assigned to location ${loc.id} service ${id}` };
      }
    }
  }

  for (const { id, prev, next } of diffArrayById(current.projects, incoming.projects)) {
    const project = next || prev;
    const projectAssigned =
      isAssignedToMember(project, memberId, memberName) ||
      (Array.isArray(project?.users) && project.users.includes(memberId));
    // A project with no explicit assignee (the common case — progress/
    // progressLog updates via userUpdateProgress()) is touchable if it
    // belongs to an already-assigned service, matched by name.
    const belongsToAssignedService = (incoming.services || current.services || []).some(
      s => s.name === project?.name && isAssignedToMember(s, memberId, memberName)
    );
    if (!projectAssigned && !belongsToAssignedService) {
      return { allowed: false, reason: `not assigned to project ${id}` };
    }
    // Task-level assignment inside a project/subproject (userMarkTaskDone()) is
    // always allowed once the project itself is touchable by this member —
    // task.assigneeId narrows WHICH tasks display as theirs client-side, but
    // the project-level assignment above is what actually gates the write.
  }

  return { allowed: true };
}

// ── Notifications ────────────────────────────────────────────────────────
// Fired ONLY from inside the write paths below, at the exact moment a
// relevant change is written in THIS request — never by a page-load or
// scheduled scan comparing old vs new state across time. Each event compares
// the "current" row already fetched for this same request against the
// "incoming" row in the same request's body, which is the legitimate,
// non-corrupting version of "diff old vs new": the diff only ever spans one
// write, never a background reconciliation pass.
let _notifSettingsCache; // per-request cache, avoids re-querying ops_settings per event
export async function getNotificationSettings(supabase) {
  if (_notifSettingsCache) return _notifSettingsCache;
  const { data } = await supabase.from('ops_settings').select('data').eq('key', 'notificationSettings').maybeSingle();
  _notifSettingsCache = { assignment: true, timeOff: true, message: true, serviceUpdate: true, done: true, overdue: true, submittedForReview: true, ...(data?.data || {}) };
  return _notifSettingsCache;
}

function genNotifId() {
  return `notif_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

// Per-admin "team activity" notification-type toggles (managedUserIds-based
// escalation + opt-in broadcast to owner/super) — see resolveNotifyRecipients
// below. Stored per-admin in ops_settings (key 'teamNotifPrefs_<adminId>'),
// never a field on the ops_users/ops_admins row itself (same reasoning as
// tourFlags — works uniformly for the primary-admin sentinel, which has no
// row). "assigned"/"comment" default OFF (noisier events); "done"/"overdue"
// default ON, matching the spec's requested defaults.
export const DEFAULT_TEAM_NOTIF_PREFS = { assigned: false, done: true, comment: false, overdue: true, broadcastAll: false };

// Resolves "the affected person + their admin/manager": the assignee
// themselves, plus — in order of preference — their configured manager
// (users[].managerId), or any admin scoped to them (admins[].assignedUsers),
// or, if neither is configured, every super/owner admin as a fallback so a
// notification is never silently dropped for lack of a configured manager.
//
// `teamEventType` ('assigned'|'done'|'comment'|'overdue'), when passed,
// ADDITIVELY escalates to two more kinds of recipient, on top of whatever
// the block above already resolved: (a) any admin whose managedUserIds[]
// (id-based — unlike the dead name-based assignedUsers escalation above)
// includes this person, and (b) any owner/super admin who's opted into
// teamNotifPrefs.broadcastAll — each gated by that admin's OWN
// teamNotifPrefs[teamEventType] toggle. Existing dedup-by-id below means an
// admin who's already a recipient via managerId/assignedUsers/fallback is
// never double-notified just because they're also a manager or broadcaster.
export function resolveNotifyRecipients(userId, users, admins, teamEventType) {
  // A service/task can be assigned to either a team member OR an admin —
  // detect which so the primary recipient's own kind is stored correctly
  // (personOf() below looks them up in the matching list).
  const user = users.find(u => u.id === userId);
  const primaryKind = user ? 'user' : (admins.some(a => a.id === userId) ? 'admin' : 'user');
  const out = [{ id: userId, kind: primaryKind }];
  if (user && user.managerId && user.managerId !== userId) {
    const asAdmin = admins.find(a => a.id === user.managerId);
    const asUser = users.find(u => u.id === user.managerId);
    if (asAdmin) out.push({ id: user.managerId, kind: 'admin' });
    else if (asUser) out.push({ id: user.managerId, kind: 'user' });
  } else {
    const scoped = admins.filter(a => Array.isArray(a.assignedUsers) && a.assignedUsers.includes(userId));
    if (scoped.length) scoped.forEach(a => out.push({ id: a.id, kind: 'admin' }));
    else admins.filter(a => a.level === 'super' || a.level === 'owner').forEach(a => out.push({ id: a.id, kind: 'admin' }));
  }
  if (teamEventType) {
    admins.forEach(a => {
      if (a.id === userId) return;
      const prefs = a.teamNotifPrefs || DEFAULT_TEAM_NOTIF_PREFS;
      const isManager = Array.isArray(a.managedUserIds) && a.managedUserIds.includes(userId);
      const isBroadcaster = (a.level === 'super' || a.level === 'owner') && prefs.broadcastAll;
      if ((isManager || isBroadcaster) && prefs[teamEventType]) out.push({ id: a.id, kind: 'admin' });
    });
  }
  const seen = new Set();
  return out.filter(r => (seen.has(r.id) ? false : seen.add(r.id)));
}

export function assigneeChanged(prev, next) {
  const prevId = prev?.assigneeId || '';
  const nextId = next?.assigneeId || '';
  return nextId && nextId !== prevId;
}

// Multiple assignees per service (assigneeIds[], see CLAUDE.md's assignment-
// module project, Feature A): returns every id present in the incoming
// service's assigneeIds that was NOT already on the current DB row — i.e.
// exactly the people newly added in THIS write, never someone already
// assigned (re-saving an unchanged assignment fires nothing) and never
// someone who was removed. Falls back to the single assigneeId/assignedUserIds
// fields for a service that hasn't been migrated to assigneeIds yet, so an
// old-style single reassignment still fires its one notification exactly as
// it always did.
function currentAssigneeIdSet(svc) {
  if (Array.isArray(svc?.assigneeIds) && svc.assigneeIds.length) return new Set(svc.assigneeIds);
  if (Array.isArray(svc?.assignedUserIds) && svc.assignedUserIds.length) return new Set(svc.assignedUserIds);
  return new Set(svc?.assigneeId ? [svc.assigneeId] : []);
}
export function newlyAssignedServiceIds(prev, next) {
  const prevIds = currentAssigneeIdSet(prev);
  return [...currentAssigneeIdSet(next)].filter(id => id && !prevIds.has(id));
}

// Walks one client's services (top-level + every franchise location's own
// services) comparing current vs incoming, returning one event per service
// PER newly-added assignee in THIS write (see newlyAssignedServiceIds above).
export function collectServiceAssignmentEvents(client, curClient, incClient) {
  const events = [];
  const scan = (curList, incList, locationName) => {
    const curById = new Map((curList || []).filter(s => s?.id).map(s => [s.id, s]));
    (incList || []).forEach(s => {
      if (!s?.id) return;
      const prev = curById.get(s.id);
      newlyAssignedServiceIds(prev, s).forEach(assigneeId => {
        events.push({
          serviceId: s.id, serviceName: s.name, locationName,
          assigneeId, clientId: client.id, clientName: client.name,
        });
      });
    });
  };
  scan(curClient.services, incClient.services, null);
  const curLocs = curClient.locations || [], incLocs = incClient.locations || [];
  incLocs.forEach(loc => {
    const curLoc = curLocs.find(l => l.id === loc.id);
    scan(curLoc?.services, loc.services, loc.name);
  });
  return events;
}

// Assignment-module Feature B: a sub-item's assigneeId is single-valued
// (one person per step, not an array like a service's assigneeIds), so this
// reuses the same single-id assigneeChanged() comparison collectTaskAssignmentEvents
// already uses for tasks — walks each service's subitems[] (current vs
// incoming, same request), firing one event per sub-item whose assignee
// newly changed in THIS write. A sub-item assignment event is intentionally
// SEPARATE from a service assignment event (see newlyAssignedServiceIds) —
// assigning a step never touches the service's own assigneeIds.
export function collectSubitemAssignmentEvents(client, curClient, incClient) {
  const events = [];
  const scanSubitems = (curSvc, incSvc, locationName) => {
    if (!Array.isArray(incSvc?.subitems)) return;
    const curById = new Map((curSvc?.subitems || []).filter(si => si?.id).map(si => [si.id, si]));
    incSvc.subitems.forEach(si => {
      if (!si?.id) return;
      const prev = curById.get(si.id);
      if (assigneeChanged(prev, si)) {
        events.push({
          subitemId: si.id, subitemText: si.text, serviceId: incSvc.id, serviceName: incSvc.name,
          locationName, assigneeId: si.assigneeId, clientId: client.id, clientName: client.name,
        });
      }
    });
  };
  const scanServices = (curList, incList, locationName) => {
    const curById = new Map((curList || []).filter(s => s?.id).map(s => [s.id, s]));
    (incList || []).forEach(s => scanSubitems(curById.get(s.id), s, locationName));
  };
  scanServices(curClient.services, incClient.services, null);
  const curLocs2 = curClient.locations || [], incLocs2 = incClient.locations || [];
  incLocs2.forEach(loc => {
    const curLoc = curLocs2.find(l => l.id === loc.id);
    scanServices(curLoc?.services, loc.services, loc.name);
  });
  return events;
}

// Same idea for project tasks (top-level tasks + subproject tasks).
export function collectTaskAssignmentEvents(client, curClient, incClient) {
  const events = [];
  const curProjById = new Map((curClient.projects || []).filter(p => p?.id).map(p => [p.id, p]));
  (incClient.projects || []).forEach(proj => {
    const curProj = curProjById.get(proj.id);
    const scanTasks = (curTasks, incTasks, subName) => {
      const curById = new Map((curTasks || []).filter(t => t?.id).map(t => [t.id, t]));
      (incTasks || []).forEach(t => {
        if (!t?.id) return;
        const prev = curById.get(t.id);
        if (assigneeChanged(prev, t)) {
          events.push({
            taskId: t.id, taskName: t.name || t.text, projectName: proj.name, subName,
            assigneeId: t.assigneeId, clientId: client.id, clientName: client.name,
          });
        }
      });
    };
    scanTasks(curProj?.tasks, proj.tasks, null);
    const curSubById = new Map((curProj?.subprojects || []).filter(sp => sp?.id).map(sp => [sp.id, sp]));
    (proj.subprojects || []).forEach(sp => {
      const curSub = curSubById.get(sp.id);
      scanTasks(curSub?.tasks, sp.tasks, sp.name);
    });
  });
  return events;
}

// Same "current vs incoming, same request" comparison as
// collectServiceAssignmentEvents above — walks a service's updates[] thread
// (Monday feature pack #1: service comments) and returns one event per
// update newly APPENDED in THIS write, detected by id so a client whose
// updates[] didn't change produces zero events regardless of how many prior
// updates already existed on that service.
export function collectServiceUpdateEvents(client, curClient, incClient) {
  const events = [];
  const scan = (curList, incList, locationName) => {
    const curById = new Map((curList || []).filter(s => s?.id).map(s => [s.id, s]));
    (incList || []).forEach(s => {
      if (!s?.id || !Array.isArray(s.updates)) return;
      const prev = curById.get(s.id);
      const prevUpdateIds = new Set((prev?.updates || []).filter(u => u?.id).map(u => u.id));
      s.updates.forEach(u => {
        if (!u?.id || prevUpdateIds.has(u.id)) return;
        events.push({
          serviceId: s.id, serviceName: s.name, locationName,
          assigneeId: s.assigneeId, clientId: client.id, clientName: client.name,
          authorId: u.authorId, authorName: u.authorName, updateText: u.text,
        });
      });
    });
  };
  scan(curClient.services, incClient.services, null);
  const curLocs2 = curClient.locations || [], incLocs2 = incClient.locations || [];
  incLocs2.forEach(loc => {
    const curLoc = curLocs2.find(l => l.id === loc.id);
    scan(curLoc?.services, loc.services, loc.name);
  });
  return events;
}

// Manager/team notifications: "marked done" — a service's lastDone
// transitioning to a new value (completed this cycle), or a sub-item's done
// flag flipping from falsy to true. Same current-vs-incoming, same-request
// diff pattern as every collector above — never a load-time scan.
export function collectServiceDoneEvents(client, curClient, incClient) {
  const events = [];
  const scanServices = (curList, incList, locationName) => {
    const curById = new Map((curList || []).filter(s => s?.id).map(s => [s.id, s]));
    (incList || []).forEach(s => {
      if (!s?.id) return;
      const prev = curById.get(s.id);
      if (s.lastDone && s.lastDone !== prev?.lastDone) {
        events.push({
          serviceId: s.id, serviceName: s.name, locationName,
          assigneeId: s.assigneeId, clientId: client.id, clientName: client.name,
        });
      }
      if (Array.isArray(s.subitems)) {
        const prevSubById = new Map((prev?.subitems || []).filter(si => si?.id).map(si => [si.id, si]));
        s.subitems.forEach(si => {
          if (!si?.id || !si.done || prevSubById.get(si.id)?.done) return;
          events.push({
            serviceId: s.id, serviceName: s.name, locationName, subitemId: si.id, subitemText: si.text,
            assigneeId: si.assigneeId || s.assigneeId, clientId: client.id, clientName: client.name,
          });
        });
      }
    });
  };
  scanServices(curClient.services, incClient.services, null);
  const curLocs3 = curClient.locations || [], incLocs3 = incClient.locations || [];
  incLocs3.forEach(loc => {
    const curLoc = curLocs3.find(l => l.id === loc.id);
    scanServices(curLoc?.services, loc.services, loc.name);
  });
  return events;
}

// "Submit for review" on Done (My Work redesign follow-on) — reviewSubmittedAt
// is a flag/timestamp layered ON TOP of workStatus:'done', never a 5th
// SERVICE_STATUSES value (see submitServiceForReview() in each frontend —
// Done stays the status; this is a separate recorded event). Same current-
// vs-incoming, same-request diff pattern as collectServiceDoneEvents: fires
// once per service whose reviewSubmittedAt newly became truthy in THIS
// write, so a resave of an already-submitted service (or any other edit to
// it) produces zero events.
export function collectSubmittedForReviewEvents(client, curClient, incClient) {
  const events = [];
  const scanServices = (curList, incList, locationName) => {
    const curById = new Map((curList || []).filter(s => s?.id).map(s => [s.id, s]));
    (incList || []).forEach(s => {
      if (!s?.id) return;
      const prev = curById.get(s.id);
      if (s.reviewSubmittedAt && s.reviewSubmittedAt !== prev?.reviewSubmittedAt) {
        events.push({
          serviceId: s.id, serviceName: s.name, locationName,
          assigneeId: s.assigneeId, clientId: client.id, clientName: client.name,
          submittedBy: s.reviewSubmittedBy, submittedByName: s.reviewSubmittedByName,
        });
      }
    });
  };
  scanServices(curClient.services, incClient.services, null);
  const curLocs4 = curClient.locations || [], incLocs4 = incClient.locations || [];
  incLocs4.forEach(loc => {
    const curLoc = curLocs4.find(l => l.id === loc.id);
    scanServices(curLoc?.services, loc.services, loc.name);
  });
  return events;
}

let _directoryCache; // per-request cache — users/admins are fetched at most once per request
async function getDirectory(supabase) {
  if (_directoryCache) return _directoryCache;
  const [{ data: usersData }, { data: adminsData }, { data: teamPrefRows }] = await Promise.all([
    supabase.from('ops_users').select('id, data'),
    supabase.from('ops_admins').select('id, data'),
    supabase.from('ops_settings').select('key, data').like('key', 'teamNotifPrefs_%'),
  ]);
  const prefsByAdminId = new Map((teamPrefRows || []).map(r => [r.key.slice('teamNotifPrefs_'.length), r.data]));
  _directoryCache = {
    users: (usersData || []).map(r => ({ id: r.id, ...r.data })),
    admins: (adminsData || []).map(r => ({
      id: r.id, ...r.data,
      teamNotifPrefs: { ...DEFAULT_TEAM_NOTIF_PREFS, ...(prefsByAdminId.get(r.id) || {}) },
    })),
  };
  return _directoryCache;
}

export function personOf(id, kind, { users, admins }) {
  return kind === 'admin' ? admins.find(a => a.id === id) : users.find(u => u.id === id);
}

async function fireAssignmentNotifications(supabase, events, warnings) {
  if (!events.length) return;
  const { users, admins } = await getDirectory(supabase);
  const rows = [];
  events.forEach(ev => {
    resolveNotifyRecipients(ev.assigneeId, users, admins, 'assigned').forEach(r => {
      const person = personOf(r.id, r.kind, { users, admins });
      const isTask = !!ev.taskId;
      const isSubitem = !!ev.subitemId;
      const title = isSubitem ? `New sub-item assigned: ${ev.subitemText}`
        : isTask ? `New task assigned: ${ev.taskName}` : `New service assigned: ${ev.serviceName}`;
      const body = isSubitem
        ? `${ev.serviceName} — ${ev.clientName}${ev.locationName ? ' — ' + ev.locationName : ''}`
        : isTask
        ? `${ev.clientName} — ${ev.projectName}${ev.subName ? ' / ' + ev.subName : ''}`
        : `${ev.clientName}${ev.locationName ? ' — ' + ev.locationName : ''}`;
      rows.push({
        type: 'assignment', recipientId: r.id, recipientKind: r.kind,
        recipientName: person?.name || '', recipientEmail: person?.email || '',
        title, body, link: '',
        context: { clientId: ev.clientId, serviceId: ev.serviceId || null, taskId: ev.taskId || null, subitemId: ev.subitemId || null },
      });
    });
  });
  await insertNotifications(supabase, rows, warnings);
}

// Task Assignments / Daily Tasks (ops_tasks — a standalone top-level table,
// NOT the client.projects[] "tasks" the functions above already use that
// name for, hence the distinct "opsTask" naming throughout this block).
// Deliberately named/shaped differently from fireAssignmentNotifications
// above rather than folded into it: an ops_task has no projectName/
// locationName, and reuses the SAME established mechanism
// (resolveNotifyRecipients + insertNotifications, which already sends the
// email itself via Resend — see insertNotifications' own comment) rather
// than the separate api/send-assignment-email.js tool, for consistency with
// every other assignment-type notification in this file.
async function fireOpsTaskAssignmentNotifications(supabase, events, warnings) {
  if (!events.length) return;
  const { users, admins } = await getDirectory(supabase);
  const rows = [];
  events.forEach(ev => {
    resolveNotifyRecipients(ev.assigneeId, users, admins, 'assigned').forEach(r => {
      const person = personOf(r.id, r.kind, { users, admins });
      rows.push({
        type: 'taskAssignment', recipientId: r.id, recipientKind: r.kind,
        recipientName: person?.name || '', recipientEmail: person?.email || '',
        title: `New task assigned: ${ev.subject}`,
        body: `${ev.clientName || 'No client'}${ev.dueDate ? ' — due ' + ev.dueDate : ''}`,
        link: '',
        context: { taskId: ev.taskId, clientId: ev.clientId || null },
      });
    });
  });
  await insertNotifications(supabase, rows, warnings);
}

// Monday feature pack #1: notifies a service's assignee when someone posts
// an update/comment on it. Reuses the same recipient-resolution and manager-
// escalation logic as fireAssignmentNotifications — the target ("the
// service's assignee") is exactly what resolveNotifyRecipients already
// resolves for that event type. Never notifies the author of their own
// comment, and never fires for a service with no assignee (nobody to tell).
async function fireServiceUpdateNotifications(supabase, events, warnings) {
  if (!events.length) return;
  const { users, admins } = await getDirectory(supabase);
  const rows = [];
  events.forEach(ev => {
    if (!ev.assigneeId) return;
    resolveNotifyRecipients(ev.assigneeId, users, admins, 'comment')
      .filter(r => r.id !== ev.authorId)
      .forEach(r => {
        const person = personOf(r.id, r.kind, { users, admins });
        rows.push({
          type: 'serviceUpdate', recipientId: r.id, recipientKind: r.kind,
          recipientName: person?.name || '', recipientEmail: person?.email || '',
          title: `New update on service: ${ev.serviceName}`,
          body: `${ev.authorName || 'Someone'}${ev.locationName ? ' (' + ev.locationName + ')' : ''} — ${ev.clientName}: ${String(ev.updateText || '').slice(0, 140)}`,
          link: '',
          context: { clientId: ev.clientId, serviceId: ev.serviceId },
        });
      });
  });
  await insertNotifications(supabase, rows, warnings);
}

// Manager/team notifications: fires when a service or sub-item is marked
// done. Manager-facing only — the person who marked it done already knows,
// so (unlike fireAssignmentNotifications) the assignee themselves is always
// filtered out here, same way fireServiceUpdateNotifications filters the
// comment's own author.
async function fireServiceDoneNotifications(supabase, events, warnings) {
  if (!events.length) return;
  const { users, admins } = await getDirectory(supabase);
  const rows = [];
  events.forEach(ev => {
    if (!ev.assigneeId) return;
    resolveNotifyRecipients(ev.assigneeId, users, admins, 'done')
      .filter(r => r.id !== ev.assigneeId)
      .forEach(r => {
        const person = personOf(r.id, r.kind, { users, admins });
        const title = ev.subitemId ? `Sub-item marked done: ${ev.subitemText}` : `Service marked done: ${ev.serviceName}`;
        const body = ev.subitemId
          ? `${ev.serviceName} — ${ev.clientName}${ev.locationName ? ' — ' + ev.locationName : ''}`
          : `${ev.clientName}${ev.locationName ? ' — ' + ev.locationName : ''}`;
        rows.push({
          type: 'serviceDone', recipientId: r.id, recipientKind: r.kind,
          recipientName: person?.name || '', recipientEmail: person?.email || '',
          title, body, link: '',
          context: { clientId: ev.clientId, serviceId: ev.serviceId, subitemId: ev.subitemId || null },
        });
      });
  });
  await insertNotifications(supabase, rows, warnings);
}

// "Submit for review" reviewer resolution — deliberately NOT
// resolveNotifyRecipients(): that function's no-manager-configured fallback
// notifies whichever ops_admins rows happen to have level 'super'/'owner',
// which is not necessarily Sarah — she is the PRIMARY_ADMIN_EMAIL sentinel
// (session id 'primary-admin', see api/ops-auth.js), with no row in
// ops_admins at all, so she'd never be reached by an admins-array scan.
// Instead: try the assignee's configured manager (users[].managerId) same
// as resolveNotifyRecipients does, and ALWAYS additionally include Sarah by
// her literal sentinel id — this is what makes "manager AND Super Admin"
// (manager resolves) collapse correctly into "Super Admin only" (it
// doesn't) without ever double-guessing who counts as "super". Returns
// managerResolved so the caller can report/log which path a given event
// took, per the task's explicit ask to "report that path".
export function resolveReviewRecipients(assigneeId, users, admins) {
  const out = [];
  let managerResolved = false;
  const user = users.find(u => u.id === assigneeId);
  // No `user` match at all covers "assignee is an admin" (admins have no
  // managerId concept here) exactly as much as "no managerId configured" —
  // both are simply "the manager lookup found nothing", same as the
  // resolveNotifyRecipients pattern above.
  if (user && user.managerId && user.managerId !== assigneeId) {
    const asAdmin = admins.find(a => a.id === user.managerId);
    const asUser = users.find(u => u.id === user.managerId);
    if (asAdmin) { out.push({ id: user.managerId, kind: 'admin' }); managerResolved = true; }
    else if (asUser) { out.push({ id: user.managerId, kind: 'user' }); managerResolved = true; }
  }
  out.push({ id: 'primary-admin', kind: 'admin' });
  const seen = new Set();
  return { recipients: out.filter(r => (seen.has(r.id) ? false : seen.add(r.id))), managerResolved };
}

// "Submit for review" on Done (My Work redesign follow-on) — notifies the
// resolved reviewer(s) (see resolveReviewRecipients above), never the
// submitter themselves.
async function fireSubmittedForReviewNotifications(supabase, events, warnings, notices) {
  if (!events.length) return;
  const { users, admins } = await getDirectory(supabase);
  const rows = [];
  events.forEach(ev => {
    if (!ev.assigneeId) return;
    const { recipients, managerResolved } = resolveReviewRecipients(ev.assigneeId, users, admins);
    // Correct, expected fallback — the review still goes out, just to Super
    // Admin instead of an unresolved manager. Not a failure of anything.
    if (!managerResolved) notices.push(`submittedForReview(${ev.serviceId}): no manager resolved for assignee ${ev.assigneeId} — Super Admin notified only`);
    recipients
      .filter(r => r.id !== ev.submittedBy)
      .forEach(r => {
        // The primary-admin sentinel (Sarah) has no ops_admins row, so
        // personOf() can't look her up — same literal id/email/name
        // api/ops-auth.js's login path already uses for her.
        const isPrimary = r.id === 'primary-admin';
        const person = isPrimary ? null : personOf(r.id, r.kind, { users, admins });
        rows.push({
          type: 'submittedForReview', recipientId: r.id, recipientKind: r.kind,
          recipientName: isPrimary ? 'Sarah Samy' : (person?.name || ''),
          recipientEmail: isPrimary ? 'ssamy@weblightmedia.com' : (person?.email || ''),
          title: `Submitted for review: ${ev.serviceName}`,
          body: `${ev.submittedByName || 'Someone'} submitted "${ev.serviceName}"${ev.locationName ? ' — ' + ev.locationName : ''} for ${ev.clientName} for review.`,
          link: '',
          context: { clientId: ev.clientId, serviceId: ev.serviceId },
        });
      });
  });
  await insertNotifications(supabase, rows, warnings);
}

async function fireTimeOffNotification(supabase, request, warnings, notices) {
  const { users, admins } = await getDirectory(supabase);
  const requester = users.find(u => String(u.name || '').toLowerCase() === String(request.userName || '').toLowerCase());
  const recipients = requester
    ? resolveNotifyRecipients(requester.id, users, admins)
    : [];
  // The time-off approve/deny write itself already succeeded — this is only
  // the notification side finding nobody to notify, same "expected, not a
  // failure" shape as the review fallback above.
  if (!recipients.length) { notices.push(`notifications: could not resolve user "${request.userName}" for time-off decision notification`); return; }
  const decision = request.status === 'approved' ? 'approved' : 'denied';
  const rows = recipients.map(r => {
    const person = personOf(r.id, r.kind, { users, admins });
    return {
      type: 'timeOff', recipientId: r.id, recipientKind: r.kind,
      recipientName: person?.name || '', recipientEmail: person?.email || '',
      title: `Time-off request ${decision}`,
      body: `${request.userName}'s request${request.startDate ? ` (${request.startDate}${request.endDate ? ' – ' + request.endDate : ''})` : ''} was ${decision}.`,
      link: '', context: { requestId: request.id },
    };
  });
  await insertNotifications(supabase, rows, warnings);
}

async function fireMessageNotification(supabase, message, warnings, notices) {
  const { users, admins } = await getDirectory(supabase);
  const toEmail = String(message.to || '').toLowerCase();
  const person = users.find(u => String(u.email || '').toLowerCase() === toEmail)
    || admins.find(a => String(a.email || '').toLowerCase() === toEmail);
  // The message write itself already succeeded — same "notification side
  // found nobody to notify" shape as the two fallbacks above.
  if (!person) { notices.push(`notifications: could not resolve recipient "${message.to}" for message notification`); return; }
  const kind = users.includes(person) ? 'user' : 'admin';
  await insertNotifications(supabase, [{
    type: 'message', recipientId: person.id, recipientKind: kind,
    recipientName: person.name || '', recipientEmail: person.email || '',
    title: `New message from ${message.fromName || message.from}`,
    body: String(message.content || '').slice(0, 200),
    link: '', context: { messageId: message.id },
  }], warnings);
}

export async function insertNotifications(supabase, rows, warnings) {
  if (!rows.length) return;
  const payload = rows.map(r => ({ id: genNotifId(), data: { ...r, read: false, createdAt: new Date().toISOString() } }));
  const { error } = await supabase.from('ops_notifications').insert(payload);
  if (error) { warnings.push(`notifications: ${error.message}`); return; }
  // Email is dormant until RESEND_API_KEY is configured — attempt fires only
  // then, and any failure is logged, never surfaced to the caller or allowed
  // to affect the (already-succeeded) write this notification came from.
  if (process.env.RESEND_API_KEY) {
    for (const row of payload) {
      try { await maybeEmailNotification(row.data); }
      catch (e) { console.warn('[notifications] email send failed (non-fatal):', e.message); }
    }
  }
}

async function maybeEmailNotification(notif) {
  const to = notif.recipientEmail;
  if (!to) return;
  const html = buildEmailHtml({ name: notif.recipientName || '', title: notif.title, body: notif.body, link: notif.link || '' });
  await sendResendEmail({ to, subject: notif.title, html });
}

async function upsertRows(supabase, table, rows, warnings, statusCol) {
  if (!rows.length) return 0;
  const payload = rows.map(r => {
    const row = { id: r.id, data: r };
    if (statusCol) row.status = r.status === 'inactive' ? 'inactive' : 'active';
    return row;
  });
  const { error } = await supabase.from(table).upsert(payload, { onConflict: 'id' });
  if (error) { warnings.push(`${table}: ${error.message}`); return 0; }
  return payload.length;
}

// feed is append-only at the DB level (trigger blocks UPDATE/DELETE) — only
// ever INSERT rows whose id doesn't already exist; ignore conflicts.
async function insertNewOnly(supabase, table, rows, warnings) {
  if (!rows.length) return 0;
  const payload = rows.map(r => ({ id: r.id, data: r }));
  const { error, count } = await supabase.from(table).upsert(payload, { onConflict: 'id', ignoreDuplicates: true, count: 'exact' });
  if (error) { warnings.push(`${table}: ${error.message}`); return 0; }
  return count ?? payload.length;
}

export default async function handler(req, res) {
  // Both caches below are documented as "per-request" but were never
  // actually reset anywhere — on a warm serverless instance (Vercel can and
  // does reuse one across multiple invocations) they'd silently keep
  // serving the FIRST request's notification settings/directory to every
  // later request on that same warm instance, e.g. an admin turning a
  // notification type off wouldn't take effect until a cold start happened
  // to occur. Found while adding the serviceUpdate type (Monday feature
  // pack #1) and testing it against a harness that — like a warm serverless
  // instance — reuses the same module across multiple simulated requests.
  _notifSettingsCache = undefined;
  _directoryCache = undefined;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let session;
  try { session = await requireSession(req); }
  catch (err) { await logError({ endpoint: 'ops-sync', error: err }); return res.status(500).json({ error: err.message }); }
  if (!session) return res.status(401).json({ error: 'Missing or invalid session' });
  const tier = tierOf(session); // 'super' | 'manager' | 'member'
  const isAdmin = tier !== 'member';

  let supabase;
  try { supabase = getSupabaseAdmin(); }
  catch (err) { await logError({ endpoint: 'ops-sync', error: err, session }); return res.status(500).json({ error: err.message }); }

  const { changes, tombstones, restoreUserIds } = req.body || {};
  const warnings = []; // genuine per-row write failures ONLY — logged as an error every time
  // Informational/expected fallbacks — a notification correctly went out via
  // a fallback path (e.g. Super Admin instead of an unresolved manager), or
  // correctly went nowhere because no valid recipient exists yet. The write
  // this notification was attached to still succeeded; nothing failed. Rides
  // in the response JSON same as warnings, but never triggers logError — see
  // the PR that added this split for why a normal, expected event (e.g. a
  // member with no managerId submitting for review) was being logged as an
  // ops_error_log write-warning identically to a real failure.
  const notices = [];
  const rejected = []; // clear, explicit rejections (member out-of-scope client edits) — always surfaced
  const applied = {};

  try {
    const c = changes || {};

    // ── self password change: allowed for EVERY role, but strictly scoped to
    // the caller's OWN row and ONLY the password/mustChangePassword fields —
    // this is the one carve-out into the otherwise restricted users/admins
    // tables, so anyone can change their own login without gaining any other
    // write access to that table. ──
    if (c.selfPasswordChange && typeof c.selfPasswordChange === 'object' && hasContent(c.selfPasswordChange.password)) {
      if (session.id === 'primary-admin') {
        // The primary admin has no ops_users/ops_admins row at all — her
        // password lives in ops_settings.primaryAdminPw (see
        // api/ops-auth.js). Her Business Setup "Change Admin Password"
        // screen used to verify her current password against a plaintext
        // copy mirrored into her own browser's localStorage, which breaks
        // once this value is a hash — so this is the one selfPasswordChange
        // case that ALSO verifies the current password server-side (same
        // hash-or-plaintext check login uses) before accepting a new one.
        const { data: pwRow } = await supabase.from('ops_settings').select('data').eq('key', 'primaryAdminPw').maybeSingle();
        const stored = pwRow && pwRow.data;
        const submittedCurrent = c.selfPasswordChange.currentPassword;
        const currentOk = hasContent(submittedCurrent) && hasContent(stored) &&
          (isHashed(stored) ? verifyPassword(submittedCurrent, stored) : stored === submittedCurrent);
        if (!currentOk) {
          warnings.push('selfPasswordChange: current password is incorrect');
        } else {
          const { error } = await supabase.from('ops_settings')
            .upsert({ key: 'primaryAdminPw', data: hashPassword(c.selfPasswordChange.password) }, { onConflict: 'key' });
          // A changed password invalidates every existing session for this
          // account, including the one making this very request — the next
          // request with this token re-logs in with the new credentials,
          // same as any other password-change kill-switch.
          if (!error) await supabase.from('ops_settings').upsert({ key: 'primaryAdminSessionsRevokedAt', data: new Date().toISOString() }, { onConflict: 'key' });
          if (error) warnings.push(`selfPasswordChange: ${error.message}`); else applied.selfPasswordChange = 1;
        }
      } else {
        // Table choice keys off whether this account HAS an employee profile
        // (session.employeeId), not off tier/isAdmin — a dual-role account's
        // canonical password lives on its ops_users row (session.id === that
        // row's id, see api/ops-auth.js), so isAdmin alone would look up the
        // wrong table/id for anyone who's both a worker and a manager.
        const table = session.employeeId ? 'ops_users' : 'ops_admins';
        const { data: cur } = await supabase.from(table).select('data').eq('id', session.id).maybeSingle();
        if (cur && cur.data) {
          const merged = { ...cur.data, password: hashPassword(c.selfPasswordChange.password), sessionsRevokedAt: new Date().toISOString() };
          if ('mustChangePassword' in c.selfPasswordChange) merged.mustChangePassword = !!c.selfPasswordChange.mustChangePassword;
          const { error } = await supabase.from(table).update({ data: merged }).eq('id', session.id);
          if (error) warnings.push(`selfPasswordChange: ${error.message}`); else applied.selfPasswordChange = 1;
        } else {
          warnings.push('selfPasswordChange: own record not found');
        }
        // A dual-role session's mustChangePassword is true if EITHER linked row
        // says so (see api/ops-auth.js — this is what lets "Grant manager role"
        // force a password change on first Manager-mode entry without ever
        // writing to ops_users). The write above only clears it on the table
        // that just changed (ops_users) — without also clearing it on the
        // linked ops_admins row, the OR would keep forcing this same screen on
        // every future login forever, not just the first one.
        if (session.employeeId && session.adminId && 'mustChangePassword' in c.selfPasswordChange && !c.selfPasswordChange.mustChangePassword) {
          const { data: curAdmin } = await supabase.from('ops_admins').select('data').eq('id', session.adminId).maybeSingle();
          if (curAdmin && curAdmin.data && curAdmin.data.mustChangePassword) {
            await supabase.from('ops_admins').update({ data: { ...curAdmin.data, mustChangePassword: false } }).eq('id', session.adminId);
          }
        }
      }
    }

    // ── onboarding tour/tips flags: allowed for EVERY role, strictly scoped
    // to the caller's own key — same-user-only enforcement is simply that
    // the key is always derived from session.id (verified token), never
    // taken from the request body. Stored in the existing ops_settings
    // table under a per-user key (not a new table, not a field on a
    // users/admins row) so it works uniformly even for the primary-admin
    // sentinel, which has no ops_users/ops_admins row to attach a field to.
    // Whole-blob replace is fine here — it's a tiny, single-owner value with
    // no concurrent-editor scenario, and the client only sends it on an
    // explicit dismiss/finish/skip/replay action, never on load (CLAUDE.md
    // rule #2 — no load-time mutation).
    if (c.tourFlags && typeof c.tourFlags === 'object') {
      const key = 'tourFlags_' + session.id;
      const { error } = await supabase.from('ops_settings').upsert({ key, data: c.tourFlags }, { onConflict: 'key' });
      if (error) warnings.push(`tourFlags: ${error.message}`); else applied.tourFlags = 1;
    }

    // ── team-activity notification prefs: same self-scoped-key carve-out as
    // tourFlags above, admin-only (only admins manage a team), keyed by the
    // caller's own ADMIN identity — session.adminId for a dual-role account,
    // falling back to session.id (which IS the admin id for a plain admin
    // session), or the literal 'primary-admin' sentinel for Sarah. This is
    // what resolveNotifyRecipients() reads (via getDirectory) to decide
    // whether THIS admin wants assigned/done/comment/overdue team events. ──
    if (isAdmin && c.teamNotifPrefs && typeof c.teamNotifPrefs === 'object') {
      const key = 'teamNotifPrefs_' + (session.adminId || session.id);
      const { error } = await supabase.from('ops_settings').upsert({ key, data: c.teamNotifPrefs }, { onConflict: 'key' });
      if (error) warnings.push(`teamNotifPrefs: ${error.message}`); else applied.teamNotifPrefs = 1;
    }

    // ── session kill-switch: Super Admin/CEO only. Two scopes:
    //   'account' — sign a specific user and/or admin out everywhere, by id.
    //   'all'     — emergency: sign every account out everywhere, including
    //               the caller's own current session. Rule #6 (destructive/
    //               high-blast-radius operations need a typed confirmation
    //               checked server-side, not just gated in the UI) applies
    //               to 'all' specifically — the client-side double-confirm
    //               is not trusted alone; the exact phrase is re-checked here. ──
    if (c.sessionRevocation && typeof c.sessionRevocation === 'object') {
      if (tier !== 'super') {
        warnings.push('sessionRevocation: dropped — Super Admin/CEO only');
      } else {
        const { scope, userId, adminId, confirmPhrase } = c.sessionRevocation;
        const now = new Date().toISOString();
        if (scope === 'account') {
          let n = 0;
          if (hasContent(userId)) {
            const { data: cur } = await supabase.from('ops_users').select('data').eq('id', userId).maybeSingle();
            if (cur?.data) {
              const { error } = await supabase.from('ops_users').update({ data: { ...cur.data, sessionsRevokedAt: now } }).eq('id', userId);
              if (error) warnings.push(`sessionRevocation: ${error.message}`); else n++;
            }
          }
          if (hasContent(adminId)) {
            const { data: cur } = await supabase.from('ops_admins').select('data').eq('id', adminId).maybeSingle();
            if (cur?.data) {
              const { error } = await supabase.from('ops_admins').update({ data: { ...cur.data, sessionsRevokedAt: now } }).eq('id', adminId);
              if (error) warnings.push(`sessionRevocation: ${error.message}`); else n++;
            }
          }
          if (!hasContent(userId) && !hasContent(adminId)) warnings.push('sessionRevocation: no userId/adminId specified');
          else applied.sessionRevocation = n;
        } else if (scope === 'all') {
          const REQUIRED_PHRASE = 'SIGN OUT ALL ACCOUNTS';
          if (confirmPhrase !== REQUIRED_PHRASE) {
            warnings.push(`sessionRevocation: confirmation phrase did not match — type exactly "${REQUIRED_PHRASE}"`);
          } else {
            const [{ data: allUsers }, { data: allAdmins }] = await Promise.all([
              supabase.from('ops_users').select('id, data'),
              supabase.from('ops_admins').select('id, data'),
            ]);
            let n = 0;
            for (const u of allUsers || []) {
              const { error } = await supabase.from('ops_users').update({ data: { ...u.data, sessionsRevokedAt: now } }).eq('id', u.id);
              if (!error) n++;
            }
            for (const a of allAdmins || []) {
              const { error } = await supabase.from('ops_admins').update({ data: { ...a.data, sessionsRevokedAt: now } }).eq('id', a.id);
              if (!error) n++;
            }
            const { error: settingsErr } = await supabase.from('ops_settings').upsert({ key: 'primaryAdminSessionsRevokedAt', data: now }, { onConflict: 'key' });
            if (!settingsErr) n++;
            applied.sessionRevocation = n;
          }
        } else {
          warnings.push('sessionRevocation: unknown scope — must be "account" or "all"');
        }
      }
    }

    // ── admin tables: silently drop (not error) a member's attempt at any of
    // these, so a stray field in a batched payload can't fail the whole sync.
    // (Unlike the member-client-write path below, a member simply has no
    // legitimate reason to ever send these, so there's no "reason" to surface.) ──
    for (const key of Object.keys(c)) {
      if (!isAdmin && ADMIN_TABLES.has(key) && Array.isArray(c[key]) && c[key].length) {
        warnings.push(`${key}: dropped — restricted table, caller role is member`);
      }
    }

    // Service Catalog: any admin tier may edit (unlike the rest of `settings`,
    // which stays Super Admin/CEO exclusive below) — members can only suggest
    // (see catalogSuggestions further down), never write the catalog directly.
    if (isAdmin && c.settings && typeof c.settings === 'object' && 'serviceCatalog' in c.settings) {
      const { error } = await supabase.from('ops_settings').upsert({ key: 'serviceCatalog', data: c.settings.serviceCatalog }, { onConflict: 'key' });
      if (error) warnings.push(`settings.serviceCatalog: ${error.message}`);
      else applied.serviceCatalog = 1;
    }

    if (isAdmin) {
      // users: 'admin' level and super/owner manage the team, but the three
      // specialized manager levels (creative/production/account manager) are
      // hard-blocked from ops_users entirely — see CLAUDE.md's permission
      // project Step 1. Payroll/pay-rate fields stay Super Admin/CEO
      // exclusive for whoever CAN write users — stripped (not rejected) so
      // an unrelated title/role edit isn't blocked by a stale field.
      const usersIncoming = (c.users || []).filter(validUserOrAdmin);
      if (usersIncoming.length) {
        if (tier === 'manager' && !canEditUsers(session)) {
          warnings.push(`users: dropped — restricted manager level (${session.level}) cannot edit user accounts`);
        } else {
          const ids = usersIncoming.map(r => r.id);
          const { data: currentRows } = await supabase.from('ops_users').select('id, data').in('id', ids);
          const byId = new Map((currentRows || []).map(r => [r.id, r.data]));
          const stamped = usersIncoming.map(u => stampSessionRevocationOnPasswordChange(u, byId.get(u.id)));
          const toWrite = (tier === 'manager'
            ? stamped.map(u => stripPayrollFields(u, byId.get(u.id)))
            : stamped.map(u => preserveMissingPayrollFields(u, byId.get(u.id)))
          ).map(u => preserveMissingPasswordField(u, byId.get(u.id)));
          applied.users = await upsertRows(supabase, 'ops_users', hashIncomingPasswords(toWrite), warnings);
        }
      }

      // admins/roadmap/org chart/business settings/payroll ledger: Super
      // Admin/CEO exclusive — dropped for manager tier, same as for members.
      if (tier === 'super') {
        const adminsIncoming = (c.admins || []).filter(validUserOrAdmin);
        let adminsToWrite = adminsIncoming;
        if (adminsIncoming.length) {
          // Same missing-password preservation as the users path above —
          // an ordinary admin edit (title, level, etc., no new password
          // typed) must never wipe the stored password/hash.
          const { data: currentAdminRows } = await supabase.from('ops_admins').select('id, data').in('id', adminsIncoming.map(r => r.id));
          const adminById = new Map((currentAdminRows || []).map(r => [r.id, r.data]));
          adminsToWrite = adminsIncoming
            .map(a => stampSessionRevocationOnPasswordChange(a, adminById.get(a.id)))
            .map(a => preserveMissingPasswordField(a, adminById.get(a.id)));
        }
        applied.admins = await upsertRows(supabase, 'ops_admins', hashIncomingPasswords(adminsToWrite), warnings);
        applied.roadmapTasks = await upsertRows(supabase, 'ops_roadmap_tasks', (c.roadmapTasks || []).filter(validGeneric), warnings);
        applied.orgNodes = await upsertRows(supabase, 'ops_org_nodes', (c.orgNodes || []).filter(validGeneric), warnings);
        applied.orgLinks = await upsertRows(supabase, 'ops_org_links', (c.orgLinks || []).filter(validGeneric), warnings);
        // Org chart delete: soft-delete via `deleted_at`, same tier gate as
        // the upserts above — never a hard SQL DELETE. A node delete only
        // ever touches the node row and the specific link rows the client
        // says are connected to it (removedLinks in deleteOrgBubble()) —
        // there is no cascade computed server-side.
        if (tombstones && Array.isArray(tombstones.orgNodes) && tombstones.orgNodes.length) {
          const { error } = await supabase.from('ops_org_nodes')
            .update({ deleted_at: new Date().toISOString() })
            .in('id', tombstones.orgNodes);
          if (error) warnings.push(`deletedOrgNodeIds: ${error.message}`);
          else applied.deletedOrgNodeIds = tombstones.orgNodes.length;
        }
        if (tombstones && Array.isArray(tombstones.orgLinks) && tombstones.orgLinks.length) {
          const { error } = await supabase.from('ops_org_links')
            .update({ deleted_at: new Date().toISOString() })
            .in('id', tombstones.orgLinks);
          if (error) warnings.push(`deletedOrgLinkIds: ${error.message}`);
          else applied.deletedOrgLinkIds = tombstones.orgLinks.length;
        }
        if (Array.isArray(c.timeOffLedger) && c.timeOffLedger.length) {
          applied.timeOffLedger = await insertNewOnly(supabase, 'ops_time_off_ledger', c.timeOffLedger.filter(validGeneric), warnings);
        }
        // Payroll saved-week records: append-only, INSERT only, same
        // insertNewOnly() pattern as the time-off ledger above — a payroll
        // save can never overwrite/replace a prior week's record, only add
        // a new one (see the PAYROLL — MASTER PLAN, 2026-08-19, and commit
        // f8075e23's app-level fix this table structurally enforces at the
        // DB level too via ops_payroll_guard).
        if (Array.isArray(c.payroll) && c.payroll.length) {
          applied.payroll = await insertNewOnly(supabase, 'ops_payroll', c.payroll.filter(validGeneric), warnings);
        }
        if (c.settings && typeof c.settings === 'object') {
          const otherKeys = Object.entries(c.settings).filter(([key]) => key !== 'serviceCatalog');
          for (const [key, value] of otherKeys) {
            const { error } = await supabase.from('ops_settings').upsert({ key, data: value }, { onConflict: 'key' });
            if (error) warnings.push(`settings.${key}: ${error.message}`);
          }
          if (otherKeys.length) applied.settings = otherKeys.length;
        }
      } else {
        for (const key of ['admins', 'roadmapTasks', 'orgNodes', 'orgLinks', 'timeOffLedger', 'payroll', 'settings']) {
          const hasOtherSettings = key === 'settings' && c.settings && Object.keys(c.settings).some(k => k !== 'serviceCatalog');
          if (key === 'settings' ? hasOtherSettings : Array.isArray(c[key]) && c[key].length) {
            warnings.push(`${key}: dropped — Super Admin/CEO only, caller is a manager-tier admin`);
          }
        }
      }

      // summaries/archive (tombstone+restore): team + client management —
      // both admin tiers.
      if (Array.isArray(c.summaries) && c.summaries.length) {
        let n = 0;
        for (const s of c.summaries) {
          if (!s || !s.clientId || !s.kind || !s.periodKey) { warnings.push('summaries: skipped row missing clientId/kind/periodKey'); continue; }
          const { data: existing } = await supabase.from('ops_summaries').select('data')
            .eq('client_id', s.clientId).eq('kind', s.kind).eq('period_key', s.periodKey).maybeSingle();
          const merged = {
            progress: 'progress' in s ? s.progress : existing?.data?.progress,
            notes: 'notes' in s ? s.notes : existing?.data?.notes,
          };
          const { error } = await supabase.from('ops_summaries')
            .upsert({ client_id: s.clientId, kind: s.kind, period_key: s.periodKey, data: merged }, { onConflict: 'client_id,kind,period_key' });
          if (error) warnings.push(`summaries(${s.clientId}/${s.kind}/${s.periodKey}): ${error.message}`);
          else n++;
        }
        applied.summaries = n;
      }
      if (tombstones && Array.isArray(tombstones.users) && tombstones.users.length) {
        const { error } = await supabase.from('ops_deleted_user_ids')
          .upsert(tombstones.users.map(id => ({ user_id: id })), { onConflict: 'user_id' });
        if (error) warnings.push(`deletedUserIds: ${error.message}`);
        else applied.deletedUserIds = tombstones.users.length;
      }
      if (Array.isArray(restoreUserIds) && restoreUserIds.length) {
        const { error } = await supabase.from('ops_deleted_user_ids').delete().in('user_id', restoreUserIds);
        if (error) warnings.push(`restoreUserIds: ${error.message}`);
        else applied.restoredUserIds = restoreUserIds.length;
      }
      // NOTE: admins are never hard-deleted, same as clients — active/inactive
      // only (fail-closed: there is no delete-admin code path at all here).
    }

    // ── clients: allowed for every role; members are restricted server-side
    // to their assigned items. A member's out-of-scope edit REJECTS THE WHOLE
    // CLIENT RECORD with a clear reason (see `rejected` in the response) —
    // never a silent partial merge. ──
    if (Array.isArray(c.clients) && c.clients.length) {
      const incoming = c.clients.filter(validClient);
      const ids = incoming.map(r => r.id);
      // Fetched for BOTH tiers now: the member-write check always needed it,
      // and firing an assignment notification needs the same "current vs
      // incoming, same request" comparison regardless of who's writing.
      const { data: currentRows, error: curErr } = await supabase.from('ops_clients').select('id, status, data').in('id', ids);
      if (curErr) warnings.push(`clients: ${curErr.message}`);
      const byId = new Map((currentRows || []).map(r => [r.id, r]));
      const notifSettings = await getNotificationSettings(supabase);
      const assignmentEvents = [];
      const serviceUpdateEvents = [];
      const doneEvents = [];
      const reviewEvents = [];

      if (isAdmin) {
        applied.clients = await upsertRows(supabase, 'ops_clients', incoming, warnings, true);
        if (notifSettings.assignment) {
          for (const inc of incoming) {
            const cur = byId.get(inc.id);
            if (!cur) continue; // brand-new client (e.g. a bulk import) — nothing to diff against
            assignmentEvents.push(...collectServiceAssignmentEvents(inc, cur.data, inc));
            assignmentEvents.push(...collectTaskAssignmentEvents(inc, cur.data, inc));
            assignmentEvents.push(...collectSubitemAssignmentEvents(inc, cur.data, inc));
          }
        }
        if (notifSettings.serviceUpdate) {
          for (const inc of incoming) {
            const cur = byId.get(inc.id);
            if (!cur) continue;
            serviceUpdateEvents.push(...collectServiceUpdateEvents(inc, cur.data, inc));
          }
        }
        if (notifSettings.done) {
          for (const inc of incoming) {
            const cur = byId.get(inc.id);
            if (!cur) continue;
            doneEvents.push(...collectServiceDoneEvents(inc, cur.data, inc));
          }
        }
        if (notifSettings.submittedForReview) {
          for (const inc of incoming) {
            const cur = byId.get(inc.id);
            if (!cur) continue;
            reviewEvents.push(...collectSubmittedForReviewEvents(inc, cur.data, inc));
          }
        }
      } else {
        let n = 0;
        for (const inc of incoming) {
          const cur = byId.get(inc.id);
          if (!cur) {
            rejected.push({ table: 'clients', id: inc.id, reason: 'members cannot create new clients' });
            continue;
          }
          const check = checkMemberClientWrite(cur.data, inc, session.id, session.name);
          if (!check.allowed) {
            rejected.push({ table: 'clients', id: inc.id, reason: check.reason });
            continue;
          }
          // status is never part of the check above (members can't touch it),
          // but guard it here too — belt and suspenders against active/inactive drift.
          const { error: uErr } = await supabase.from('ops_clients').update({ data: { ...inc, status: cur.status } }).eq('id', inc.id);
          if (uErr) { warnings.push(`clients(${inc.id}): ${uErr.message}`); continue; }
          n++;
          if (notifSettings.assignment) {
            assignmentEvents.push(...collectServiceAssignmentEvents(inc, cur.data, inc));
            assignmentEvents.push(...collectTaskAssignmentEvents(inc, cur.data, inc));
            assignmentEvents.push(...collectSubitemAssignmentEvents(inc, cur.data, inc));
          }
          if (notifSettings.serviceUpdate) {
            serviceUpdateEvents.push(...collectServiceUpdateEvents(inc, cur.data, inc));
          }
          if (notifSettings.done) {
            doneEvents.push(...collectServiceDoneEvents(inc, cur.data, inc));
          }
          if (notifSettings.submittedForReview) {
            reviewEvents.push(...collectSubmittedForReviewEvents(inc, cur.data, inc));
          }
        }
        applied.clients = n;
      }

      await fireAssignmentNotifications(supabase, assignmentEvents, warnings);
      await fireServiceUpdateNotifications(supabase, serviceUpdateEvents, warnings);
      await fireServiceDoneNotifications(supabase, doneEvents, warnings);
      await fireSubmittedForReviewNotifications(supabase, reviewEvents, warnings, notices);
    }

    // ── Task Assignments (admin) / Daily Tasks (employee) — ops_tasks.
    // Admins have full CRUD on any task, including reassigning it to a
    // different employee. A member may create a brand-new task assigned to
    // themselves OR to a direct report — anyone whose configured manager
    // (users[].managerId, the same field index.html's assignment-escalation
    // notifications already read) is this caller. assigneeId/assignedById
    // are forced server-side regardless of what the client sent: assignedById
    // is always the caller, and assigneeId is the incoming value ONLY if
    // it's the caller or one of their own reports, silently falling back to
    // the caller otherwise (so "Add / import tasks" — including the
    // email-parser's owner-matching in api/process-transcript.js — can never
    // assign to someone outside that caller's own scope, individual
    // contributors included, since an individual's report set is empty and
    // this collapses back to exactly the old self-only behavior for them).
    // Updating an EXISTING task is unchanged: only if it's already assigned
    // to them, and even then only a small set of fields (status/notes/tags)
    // — everything else (assignee, client, category, type, priority, due
    // date, origin, source) is admin-only, the same
    // allow-list-of-untouchable-fields pattern checkMemberClientWrite
    // already uses for clients. A task's assignee actually changing
    // (including a brand-new task created WITH an assignee, since
    // assigneeChanged's prevId is '' for a task that didn't exist before)
    // fires an in-app + email notification via
    // fireOpsTaskAssignmentNotifications, unless the task is self-assigned
    // (assigning yourself something needs no notification). ──
    if (Array.isArray(c.tasks) && c.tasks.length) {
      const incoming = c.tasks.filter(validGeneric);
      const ids = incoming.map(t => t.id);
      const { data: currentTaskRows } = await supabase.from('ops_tasks').select('id, data').in('id', ids);
      const byId = new Map((currentTaskRows || []).map(r => [r.id, r.data]));
      const notifSettings = await getNotificationSettings(supabase);
      const taskAssignmentEvents = [];
      // Computed once per request, fresh from the live directory — never
      // trusted from the client. null for an admin caller (unrestricted).
      let creatableAssigneeIds = null;
      if (!isAdmin) {
        const { users: directoryUsers } = await getDirectory(supabase);
        const reportIds = directoryUsers.filter(u => u.managerId === session.id).map(u => u.id);
        creatableAssigneeIds = new Set([session.id, ...reportIds]);
      }
      let n = 0;
      for (const inc of incoming) {
        const cur = byId.get(inc.id);
        let row;
        if (!cur) {
          if (isAdmin) {
            row = { ...inc, assignedById: inc.assignedById || session.id };
          } else {
            const assigneeId = creatableAssigneeIds.has(inc.assigneeId) ? inc.assigneeId : session.id;
            row = { ...inc, assigneeId, assignedById: session.id, origin: 'self' };
          }
          const { error } = await supabase.from('ops_tasks').insert({ id: inc.id, data: row });
          if (error) { warnings.push(`tasks(${inc.id}): ${error.message}`); continue; }
        } else if (isAdmin) {
          // assignedById never gets blanked by a falsy incoming value — a
          // client that hasn't pulled back the server-assigned value yet
          // (e.g. a second quick edit within the same 30s poll window)
          // would otherwise silently overwrite it with null on every save.
          row = { ...inc, assignedById: inc.assignedById || cur.assignedById || null };
          const { error } = await supabase.from('ops_tasks').update({ data: row }).eq('id', inc.id);
          if (error) { warnings.push(`tasks(${inc.id}): ${error.message}`); continue; }
        } else {
          if (cur.assigneeId !== session.id) {
            rejected.push({ table: 'tasks', id: inc.id, reason: 'not your task' });
            continue;
          }
          const disallowedKey = TASK_KEYS_MEMBER_MAY_NOT_TOUCH.find(
            key => JSON.stringify(cur[key]) !== JSON.stringify(inc[key])
          );
          if (disallowedKey) {
            rejected.push({ table: 'tasks', id: inc.id, reason: `members cannot edit tasks.${disallowedKey}` });
            continue;
          }
          row = inc;
          const { error } = await supabase.from('ops_tasks').update({ data: row }).eq('id', inc.id);
          if (error) { warnings.push(`tasks(${inc.id}): ${error.message}`); continue; }
        }
        n++;
        if (notifSettings.assignment && row.assigneeId && row.assigneeId !== session.id && assigneeChanged(cur, row)) {
          taskAssignmentEvents.push({
            taskId: inc.id, subject: row.subject, assigneeId: row.assigneeId,
            clientId: row.clientId || null, clientName: row.clientName || '', dueDate: row.dueDate || '',
          });
        }
      }
      applied.tasks = n;
      await fireOpsTaskAssignmentNotifications(supabase, taskAssignmentEvents, warnings);
    }

    applied.goals = await upsertRows(supabase, 'ops_goals', (c.goals || []).filter(validGeneric), warnings);
    if (Array.isArray(c.messages) && c.messages.length) {
      const incomingMsgs = c.messages.filter(validGeneric);
      // Same "current vs incoming, same request" comparison as clients above —
      // a message id not already in ops_messages is a brand-new message, and
      // firing happens right here, not from any later scan.
      const { data: existingMsgRows } = await supabase.from('ops_messages').select('id').in('id', incomingMsgs.map(m => m.id));
      const existingIds = new Set((existingMsgRows || []).map(r => r.id));
      applied.messages = await upsertRows(supabase, 'ops_messages', incomingMsgs, warnings);
      const notifSettings = await getNotificationSettings(supabase);
      if (notifSettings.message) {
        for (const m of incomingMsgs) {
          if (!existingIds.has(m.id)) await fireMessageNotification(supabase, m, warnings, notices);
        }
      }
    }
    if (Array.isArray(c.feed) && c.feed.length) {
      applied.feed = await insertNewOnly(supabase, 'ops_feed', c.feed.filter(validGeneric), warnings);
    }

    // ── time off requests: team management for both admin tiers (approve/
    // deny included). Members may only create/edit their OWN pending
    // request, matched by userName — the field the app actually writes (see
    // user.html submitTimeOffRequest()); userId never exists on this record. ──
    if (Array.isArray(c.timeOffRequests) && c.timeOffRequests.length) {
      const incoming = c.timeOffRequests.filter(validGeneric);
      const ids = incoming.map(r => r.id);
      const { data: currentRows } = await supabase.from('ops_time_off_requests').select('id, data').in('id', ids);
      const byId = new Map((currentRows || []).map(r => [r.id, r.data]));
      const myNameLower = String(session.name || '').toLowerCase();
      const notifSettings = await getNotificationSettings(supabase);
      let n = 0;
      for (const inc of incoming) {
        const cur = byId.get(inc.id);
        if (isAdmin) {
          const { error } = await supabase.from('ops_time_off_requests').upsert({ id: inc.id, data: inc }, { onConflict: 'id' });
          if (error) { warnings.push(`timeOffRequests(${inc.id}): ${error.message}`); continue; }
          n++;
          // Fires exactly once, at the moment status actually transitions to a
          // decision — never on the initial pending-request creation, and
          // never re-fired if an admin re-saves the same already-decided status.
          const isNewDecision = cur && cur.status !== inc.status && (inc.status === 'approved' || inc.status === 'denied');
          if (isNewDecision && notifSettings.timeOff) await fireTimeOffNotification(supabase, inc, warnings, notices);
          continue;
        }
        if (!cur) {
          if (String(inc.userName || '').toLowerCase() !== myNameLower) {
            rejected.push({ table: 'timeOffRequests', id: inc.id, reason: 'members can only create their own request' });
            continue;
          }
          const row = { ...inc, status: 'pending', approvedBy: null, reviewedAt: null };
          const { error } = await supabase.from('ops_time_off_requests').insert({ id: inc.id, data: row });
          if (error) warnings.push(`timeOffRequests(${inc.id}): ${error.message}`); else n++;
        } else {
          if (String(cur.userName || '').toLowerCase() !== myNameLower) {
            rejected.push({ table: 'timeOffRequests', id: inc.id, reason: "not this member's request" });
            continue;
          }
          const row = { ...inc, status: cur.status, approvedBy: cur.approvedBy, reviewedAt: cur.reviewedAt }; // status locked to admin
          const { error } = await supabase.from('ops_time_off_requests').update({ data: row }).eq('id', inc.id);
          if (error) warnings.push(`timeOffRequests(${inc.id}): ${error.message}`); else n++;
        }
      }
      applied.timeOffRequests = n;
    }

    // ── catalog suggestions: any role (including members) may propose a new
    // service or an edit to an existing one — identity/status are always
    // server-forced, never trusted from the body. Only admins may act on an
    // EXISTING suggestion (approve/reject/edit); a member touching one that
    // already exists is rejected outright, same "no silent partial merge"
    // rule as checkMemberClientWrite(). Approving a suggestion does not, by
    // itself, change the live catalog — the admin's browser sends the updated
    // serviceCatalog (via settings, above) in the same request that marks the
    // suggestion approved. ──
    if (Array.isArray(c.catalogSuggestions) && c.catalogSuggestions.length) {
      const incoming = c.catalogSuggestions.filter(validGeneric);
      const ids = incoming.map(r => r.id);
      const { data: currentRows } = await supabase.from('ops_catalog_suggestions').select('id, data').in('id', ids);
      const byId = new Map((currentRows || []).map(r => [r.id, r.data]));
      let n = 0;
      for (const inc of incoming) {
        const cur = byId.get(inc.id);
        if (!cur) {
          const row = {
            ...inc,
            status: 'pending',
            submittedBy: session.id,
            submittedByName: session.name,
            reviewedBy: null, reviewedByName: null, reviewedAt: null,
          };
          const { error } = await supabase.from('ops_catalog_suggestions').insert({ id: inc.id, data: row });
          if (error) warnings.push(`catalogSuggestions(${inc.id}): ${error.message}`); else n++;
          continue;
        }
        if (!isAdmin) {
          rejected.push({ table: 'catalogSuggestions', id: inc.id, reason: 'members cannot edit an existing suggestion — only submit new ones' });
          continue;
        }
        const row = { ...inc, reviewedBy: session.id, reviewedByName: session.name, reviewedAt: new Date().toISOString() };
        const { error } = await supabase.from('ops_catalog_suggestions').update({ data: row }).eq('id', inc.id);
        if (error) warnings.push(`catalogSuggestions(${inc.id}): ${error.message}`); else n++;
      }
      applied.catalogSuggestions = n;
    }

    // ── sales funnel: gated on the caller's resolved Sales Funnel LEVEL
    // (viewer/editor/owner — see funnelLevelOf() above), NOT on admin/member
    // tier — a member like a sales/account manager can be granted this same
    // as an admin. Viewer is read-only: Editor+ may write prospect changes
    // (this includes "Archive," which is nothing more than a normal write
    // with archived:true — there is no separate delete/archive endpoint,
    // and no code path here ever removes a row). Anyone Editor+ has full
    // control over every entry (per Sarah — everyone shares one pipeline,
    // no per-row ownership restriction), but identity is always
    // server-forced: createdBy/createdByName/createdAt are stamped once on
    // insert and never overwritten again; updatedBy/updatedByName/
    // updatedAt refresh on every write. ──
    const funnelDir = await getDirectory(supabase);
    const funnelCallerOwnRow = session.role === 'admin'
      ? funnelDir.admins.find(a => a.id === session.id)
      : funnelDir.users.find(u => u.id === session.id);
    const callerFunnelLevel = tier === 'super' ? 'owner' : funnelLevelOf(funnelCallerOwnRow);

    if (Array.isArray(c.salesFunnel) && c.salesFunnel.length) {
      if (callerFunnelLevel !== 'editor' && callerFunnelLevel !== 'owner') {
        warnings.push(callerFunnelLevel === 'viewer'
          ? 'salesFunnel: dropped — viewer-level access is read-only'
          : 'salesFunnel: dropped — caller does not have Sales Funnel access');
      } else {
        const incoming = c.salesFunnel.filter(validGeneric);
        const ids = incoming.map(r => r.id);
        const { data: currentRows } = await supabase.from('ops_sales_funnel').select('id, data').in('id', ids);
        const byId = new Map((currentRows || []).map(r => [r.id, r.data]));
        const now = new Date().toISOString();
        let n = 0;
        for (const inc of incoming) {
          const cur = byId.get(inc.id);
          if (!cur) {
            const row = {
              ...inc,
              archived: false,
              createdBy: session.id, createdByName: session.name, createdAt: now,
              updatedBy: session.id, updatedByName: session.name, updatedAt: now,
            };
            const { error } = await supabase.from('ops_sales_funnel').insert({ id: inc.id, data: row });
            if (error) warnings.push(`salesFunnel(${inc.id}): ${error.message}`); else n++;
            continue;
          }
          const row = {
            ...cur, ...inc,
            createdBy: cur.createdBy, createdByName: cur.createdByName, createdAt: cur.createdAt,
            updatedBy: session.id, updatedByName: session.name, updatedAt: now,
          };
          const { error } = await supabase.from('ops_sales_funnel').update({ data: row }).eq('id', inc.id);
          if (error) warnings.push(`salesFunnel(${inc.id}): ${error.message}`); else n++;
        }
        applied.salesFunnel = n;
      }
    }

    // ── sales funnel grants: only Owner+ (tier 'super', or an explicit
    // funnelLevel of 'owner' — Sarah AND any Owner-level person, per spec)
    // may change someone ELSE's Sales Funnel level. Deliberately a separate
    // top-level key, not routed through changes.users/changes.admins —
    // those two tables are hard-gated to tier==='super' only (see the
    // ADMIN_TABLES/tier==='super' checks above), which would block a
    // non-super Owner-level grantee outright. This path touches ONLY the
    // salesFunnelLevel key on the target's row — nothing else about that
    // person's record can be changed through it. Refuses a target whose own
    // stored level is already super/owner (funnelLevelOf() would resolve
    // them to 'owner' regardless of what's written anyway) — the concrete
    // enforcement behind "an Owner can never remove or downgrade Sarah,"
    // extended to every other Super Admin/Owner-level account the same way
    // (Sarah herself is the PRIMARY_ADMIN_EMAIL sentinel, not a real
    // ops_admins row, so she never appears in the grantable list at all). ──
    if (Array.isArray(c.salesFunnelGrants) && c.salesFunnelGrants.length) {
      if (callerFunnelLevel !== 'owner') {
        warnings.push('salesFunnelGrants: dropped — only a Sales Funnel Owner (or Super Admin) can change access levels');
      } else {
        const VALID_FUNNEL_LEVELS = new Set(['viewer', 'editor', 'owner']);
        let n = 0;
        for (const grant of (c.salesFunnelGrants || [])) {
          if (!grant || !hasContent(grant.id) || (grant.kind !== 'user' && grant.kind !== 'admin')) continue;
          if (grant.level !== null && !VALID_FUNNEL_LEVELS.has(grant.level)) {
            warnings.push(`salesFunnelGrants(${grant.id}): invalid level`);
            continue;
          }
          const table = grant.kind === 'admin' ? 'ops_admins' : 'ops_users';
          const { data: currentRows } = await supabase.from(table).select('id, data').eq('id', grant.id);
          const cur = currentRows?.[0]?.data;
          if (!cur) { warnings.push(`salesFunnelGrants(${grant.id}): not found`); continue; }
          if (grant.kind === 'admin' && FUNNEL_SUPER_LEVELS.has(cur.level)) {
            warnings.push(`salesFunnelGrants(${grant.id}): dropped — cannot change access for a Super Admin/Owner-level account`);
            continue;
          }
          const { error } = await supabase.from(table).update({ data: { ...cur, salesFunnelLevel: grant.level } }).eq('id', grant.id);
          if (error) warnings.push(`salesFunnelGrants(${grant.id}): ${error.message}`);
          else n++;
        }
        applied.salesFunnelGrants = n;
      }
    }

    // ── notifications: every role may mark their OWN notifications read —
    // the only field this path ever changes. Never a whole-list overwrite:
    // each row is fetched and updated by its own id, and any row that isn't
    // addressed to the caller is rejected outright rather than silently
    // applied or dropped. ──
    if (Array.isArray(c.notifications) && c.notifications.length) {
      const incoming = c.notifications.filter(validGeneric);
      const { data: currentRows } = await supabase.from('ops_notifications').select('id, data').in('id', incoming.map(r => r.id));
      const byId = new Map((currentRows || []).map(r => [r.id, r.data]));
      let n = 0;
      for (const inc of incoming) {
        const cur = byId.get(inc.id);
        if (!cur) { rejected.push({ table: 'notifications', id: inc.id, reason: 'not found' }); continue; }
        if (cur.recipientId !== session.id) { rejected.push({ table: 'notifications', id: inc.id, reason: 'not addressed to this caller' }); continue; }
        const { error } = await supabase.from('ops_notifications').update({ data: { ...cur, read: !!inc.read } }).eq('id', inc.id);
        if (error) warnings.push(`notifications(${inc.id}): ${error.message}`); else n++;
      }
      applied.notifications = n;
    }

    // Every failed cloud write already lives in `warnings` (per-row, never
    // thrown) — record them here too, once per request, so they surface to
    // an admin instead of only ever showing up in a response nobody reads.
    // notices[] deliberately never reaches logError — those are expected,
    // already-successful fallback outcomes (see where notices is declared
    // above), not failures. A normal event (e.g. a member with no
    // managerId submitting for review) must not look identical to a real
    // per-row write failure in the error log.
    if (warnings.length) {
      await logError({ endpoint: 'ops-sync', error: `${warnings.length} write warning(s)`, session, extra: { warnings, notices, rejected } });
    }
    return res.status(200).json({ ok: true, applied, warnings, notices, rejected });
  } catch (err) {
    await logError({ endpoint: 'ops-sync', error: err, session, extra: { warnings, notices, rejected } });
    return res.status(500).json({ error: err.message || 'Sync failed', warnings, notices, rejected });
  }
}
