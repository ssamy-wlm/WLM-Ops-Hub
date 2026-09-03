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
// notifications?, salesFunnel?, salesFunnelGrants?, tasks? },
// tombstones?: { users?: [ids], orgNodes?: [ids], orgLinks?: [ids], taskIds?: [ids] },
// restoreUserIds?: [ids] }
//
// orgNodes/orgLinks tombstones set `deleted_at` on the targeted row(s) in
// place (ops_org_nodes/ops_org_links) rather than a separate exclusion
// table — those tables already carry/gain a `deleted_at` column for this
// exact purpose (see the migration adding it to ops_org_links). ops-state.js
// filters both on `deleted_at is null`. Never a hard SQL DELETE.
//
// tombstones.taskIds is the one exception to that: ops_tasks has no
// deleted_at column at all, so "undo this import" (Task Assignments/Daily
// Tasks) really does issue a hard SQL DELETE against ops_tasks — see the
// dedicated block below for the permission scoping (admin: any id;
// member: only a task where they themselves are assignedById).
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

import crypto from 'crypto';
import { getSupabaseAdmin } from '../lib/supabaseAdmin.js';
import { requireSession, tierOf, canEditUsers } from '../lib/opsSession.js';
import { sendResendEmail, buildEmailHtml } from '../lib/resendClient.js';
import { logError } from '../lib/errorLog.js';
import { isHashed, hashPassword, verifyPassword } from '../lib/passwordHash.js';
import { clampToWeekday } from '../lib/dateUtils.js';

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

// Same class of incident as preserveMissingPayrollFields/
// preserveMissingPasswordField above, for clients (2026-08-21): a browser
// whose local cache predates an out-of-band field being set on this row
// (e.g. the clientEmails[] salvage import, a hosting/platform note set
// directly in the DB) genuinely lacks that key on the object it re-saves.
// upsertRows()/a raw .update() does a full JSONB replace of `data`, not a
// merge, so without this the field would be silently deleted by ANY
// unrelated edit to that client. Unlike the payroll helper, this uses key
// PRESENCE (a plain object spread), not hasContent() — a client-edit form
// that deliberately clears a field to '' (e.g. website) always wins; only a
// key entirely ABSENT from the incoming payload falls back to the stored
// value. Also protects service-level fields (e.g. a service's `platforms`/
// `sitePlatform`/`hostingProvider`) on any service — top-level or inside a
// franchise location — present in BOTH the current and incoming arrays,
// matched by id. A service/location present in `current` but missing
// entirely from `incoming` is never resurrected here — that's still a
// legitimate add/remove, unchanged; this only ever fills in missing FIELDS
// on an item both sides already agree exists.
function _mergeClientItemsById(currentArr, incomingArr) {
  if (!Array.isArray(incomingArr)) return currentArr;
  const curById = new Map((Array.isArray(currentArr) ? currentArr : []).filter(x => x && x.id != null).map(x => [x.id, x]));
  return incomingArr.map(item => {
    const cur = item && item.id != null ? curById.get(item.id) : null;
    return cur ? { ...cur, ...item } : item;
  });
}
function preserveMissingClientFields(incoming, current) {
  if (!current) return incoming;
  const merged = { ...current, ...incoming };
  merged.services = _mergeClientItemsById(current.services, incoming.services);
  if (Array.isArray(incoming.locations)) {
    const curLocsById = new Map((current.locations || []).filter(l => l && l.id != null).map(l => [l.id, l]));
    merged.locations = incoming.locations.map(loc => {
      const curLoc = loc && loc.id != null ? curLocsById.get(loc.id) : null;
      if (!curLoc) return loc;
      return { ...curLoc, ...loc, services: _mergeClientItemsById(curLoc.services, loc.services) };
    });
  }
  return merged;
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

// Plain server-side Date usage (this is a serverless request handler, not
// a Workflow script) — used to default a task's assignedDate when a client
// doesn't send one, so it's never blank in storage.
function todayIsoUtc() { return new Date().toISOString().slice(0, 10); }

const CLIENT_SCALAR_KEYS_MEMBER_MAY_NOT_TOUCH = [
  'name', 'status', 'pinned', 'color', 'code', 'industry', 'accountManager',
  'clientName', 'clientEmail', 'clientPhone', 'referredBy', 'notes',
  'internalNotes', 'website', 'logo', 'brandColors', 'brandDetails', 'startDate',
  // Task-assignment email-matching data (Task Assignments feature) — loaded
  // via a one-time admin salvage import, never a member-facing edit.
  'clientEmails',
  // Client-level Platform/Registrar/Hosting Provider (2026-08-27) — same
  // admin-only edit modal as website/industry above; added here for the
  // same defense-in-depth reason, even though the client never sends these
  // in a member payload today (the edit modal itself is admin-only in the
  // UI). The SERVICE-level sitePlatform/registrar/hostingProvider fields
  // are deliberately NOT restricted here — those already inherit ordinary
  // per-service member write access (an assigned member can edit any field
  // on their own service, same as sitePlatform/hostingProvider already
  // could before this change), unchanged.
  'sitePlatform', 'registrar', 'hostingProvider',
];

// A member editing an EXISTING task assigned to them (Daily Tasks) may only
// touch status/notes/tags — everything else (who it's for, what it's
// about, where it lives) is admin-only, same allow-list-of-untouchable-
// fields pattern as CLIENT_SCALAR_KEYS_MEMBER_MAY_NOT_TOUCH above.
// 'type' deliberately excluded (Security & Cleanup batch, "drop the Type
// field") — a task carrying a legacy stored `type` value from before that
// change would otherwise permanently fail this comparison the instant a
// client stops sending the field at all (JSON.stringify(cur.type) !==
// JSON.stringify(undefined)), rejecting an otherwise-legitimate status/
// notes/tags update forever. Never re-add it without handling that.
// 'blockReason' is likewise deliberately excluded (2026-08-20, "Blocked"
// status) — a member marking their OWN task Blocked needs to write both
// `status` (already allowed) and `blockReason` together in the same
// request; treating blockReason like status/notes/tags here is what makes
// that possible without any other server change.
// 'subject' removed 2026-08-26 (employee task-text-editing feature) — the
// task title/name is now editable by the assigned employee, same as
// notes/tags already were. Still scoped by the ownership check right above
// this list (cur.assigneeId !== session.id -> "not your task") — a member
// can only ever edit the subject of a task already assigned to them, never
// anyone else's.
// clientId/clientName removed (2026-09-01, My Tasks batch item 5) — the
// parser sometimes misses or wrong-guesses the client, and the assignee
// often knows it better than anyone; a member may now correct it on a
// task already assigned to them, same scope as subject/notes/status. The
// existing "not your task" ownership check just above this list's use
// site is still the actual gate — this only widens which FIELDS are
// touchable on a task already theirs, never whose tasks they can touch.
const TASK_KEYS_MEMBER_MAY_NOT_TOUCH = [
  'assigneeId', 'assignedById',
  'category', 'priority', 'dueDate', 'dueDateLocked', 'source', 'origin',
  'emailReceivedDate', 'emailThreadId', 'assignedDate',
];

// Returns { allowed: true } or { allowed: false, reason } — never a partial merge.
export function checkMemberClientWrite(current, incoming, memberId, memberName) {
  for (const key of CLIENT_SCALAR_KEYS_MEMBER_MAY_NOT_TOUCH) {
    // A key entirely ABSENT from `incoming` (not just falsy) means this
    // caller's local cache predates that field ever being set — the same
    // staleness preserveMissingClientFields() protects against at write
    // time, below. Treat it as "not touched," not "cleared" — omitting a
    // key can never sneak a value change through, since the write-time
    // merge always falls back to the CURRENT stored value for anything
    // missing here; at most this lets a stale-cache save through, never a
    // stale-cache save that silently changes a restricted field. A key
    // present with an actually different value is still rejected exactly
    // as before.
    if (!(key in incoming)) continue;
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

// Assignment emails go to the ASSIGNEE ONLY (2026-09-03) — no manager/
// leader escalation on a routine assignment (that used to come from
// resolveNotifyRecipients()'s own manager-fallback/broadcaster logic,
// removed here entirely rather than gated off, since this event type never
// wants it regardless of any admin's teamNotifPrefs.assigned toggle;
// resolveNotifyRecipients() itself is untouched and still used exactly as
// before for every OTHER event type — overdue/done/comment/etc.). No
// notification at all for a genuine self-assign: `ev.assignedById` is
// attached at every push site below (never trusted from the collector
// functions, which have no such field on a service/legacy-task/sub-item —
// see each push site's own comment), compared by the same literal
// field-equality definition of "self-assigned" already established
// elsewhere in this codebase (the 2026-09-02 self-assigned-badge feature:
// assignedById===assigneeId, not a session-id proxy).
async function fireAssignmentNotifications(supabase, events, warnings) {
  if (!events.length) return;
  const { users, admins } = await getDirectory(supabase);
  const rows = [];
  events.forEach(ev => {
    if (!ev.assigneeId) return;
    if (ev.assignedById && ev.assignedById === ev.assigneeId) return;
    const kind = users.find(u => u.id === ev.assigneeId) ? 'user' : 'admin';
    const person = personOf(ev.assigneeId, kind, { users, admins });
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
      type: 'assignment', recipientId: ev.assigneeId, recipientKind: kind,
      recipientName: person?.name || '', recipientEmail: person?.email || '',
      title, body, link: '',
      context: { clientId: ev.clientId, serviceId: ev.serviceId || null, taskId: ev.taskId || null, subitemId: ev.subitemId || null },
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
//
// Assignee only, no manager escalation, no self-assign email (2026-09-03) —
// same rule and same reasoning as fireAssignmentNotifications() above.
async function fireOpsTaskAssignmentNotifications(supabase, events, warnings) {
  if (!events.length) return;
  const { users, admins } = await getDirectory(supabase);
  const rows = [];
  events.forEach(ev => {
    if (!ev.assigneeId) return;
    if (ev.assignedById && ev.assignedById === ev.assigneeId) return;
    const kind = users.find(u => u.id === ev.assigneeId) ? 'user' : 'admin';
    const person = personOf(ev.assigneeId, kind, { users, admins });
    rows.push({
      type: 'taskAssignment', recipientId: ev.assigneeId, recipientKind: kind,
      recipientName: person?.name || '', recipientEmail: person?.email || '',
      title: `New task assigned: ${ev.subject}`,
      body: `${ev.clientName || 'No client'}${ev.dueDate ? ' — due ' + ev.dueDate : ''}`,
      link: '',
      context: { taskId: ev.taskId, clientId: ev.clientId || null },
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

// "Report task" (My Tasks batch, item 3, 2026-09-01) — an employee flagging
// an admin-assigned task they think isn't theirs. Recipients are a fixed
// rule, not the usual manager-escalation resolveNotifyRecipients() logic:
// always every super/owner-tier admin (today that's just David — plus the
// primary-admin sentinel by her literal id, same reason
// resolveReviewRecipients() above pushes her explicitly: Sarah has no
// ops_admins row for an admins-array scan to ever find), PLUS the admin who
// actually assigned the task, only when that assigner is NOT already
// super/owner (e.g. Abby, production_manager) — an already-included
// super/owner assigner is just deduped below, never double-notified.
export function resolveReportRecipients(assignedById, admins) {
  const out = [{ id: 'primary-admin', kind: 'admin' }];
  admins.filter(a => a.level === 'super' || a.level === 'owner').forEach(a => out.push({ id: a.id, kind: 'admin' }));
  if (assignedById && assignedById !== 'primary-admin') {
    const assigner = admins.find(a => a.id === assignedById);
    if (assigner && assigner.level !== 'super' && assigner.level !== 'owner') out.push({ id: assignedById, kind: 'admin' });
  }
  const seen = new Set();
  return out.filter(r => (seen.has(r.id) ? false : seen.add(r.id)));
}

async function fireTaskReportedNotifications(supabase, events, warnings) {
  if (!events.length) return;
  const { users, admins } = await getDirectory(supabase);
  const rows = [];
  events.forEach(ev => {
    resolveReportRecipients(ev.assignedById, admins).forEach(r => {
      // Same primary-admin-sentinel special-case resolveReviewRecipients'
      // own caller already needs — see the comment there.
      const isPrimary = r.id === 'primary-admin';
      const person = isPrimary ? null : personOf(r.id, r.kind, { users, admins });
      rows.push({
        type: 'taskReported', recipientId: r.id, recipientKind: r.kind,
        recipientName: isPrimary ? 'Sarah Samy' : (person?.name || ''),
        recipientEmail: isPrimary ? 'ssamy@weblightmedia.com' : (person?.email || ''),
        title: `Task reported: ${ev.subject}`,
        body: `${ev.reportedByName || 'Someone'} flagged "${ev.subject}" as possibly not theirs.`,
        link: '',
        context: { taskId: ev.taskId, clientId: ev.clientId || null },
      });
    });
  });
  await insertNotifications(supabase, rows, warnings);
}

// Due-date-change request approver resolution (2026-09-03) — deliberately
// NOT resolveReviewRecipients(): that function ALWAYS additionally includes
// Sarah's primary-admin sentinel even when a real manager resolves, which
// is right for "submit for review" (a manager AND Sarah both plausibly want
// to know) but wrong here — this feature's own spec is a strict either/or
// ("the requester's direct manager... if no manager, route to the super
// admin"), never both at once. Same manager-lookup shape as
// resolveNotifyRecipients()/resolveReviewRecipients() (users[].managerId,
// resolved against either table), falling back to JUST the primary-admin
// sentinel by her literal id when no manager is configured — the same
// special case those two functions already need, since she has no real
// ops_admins row for an admins-array scan to ever find.
export function resolveDueDateApprover(requesterId, users, admins) {
  const user = users.find(u => u.id === requesterId);
  if (user && user.managerId && user.managerId !== requesterId) {
    const asAdmin = admins.find(a => a.id === user.managerId);
    if (asAdmin) return [{ id: user.managerId, kind: 'admin' }];
    const asUser = users.find(u => u.id === user.managerId);
    if (asUser) return [{ id: user.managerId, kind: 'user' }];
  }
  return [{ id: 'primary-admin', kind: 'admin' }];
}

// Fired when a member's request is written (see the member-write branch
// below) — notifies the resolved approver only, never the requester
// themselves (resolveDueDateApprover() never returns the requester's own
// id, since it only ever returns a manager or the fallback super-admin).
async function fireDueDateChangeRequestedNotification(supabase, events, warnings) {
  if (!events.length) return;
  const { users, admins } = await getDirectory(supabase);
  const rows = [];
  events.forEach(ev => {
    resolveDueDateApprover(ev.requestedBy, users, admins).forEach(r => {
      const isPrimary = r.id === 'primary-admin';
      const person = isPrimary ? null : personOf(r.id, r.kind, { users, admins });
      rows.push({
        type: 'dueDateChangeRequested', recipientId: r.id, recipientKind: r.kind,
        recipientName: isPrimary ? 'Sarah Samy' : (person?.name || ''),
        recipientEmail: isPrimary ? 'ssamy@weblightmedia.com' : (person?.email || ''),
        title: `Due-date change requested: ${ev.subject}`,
        body: `${ev.requestedByName || 'Someone'} requested moving the due date to ${ev.proposedDate}${ev.reason ? ` — "${ev.reason}"` : ''}.`,
        link: '',
        context: { taskId: ev.taskId, clientId: ev.clientId || null },
      });
    });
  });
  await insertNotifications(supabase, rows, warnings);
}

// Fired when an admin resolves a pending request (approve or decline — see
// the isAdmin update branch below, which detects which one happened by
// comparing the incoming dueDate to the request's own proposedDate).
// Notifies the ORIGINAL REQUESTER only — never the approver, who obviously
// already knows what they just did.
async function fireDueDateChangeResolvedNotification(supabase, events, warnings) {
  if (!events.length) return;
  const { users, admins } = await getDirectory(supabase);
  const rows = [];
  events.forEach(ev => {
    const kind = users.find(u => u.id === ev.requestedBy) ? 'user' : 'admin';
    const person = personOf(ev.requestedBy, kind, { users, admins });
    if (!person) return;
    rows.push({
      type: ev.approved ? 'dueDateChangeApproved' : 'dueDateChangeDeclined',
      recipientId: ev.requestedBy, recipientKind: kind,
      recipientName: person.name || '', recipientEmail: person.email || '',
      title: ev.approved ? `Due-date change approved: ${ev.subject}` : `Due-date change declined: ${ev.subject}`,
      body: ev.approved ? `Your requested due date (${ev.proposedDate}) was approved.` : `Your requested due date (${ev.proposedDate}) was declined — the due date is unchanged.`,
      link: '',
      context: { taskId: ev.taskId, clientId: ev.clientId || null },
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
  //
  // Batched by recipient email (2026-09-02) — insertNotifications is called
  // once per write request with every notification row THAT request
  // produced (e.g. committing a 15-task import for one person fires 15
  // separate 'taskAssignment' rows, all for the same recipient). The old
  // loop below sent one email per row — 15 emails for one commit. Grouped
  // here into at most one email per distinct recipientEmail per request,
  // never touching the in-app rows already inserted above (those stay one
  // row per item, exactly as before, so the notification bell still shows
  // each individually). A recipient with no email is skipped, same as
  // before. Respecting notification-settings toggles needs no extra check
  // here — every caller of insertNotifications already gates on the
  // relevant notifSettings.* flag before ever building these rows.
  if (process.env.RESEND_API_KEY) {
    const byEmail = new Map();
    for (const row of payload) {
      const to = row.data.recipientEmail;
      if (!to) continue;
      if (!byEmail.has(to)) byEmail.set(to, []);
      byEmail.get(to).push(row.data);
    }
    for (const [to, notifs] of byEmail) {
      try { await maybeEmailNotification(to, notifs); }
      catch (e) {
        console.warn('[notifications] email send failed (non-fatal):', e.message);
        // Recorded, not just console.warn'd (2026-09-02) — a failed Resend
        // send used to be invisible anywhere in the app; this surfaces it
        // in Business Setup's error viewer the same way every other
        // endpoint failure already is. logError() itself never throws
        // (see lib/errorLog.js), so this stays exactly as non-fatal as the
        // console.warn it sits next to — never blocks or fails the sync.
        await logError({ endpoint: 'notifications:email', error: e, extra: { recipient: to, itemCount: notifs.length } });
      }
    }
  } else {
    // Surfaced (2026-09-02), not just silently dormant — a missing key in
    // the runtime env used to mean every notification's email half quietly
    // never fired, with nothing anywhere to show for it. logError() itself
    // never throws (see lib/errorLog.js), so this stays exactly as
    // non-fatal as the try/catch branch above it.
    await logError({ endpoint: 'notifications:email', error: 'SKIPPED — RESEND_API_KEY missing in runtime env' });
  }
}

async function maybeEmailNotification(to, notifs) {
  if (!to || !notifs.length) return;
  if (notifs.length === 1) {
    const notif = notifs[0];
    const html = buildEmailHtml({ name: notif.recipientName || '', title: notif.title, body: notif.body, link: notif.link || '' });
    await sendResendEmail({ to, subject: notif.title, html });
    return;
  }
  // Combined email for 2+ notifications landing for the same recipient in
  // this one request — one line per item, each item's own title (and body,
  // if it has one) so nothing is lost versus the old one-email-per-item
  // shape, just coalesced into a single send. buildEmailHtml's body div
  // has white-space:pre-wrap (see lib/resendClient.js) specifically so
  // this newline-joined list actually renders as separate lines, not one
  // run-on line.
  const name = notifs[0].recipientName || '';
  const subject = `You have ${notifs.length} new updates`;
  const body = notifs.map(n => `• ${n.title}${n.body ? ' — ' + n.body : ''}`).join('\n');
  const html = buildEmailHtml({ name, title: subject, body, link: '' });
  await sendResendEmail({ to, subject, html });
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

  // ── One-time password-hash cutover (Security & Cleanup #11) — Super
  // Admin/Owner only, same CLAUDE.md rule #6 dry-run + typed-confirmation +
  // fresh-reviewToken pattern as api/ops-backups.js's restore action. Every
  // write path in this file already hashes a password the moment it's set
  // (hashIncomingPasswords below, selfPasswordChange above), and every login
  // lazily upgrades its own row (api/ops-auth.js) — this action exists only
  // to reach the remainder: an account that hasn't logged in or changed its
  // password since scrypt hashing shipped (2026-07-25), whose stored value
  // is still legacy plaintext. Dispatched via a top-level `action` field,
  // same convention as ops-backups.js, never via `changes` — this isn't a
  // per-record sync write, it's a guarded administrative action.
  if (req.body?.action === 'password-cutover-dry-run' || req.body?.action === 'password-cutover-confirm') {
    if (tier !== 'super') return res.status(403).json({ error: 'Super Admin/Owner only' });
    const CUTOVER_PHRASE = 'HASH ALL LEGACY PASSWORDS';

    // Reads live rows fresh — never a cached/passed-in list — so the
    // resulting reviewToken is always bound to what's actually in the
    // database at the moment it's computed, matching computeReviewToken's
    // "recompute fresh, refuse if it doesn't match" pattern in opsBackup.js.
    async function cutoverSnapshot() {
      const [{ data: userRows, error: uErr }, { data: adminRows, error: aErr }, { data: pwRow, error: pErr }] = await Promise.all([
        supabase.from('ops_users').select('id, data'),
        supabase.from('ops_admins').select('id, data'),
        supabase.from('ops_settings').select('data').eq('key', 'primaryAdminPw').maybeSingle(),
      ]);
      const firstErr = uErr || aErr || pErr;
      if (firstErr) throw new Error(firstErr.message);
      const legacyUsers = (userRows || []).filter(r => hasContent(r.data?.password) && !isHashed(r.data.password));
      const legacyAdmins = (adminRows || []).filter(r => hasContent(r.data?.password) && !isHashed(r.data.password));
      const primaryAdminLegacy = hasContent(pwRow?.data) && !isHashed(pwRow.data);
      const idList = [
        ...legacyUsers.map(r => `users:${r.id}`),
        ...legacyAdmins.map(r => `admins:${r.id}`),
        ...(primaryAdminLegacy ? ['primaryAdminPw'] : []),
      ].sort();
      return { legacyUsers, legacyAdmins, primaryAdminLegacy, idList };
    }
    function cutoverToken(idList) {
      const secret = process.env.SESSION_SECRET;
      if (!secret) throw new Error('SESSION_SECRET is not configured on the server.');
      return crypto.createHmac('sha256', secret).update(JSON.stringify(idList)).digest('base64url');
    }

    if (req.body.action === 'password-cutover-dry-run') {
      try {
        const snap = await cutoverSnapshot();
        return res.status(200).json({
          ok: true,
          reviewToken: cutoverToken(snap.idList),
          count: snap.idList.length,
          // Names only, for the confirmation screen — never a password or
          // hash value, hashed or not, leaves this endpoint in this action.
          accounts: [
            ...snap.legacyUsers.map(r => ({ table: 'users', id: r.id, name: r.data?.name || r.data?.email || r.id })),
            ...snap.legacyAdmins.map(r => ({ table: 'admins', id: r.id, name: r.data?.name || r.data?.email || r.id })),
            ...(snap.primaryAdminLegacy ? [{ table: 'settings', id: 'primaryAdminPw', name: 'Primary Admin' }] : []),
          ],
        });
      } catch (err) {
        await logError({ endpoint: 'ops-sync', error: err, session });
        return res.status(500).json({ error: err.message });
      }
    }

    // action === 'password-cutover-confirm'
    const { reviewToken, confirmPhrase } = req.body;
    if (!reviewToken || !confirmPhrase) return res.status(400).json({ error: '"reviewToken" and "confirmPhrase" are both required' });
    if (confirmPhrase !== CUTOVER_PHRASE) return res.status(400).json({ error: `Confirmation phrase must be exactly: ${CUTOVER_PHRASE}` });
    try {
      const snap = await cutoverSnapshot();
      // Re-derived from data read JUST NOW, then compared to the token the
      // browser is echoing back from its earlier dry run — if anything
      // changed in between (a new legacy account, someone logging in and
      // self-upgrading), the tokens won't match and this is refused rather
      // than acting on a stale review, exactly like ops-backups.js restore.
      if (cutoverToken(snap.idList) !== reviewToken) {
        return res.status(409).json({ error: 'Live data has changed since your dry run — please run the dry run again before confirming.' });
      }
      const cutoverWarnings = [];
      let usersHashed = 0, adminsHashed = 0, primaryAdminHashed = false;
      for (const r of snap.legacyUsers) {
        // Re-checked here, not just trusted from the snapshot above — an
        // account can self-upgrade via a normal login at any moment, and
        // hashing an already-hashed value would double-hash it and
        // permanently lock that person out. Same guard as every other
        // password-write path in this file (hashIncomingPasswords, etc).
        if (isHashed(r.data.password)) continue;
        const { error } = await supabase.from('ops_users').update({ data: { ...r.data, password: hashPassword(r.data.password) } }).eq('id', r.id);
        if (error) cutoverWarnings.push(`password-cutover: users/${r.id}: ${error.message}`); else usersHashed++;
      }
      for (const r of snap.legacyAdmins) {
        if (isHashed(r.data.password)) continue;
        const { error } = await supabase.from('ops_admins').update({ data: { ...r.data, password: hashPassword(r.data.password) } }).eq('id', r.id);
        if (error) cutoverWarnings.push(`password-cutover: admins/${r.id}: ${error.message}`); else adminsHashed++;
      }
      if (snap.primaryAdminLegacy) {
        const { data: freshPwRow } = await supabase.from('ops_settings').select('data').eq('key', 'primaryAdminPw').maybeSingle();
        if (freshPwRow && hasContent(freshPwRow.data) && !isHashed(freshPwRow.data)) {
          const { error } = await supabase.from('ops_settings').upsert({ key: 'primaryAdminPw', data: hashPassword(freshPwRow.data) }, { onConflict: 'key' });
          if (error) cutoverWarnings.push(`password-cutover: primaryAdminPw: ${error.message}`); else primaryAdminHashed = true;
        }
      }
      return res.status(200).json({ ok: true, usersHashed, adminsHashed, primaryAdminHashed, warnings: cutoverWarnings });
    } catch (err) {
      await logError({ endpoint: 'ops-sync', error: err, session });
      return res.status(500).json({ error: err.message });
    }
  }

  // ── "Email everyone their work summary" (2026-09-03) — Super Admin/Owner
  // only, same top-level `action` dispatch convention as the password-
  // cutover block above (a guarded administrative action, never a per-
  // record sync write). Reuses insertNotifications() — the same
  // established "build one row per recipient, it resolves the email and
  // sends via Resend, batched one email per distinct recipientEmail"
  // mechanism every other notification type in this file already uses —
  // rather than writing a second, parallel email-sending path.
  if (req.body?.action === 'email-team-summaries') {
    if (tier !== 'super') return res.status(403).json({ error: 'Super Admin/Owner only' });

    // Server-enforced cooldown (~3h) — the client's confirm() dialog is a
    // UX nicety, not a guarantee; this is the real guard against a
    // spam-clicked repeat blast, checked and stamped here regardless of
    // what the client does. Stored in ops_settings (the same key-value
    // table notificationSettings/teamNotifPrefs_* already live in), not a
    // new table.
    const COOLDOWN_MS = 3 * 60 * 60 * 1000;
    const warnings = [];
    try {
      const { data: lastRow } = await supabase.from('ops_settings').select('data').eq('key', 'lastTeamSummaryEmailAt').maybeSingle();
      const lastAt = lastRow?.data ? new Date(lastRow.data).getTime() : 0;
      const elapsed = Date.now() - lastAt;
      if (lastAt && elapsed < COOLDOWN_MS) {
        const waitMin = Math.ceil((COOLDOWN_MS - elapsed) / 60000);
        return res.status(429).json({ error: `Team summaries were already sent recently — please wait ${waitMin} more minute(s) before sending again.` });
      }

      const today = new Date().toISOString().slice(0, 10);
      const weekOutDate = new Date(); weekOutDate.setDate(weekOutDate.getDate() + 7);
      const weekOut = weekOutDate.toISOString().slice(0, 10);
      // Same semantics as api/cron-overdue-check.js's own isInactiveService/
      // isDoneThisCycle/isOverdue/taskIsOverdue — duplicated here rather than
      // imported (that file is a handler, not a shared library, and
      // importing back into this one would be a circular dependency; this
      // file already already imports FROM it nowhere and is imported BY it),
      // same "kept in sync deliberately" convention this codebase already
      // uses between client.html and that same cron file.
      const isInactiveService = (s) => s.status === 'cancelled' || s.status === 'archived';
      const isDoneThisCycle = (s) => !!(s.lastDone && !(s.due && s.due < today));
      const isOverdueService = (s) => !isInactiveService(s) && !isDoneThisCycle(s) && !!s.due && s.due < today;
      const isDueSoonService = (s) => !isInactiveService(s) && !isDoneThisCycle(s) && !!s.due && s.due >= today && s.due <= weekOut;
      const isOverdueTask = (t) => !!t.dueDate && t.dueDate < today && t.status !== 'Done';
      const isDueSoonTask = (t) => !!t.dueDate && t.dueDate >= today && t.dueDate <= weekOut && t.status !== 'Done';
      const svcAssignedTo = (s, personId) => (Array.isArray(s.assigneeIds) && s.assigneeIds.length ? s.assigneeIds.includes(personId) : s.assigneeId === personId);

      const [{ data: userRows, error: uErr }, { data: adminRows, error: aErr }, { data: taskRows, error: tErr }, { data: clientRows, error: cErr }] = await Promise.all([
        supabase.from('ops_users').select('id, data'),
        supabase.from('ops_admins').select('id, data'),
        supabase.from('ops_tasks').select('id, data'),
        supabase.from('ops_clients').select('id, status, data').eq('status', 'active'),
      ]);
      const firstErr = uErr || aErr || tErr || cErr;
      if (firstErr) return res.status(500).json({ error: firstErr.message });

      const tasks = (taskRows || []).map(r => ({ id: r.id, ...r.data })).filter(t => !t.mergedIntoId);
      const services = [];
      (clientRows || []).forEach(row => {
        const client = row.data; if (!client) return;
        (client.services || []).forEach(s => { if (s?.id) services.push(s); });
        (client.locations || []).forEach(loc => (loc.services || []).forEach(s => { if (s?.id) services.push(s); }));
      });

      // Every active employee + admin, PLUS the primary-admin sentinel by
      // her literal id (same special case resolveReportRecipients()/
      // resolveReviewRecipients() already establish elsewhere in this file
      // — she has no real ops_admins row, but can genuinely have work
      // assigned to her like anyone else).
      const people = [
        { id: 'primary-admin', kind: 'admin', name: 'Sarah Samy', email: 'ssamy@weblightmedia.com' },
        ...(userRows || []).filter(r => r.data?.status !== 'inactive').map(r => ({ id: r.id, kind: 'user', name: r.data?.name || '', email: r.data?.email || '' })),
        ...(adminRows || []).filter(r => r.data?.status !== 'inactive').map(r => ({ id: r.id, kind: 'admin', name: r.data?.name || '', email: r.data?.email || '' })),
      ];

      const rows = [];
      let skippedCount = 0;
      for (const person of people) {
        const tasksForPerson = tasks.filter(t => t.assigneeId === person.id);
        const tasksAssigned = tasksForPerson.length;
        const tasksDone = tasksForPerson.filter(t => t.status === 'Done').length;
        const tasksNotStarted = tasksForPerson.filter(t => t.status === 'Not started').length;
        const tasksInProgress = tasksForPerson.filter(t => t.status === 'In progress').length;
        const servicesForPerson = services.filter(s => svcAssignedTo(s, person.id));
        const servicesAssigned = servicesForPerson.length;
        const servicesDone = servicesForPerson.filter(s => s.workStatus === 'done').length;
        const totalAssigned = tasksAssigned + servicesAssigned;
        // "Genuinely empty plate" -> skip entirely, no email, no row.
        if (!totalAssigned) { skippedCount++; continue; }
        if (!person.email) { skippedCount++; continue; }

        const pctDone = Math.round((tasksDone + servicesDone) / totalAssigned * 100);
        const overdueItems = [
          ...tasksForPerson.filter(isOverdueTask).map(t => t.subject || 'Untitled task'),
          ...servicesForPerson.filter(isOverdueService).map(s => s.name || 'Untitled service'),
        ];
        const dueSoonItems = [
          ...tasksForPerson.filter(isDueSoonTask).map(t => `${t.subject || 'Untitled task'} — due ${t.dueDate}`),
          ...servicesForPerson.filter(isDueSoonService).map(s => `${s.name || 'Untitled service'} — due ${s.due}`),
        ];
        const DUE_SOON_LIMIT = 5;
        const dueSoonLines = dueSoonItems.slice(0, DUE_SOON_LIMIT).map(x => `• ${x}`);
        if (dueSoonItems.length > DUE_SOON_LIMIT) dueSoonLines.push(`…and ${dueSoonItems.length - DUE_SOON_LIMIT} more`);

        const bodyLines = [
          `Tasks: ${tasksAssigned} assigned · ${tasksDone} done · ${tasksNotStarted} not started · ${tasksInProgress} in progress (${pctDone}% done)`,
          `Services: ${servicesAssigned} assigned · ${servicesDone} done`,
          '',
          `Overdue: ${overdueItems.length}`,
        ];
        if (dueSoonLines.length) {
          bodyLines.push('', 'Due this week:', ...dueSoonLines);
        }

        rows.push({
          type: 'workSummary', recipientId: person.id, recipientKind: person.kind,
          recipientName: person.name, recipientEmail: person.email,
          title: "Here's your work summary",
          body: bodyLines.join('\n'),
          link: '', context: {},
        });
      }

      await insertNotifications(supabase, rows, warnings);
      const { error: stampErr } = await supabase.from('ops_settings').upsert({ key: 'lastTeamSummaryEmailAt', data: new Date().toISOString() }, { onConflict: 'key' });
      if (stampErr) warnings.push(`lastTeamSummaryEmailAt: ${stampErr.message}`);

      return res.status(200).json({ ok: true, sentCount: rows.length, skippedCount, warnings });
    } catch (err) {
      await logError({ endpoint: 'ops-sync', error: err, session });
      return res.status(500).json({ error: err.message });
    }
  }

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
    // never a silent partial merge (that check runs against the raw incoming
    // payload). What actually reaches storage, however, IS a merge —
    // preserveMissingClientFields() below fills in any field present on the
    // current DB row but genuinely absent from this write (a stale local
    // cache), so a resave from a device that predates an out-of-band field
    // (clientEmails, sitePlatform/hostingProvider, service platforms, etc.)
    // can never silently wipe it — see CLAUDE.md's 2026-08-21 field-
    // preservation entry for the incident this closes. ──
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
        // preserveMissingClientFields runs only on what actually reaches
        // storage — every notification-diff loop below still compares the
        // RAW `incoming` against `cur.data`, unaffected by the merge.
        const toStore = incoming.map(inc => preserveMissingClientFields(inc, byId.get(inc.id)?.data));
        applied.clients = await upsertRows(supabase, 'ops_clients', toStore, warnings, true);
        if (notifSettings.assignment) {
          for (const inc of incoming) {
            const cur = byId.get(inc.id);
            if (!cur) continue; // brand-new client (e.g. a bulk import) — nothing to diff against
            // assignedById attached here, not by the collector functions
            // themselves (services/legacy tasks/sub-items have no such
            // stored field at all) — the caller making THIS assignment
            // write, right now, is the only meaningful "who assigned it"
            // for the self-assign check fireAssignmentNotifications() does
            // (2026-09-03: assignment emails go to the assignee only, never
            // when they assigned it to themselves).
            assignmentEvents.push(...collectServiceAssignmentEvents(inc, cur.data, inc).map(ev => ({ ...ev, assignedById: session.id })));
            assignmentEvents.push(...collectTaskAssignmentEvents(inc, cur.data, inc).map(ev => ({ ...ev, assignedById: session.id })));
            assignmentEvents.push(...collectSubitemAssignmentEvents(inc, cur.data, inc).map(ev => ({ ...ev, assignedById: session.id })));
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
          // checkMemberClientWrite() above ran against the RAW `inc` — the merge
          // only ever fills in fields already absent from `inc`, which never
          // changes what that check saw.
          const toStore = preserveMissingClientFields(inc, cur.data);
          const { error: uErr } = await supabase.from('ops_clients').update({ data: { ...toStore, status: cur.status } }).eq('id', inc.id);
          if (uErr) { warnings.push(`clients(${inc.id}): ${uErr.message}`); continue; }
          n++;
          if (notifSettings.assignment) {
            // assignedById attached here, not by the collector functions
            // themselves (services/legacy tasks/sub-items have no such
            // stored field at all) — the caller making THIS assignment
            // write, right now, is the only meaningful "who assigned it"
            // for the self-assign check fireAssignmentNotifications() does
            // (2026-09-03: assignment emails go to the assignee only, never
            // when they assigned it to themselves).
            assignmentEvents.push(...collectServiceAssignmentEvents(inc, cur.data, inc).map(ev => ({ ...ev, assignedById: session.id })));
            assignmentEvents.push(...collectTaskAssignmentEvents(inc, cur.data, inc).map(ev => ({ ...ev, assignedById: session.id })));
            assignmentEvents.push(...collectSubitemAssignmentEvents(inc, cur.data, inc).map(ev => ({ ...ev, assignedById: session.id })));
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
      const reportEvents = [];
      const dueDateRequestEvents = [];
      const dueDateResolveEvents = [];
      // Every session.id check below (here and in the "not your task"
      // check further down) already uses this caller's CANONICAL employee
      // id for a dual-role admin/manager account, not their separate
      // ops_admins row id — api/ops-auth.js always sets session.id to the
      // ops_users row's id for anyone who has a linked employee identity,
      // regardless of admin tier (Sherine, creative_manager, is the first
      // real account built this way). Investigated as part of fixing task
      // parsing for her (2026-08-25): no change was needed here, since
      // this was already correct by construction — the actual bug was in
      // api/process-transcript.js's roster (the same person appeared
      // twice, under two different ids) and self-assign fallback (skipped
      // entirely for any non-'member' tier, including a dual-role
      // manager's own genuinely name-less daily-task rows).
      //
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
          // assignedDate must never be blank on a stored task (this
          // feature's own requirement) — the parser already fills it for
          // every parsed task, but a manually-created task (either portal's
          // "New Task"/self-add path) needs the same guarantee, so it's
          // forced here too rather than trusted from the client.
          // dueDateLocked always starts false at creation — a task's due
          // date isn't "locked" until an admin later CHANGES it once (see
          // the isAdmin update branch below); a client-sent true here is
          // never honored.
          const assignedDate = inc.assignedDate || todayIsoUtc();
          if (isAdmin) {
            row = { ...inc, assignedById: inc.assignedById || session.id, assignedDate, dueDateLocked: false };
          } else {
            const assigneeId = creatableAssigneeIds.has(inc.assigneeId) ? inc.assigneeId : session.id;
            // Self-assigned = auto-daily (2026-09-02): a member putting a
            // task on their OWN plate always lands due today — never
            // long-term — so it always shows up in today's My Tasks/
            // Roadmap bucket, enforced here rather than trusted from the
            // client. Deliberately scoped to true self-assign only
            // (assigneeId === the caller) — this same branch also handles
            // a manager-tier member (e.g. Sherine) creating a task for a
            // direct report (creatableAssigneeIds includes reports too,
            // see the comment above), which is managing someone ELSE's
            // work, not "my own plate" — that case keeps whatever dueDate
            // was actually submitted, unaffected by this change.
            // Weekend-clamped (2026-09-02): if today itself is a Sat/Sun
            // (e.g. a member opens the app over the weekend), the
            // auto-daily due date still never lands on that weekend day —
            // clampToWeekday() snaps it to the adjacent weekday.
            const dueDate = assigneeId === session.id ? clampToWeekday(todayIsoUtc()) : inc.dueDate;
            row = { ...inc, assigneeId, assignedById: session.id, origin: 'self', assignedDate, dueDateLocked: false, dueDate };
          }
          const { error } = await supabase.from('ops_tasks').insert({ id: inc.id, data: row });
          if (error) { warnings.push(`tasks(${inc.id}): ${error.message}`); continue; }
        } else if (isAdmin) {
          // assignedById never gets blanked by a falsy incoming value — a
          // client that hasn't pulled back the server-assigned value yet
          // (e.g. a second quick edit within the same 30s poll window)
          // would otherwise silently overwrite it with null on every save.
          //
          // assignedDate is fully immutable once a task exists — this ONLY
          // ever reads cur.assignedDate, never inc.assignedDate, so not
          // even an admin hitting this endpoint directly can change it
          // after creation (the brand-new-row branch above is the only
          // place it's ever chosen).
          //
          // dueDate may be changed by an admin exactly ONCE: the first time
          // an admin's incoming dueDate actually differs from what's
          // stored, it locks (dueDateLocked=true) and every subsequent
          // incoming value is ignored, keeping that date forever after —
          // an accidental resave that leaves dueDate unchanged never locks it.
          const dueDateLocked = !!cur.dueDateLocked;
          const dueDate = dueDateLocked
            ? cur.dueDate
            : (typeof inc.dueDate === 'string' ? inc.dueDate : (cur.dueDate || ''));
          const dueDateJustLocked = !dueDateLocked && dueDate !== (cur.dueDate || '');
          row = {
            ...inc,
            assignedById: inc.assignedById || cur.assignedById || null,
            assignedDate: cur.assignedDate || todayIsoUtc(),
            dueDate,
            dueDateLocked: dueDateLocked || dueDateJustLocked,
          };
          // Due-date-change request resolution (2026-09-03) — detected, not
          // trusted from a client-sent flag: a pending request existed on
          // `cur` and is now absent from `row` (the client clears it to
          // resolve one, whether approving or declining — an unrelated edit
          // that never touches this field leaves it exactly as `cur` had
          // it, so this block never fires for those). Approved vs declined
          // is the actual dueDate outcome above, not a separate signal the
          // client could get out of sync with: approving is precisely "the
          // date actually changed" (dueDateJustLocked, computed from the
          // exact same dueDate this write already applied), declining is
          // precisely "it didn't." "Any admin may resolve any pending
          // request" (manager/super-admin only, i.e. isAdmin generally) —
          // this feature does not scope resolution to specifically the
          // routed approver, matching this codebase's existing convention
          // that admin capability over ops_tasks is uniform across every
          // admin tier, never per-record-scoped to one specific person.
          if (cur.dueDateChangeRequest && !row.dueDateChangeRequest) {
            dueDateResolveEvents.push({
              taskId: inc.id, subject: row.subject,
              requestedBy: cur.dueDateChangeRequest.requestedBy,
              proposedDate: cur.dueDateChangeRequest.proposedDate,
              approved: dueDateJustLocked,
              clientId: row.clientId || null,
            });
          }
          const { error } = await supabase.from('ops_tasks').update({ data: row }).eq('id', inc.id);
          if (error) { warnings.push(`tasks(${inc.id}): ${error.message}`); continue; }
        } else {
          if (cur.assigneeId !== session.id) {
            rejected.push({ table: 'tasks', id: inc.id, reason: 'not your task' });
            continue;
          }
          // dueDate gets its own fill-only rule below, not the flat
          // compare every other disallowed key uses — a member may FILL a
          // previously-empty dueDate (needed for the duplicate-merge
          // feature's "fill the due date only if missing" additive rule)
          // but never CHANGE one that's already set. Found and fixed
          // 2026-08-26 while building that feature: the parser's own
          // existing parse-time merge-into-existing-task path has always
          // filled a missing dueDate the same way, which means a member's
          // merge was being silently rejected here before this fix,
          // despite the UI already showing it as merged.
          const disallowedKey = TASK_KEYS_MEMBER_MAY_NOT_TOUCH.find(key => {
            if (key === 'dueDate') return false;
            return JSON.stringify(cur[key]) !== JSON.stringify(inc[key]);
          });
          if (disallowedKey) {
            rejected.push({ table: 'tasks', id: inc.id, reason: `members cannot edit tasks.${disallowedKey}` });
            continue;
          }
          if (cur.dueDate && inc.dueDate !== cur.dueDate) {
            rejected.push({ table: 'tasks', id: inc.id, reason: 'members cannot edit tasks.dueDate' });
            continue;
          }
          // "Report task" (2026-09-01) — who reported it is always taken
          // from the caller's own session, never trusted from the client,
          // matching reviewedBy/reviewedByName's convention elsewhere in
          // this file. reportedMisassigned* falls back to cur when the
          // incoming payload omits it (the same "never let an absent field
          // blank a real value" convention assignedById/clientEmails/etc.
          // already use elsewhere in this file) — a stale local copy
          // resaving an unrelated field (e.g. status) right after a report
          // action, before the next pull has echoed reportedMisassignedBy/
          // At back down to this client, must not wipe them. Only fires on
          // the actual transition into reportedMisassigned (never a resave
          // that leaves it set), and only for a task actually assigned by
          // an admin — the UI only shows the button there, but this is the
          // real server-side guard: reportedMisassigned* is intentionally
          // NOT in TASK_KEYS_MEMBER_MAY_NOT_TOUCH (a member must be able to
          // write it on their own task), so without this a client could
          // still set the flag on a self-added task.
          row = {
            ...inc,
            reportedMisassigned: typeof inc.reportedMisassigned === 'boolean' ? inc.reportedMisassigned : (cur.reportedMisassigned || false),
            reportedMisassignedBy: inc.reportedMisassignedBy || cur.reportedMisassignedBy || null,
            reportedMisassignedByName: inc.reportedMisassignedByName || cur.reportedMisassignedByName || null,
            reportedMisassignedAt: inc.reportedMisassignedAt || cur.reportedMisassignedAt || null,
            // Due-date-change request (Item C, 2026-09-03) — a member can
            // only ever CREATE one, never clear/edit it (there's no self-
            // cancel here, out of this feature's stated scope); an
            // incoming clear/edit attempt is silently ignored, always
            // falling back to whatever cur already had. Resolving a
            // pending request (approve/decline) only ever happens on the
            // isAdmin branch above.
            dueDateChangeRequest: cur.dueDateChangeRequest || null,
          };
          if (row.reportedMisassigned && !cur.reportedMisassigned && cur.origin === 'admin') {
            row = { ...row, reportedMisassignedBy: session.id, reportedMisassignedByName: session.name, reportedMisassignedAt: new Date().toISOString() };
            reportEvents.push({
              taskId: inc.id, subject: row.subject, assignedById: cur.assignedById || null,
              clientId: row.clientId || null, reportedByName: session.name,
            });
          }
          // Only fires on the actual transition into a pending request
          // (never a resave that leaves one already set, and never when
          // one is already pending — one request at a time). requestedBy/
          // requestedByName/requestedAt are always taken from the caller's
          // own session, never trusted from the client, same convention
          // reportedMisassigned* above already established.
          if (!cur.dueDateChangeRequest && inc.dueDateChangeRequest && hasContent(inc.dueDateChangeRequest.proposedDate)) {
            const proposedDate = String(inc.dueDateChangeRequest.proposedDate);
            const reason = String(inc.dueDateChangeRequest.reason || '').slice(0, 500);
            row = {
              ...row,
              dueDateChangeRequest: { proposedDate, reason, requestedBy: session.id, requestedByName: session.name, requestedAt: new Date().toISOString() },
            };
            dueDateRequestEvents.push({
              taskId: inc.id, subject: row.subject, proposedDate, reason,
              requestedBy: session.id, requestedByName: session.name, clientId: row.clientId || null,
            });
          }
          const { error } = await supabase.from('ops_tasks').update({ data: row }).eq('id', inc.id);
          if (error) { warnings.push(`tasks(${inc.id}): ${error.message}`); continue; }
        }
        n++;
        // row.assigneeId!==session.id was the old proxy for "not a self-
        // assign" here — removed (2026-09-03): the real, literal
        // self-assign definition (assignedById===assigneeId) is now
        // enforced inside fireOpsTaskAssignmentNotifications() itself, from
        // row.assignedById passed through below, so this gate only needs
        // to decide whether an assignment actually happened at all.
        if (notifSettings.assignment && row.assigneeId && assigneeChanged(cur, row)) {
          taskAssignmentEvents.push({
            taskId: inc.id, subject: row.subject, assigneeId: row.assigneeId, assignedById: row.assignedById || null,
            clientId: row.clientId || null, clientName: row.clientName || '', dueDate: row.dueDate || '',
          });
        }
      }
      applied.tasks = n;
      await fireOpsTaskAssignmentNotifications(supabase, taskAssignmentEvents, warnings);
      await fireTaskReportedNotifications(supabase, reportEvents, warnings);
      await fireDueDateChangeRequestedNotification(supabase, dueDateRequestEvents, warnings);
      await fireDueDateChangeResolvedNotification(supabase, dueDateResolveEvents, warnings);
    }

    // ── Task hard delete — genuine hard SQL DELETE. ops_tasks has no
    // deleted_at column and no append-only guard trigger (unlike
    // ops_org_nodes/ops_org_links's soft-tombstone convention above, or
    // ops_feed/ops_time_off_ledger's insert-only guard) — a plain
    // document-model table, so this really does remove the row, per this
    // feature's own "normal per-record delete" instruction. A member may
    // delete only a task THEY created (assignedById===session.id) — never
    // just because it's assigned to them — which can never be spoofed by
    // the client, since assignedById is always server-forced to the
    // caller at insert time (see the tasks-write block above). Admin/
    // super may delete any task id, unconditionally. (2026-08-21: briefly
    // broadened to also allow assigneeId===session.id for the general-
    // purpose Delete button/inline delete, then narrowed back to
    // assignedById-only per explicit instruction — self-created only.)
    if (Array.isArray(tombstones?.taskIds) && tombstones.taskIds.length) {
      const idsToDelete = [...new Set(tombstones.taskIds.filter(id => typeof id === 'string' && id))];
      if (idsToDelete.length) {
        let deletableIds = idsToDelete;
        if (!isAdmin) {
          const { data: rows, error: fetchErr } = await supabase.from('ops_tasks').select('id, data').in('id', idsToDelete);
          if (fetchErr) {
            warnings.push(`taskIds delete: ${fetchErr.message}`);
            deletableIds = [];
          } else {
            deletableIds = (rows || [])
              .filter(r => r.data?.assignedById === session.id)
              .map(r => r.id);
            idsToDelete
              .filter(id => !deletableIds.includes(id))
              .forEach(id => rejected.push({ table: 'tasks', id, reason: 'not your task' }));
          }
        }
        if (deletableIds.length) {
          const { error } = await supabase.from('ops_tasks').delete().in('id', deletableIds);
          if (error) {
            warnings.push(`taskIds delete: ${error.message}`);
          } else {
            applied.deletedTaskIds = deletableIds.length;
            // Clean up any notification pointing at a now-deleted task
            // (2026-09-02) — taskAssignment/taskReported are the only two
            // types whose context carries a real ops_tasks id (see
            // _routeAdminNotifClick()'s own comment on this file's other
            // notification types, whose context.taskId — when present at
            // all — is a completely different, legacy id). Scoped to just
            // deletableIds, the tasks ACTUALLY removed above, never the
            // full requested list (which can include ids a non-admin
            // caller wasn't authorized to delete and are still real rows).
            // Best-effort: a failure here is logged as a warning but never
            // turns the task deletion itself into a failure — the task is
            // already gone either way.
            const { error: notifErr } = await supabase.from('ops_notifications').delete().in('data->context->>taskId', deletableIds);
            if (notifErr) warnings.push(`orphaned notifications cleanup: ${notifErr.message}`);
          }
        }
      }
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
