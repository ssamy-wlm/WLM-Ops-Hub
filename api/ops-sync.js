// Replaces PUT /api/cloud-data. Instead of overwriting the whole shared
// record, this endpoint upserts ONLY the specific rows the caller says
// changed. There is no "replace all" code path anywhere in this file, which
// is what makes the old "empty/stale browser silently wipes everyone else's
// data" bug structurally impossible here — a browser with a stale or empty
// local cache simply has nothing to send.
//
// Body shape: { changes: { users?, admins?, clients?, goals?, feed?,
// messages?, roadmapTasks?, timeOffRequests?, timeOffLedger?, summaries?,
// settings?, orgNodes?, orgLinks?, catalogSuggestions?, notifications? },
// tombstones?: { users?: [ids] }, restoreUserIds?: [ids] }
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
import { requireSession, tierOf } from '../lib/opsSession.js';
import { sendResendEmail, buildEmailHtml } from '../lib/resendClient.js';
import { logError } from '../lib/errorLog.js';

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
const ADMIN_TABLES = new Set(['users', 'admins', 'roadmapTasks', 'timeOffLedger', 'summaries', 'orgNodes', 'orgLinks', 'settings']);
const PAYROLL_FIELDS = ['payRate', 'hours'];

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

// ── member client-write validation ──────────────────────────────────────────
// A member may edit ONLY items they're assigned to: services[]/
// recurringServices[] (matched by assigneeId/assigneeName/assignedUserIds —
// the actual convention this app uses, see index.html ~5722-5723) and
// projects whose progress/progressLog they're updating (userUpdateProgress())
// via an assigned service, or whose tasks are assigned to them directly
// (userMarkTaskDone()). ANY other change — to the client itself, to another
// person's items — REJECTS THE WHOLE WRITE with a clear reason; nothing is
// silently merged or dropped.
function isAssignedToMember(item, memberId, memberName) {
  if (!item) return false;
  if (item.assigneeId === memberId) return true;
  if (Array.isArray(item.assignedUserIds) && item.assignedUserIds.includes(memberId)) return true;
  const assigneeName = String(item.assigneeName || item.assignee || '').trim().toLowerCase();
  const nameLower = String(memberName || '').trim().toLowerCase();
  return !!nameLower && assigneeName === nameLower;
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
];

// Returns { allowed: true } or { allowed: false, reason } — never a partial merge.
function checkMemberClientWrite(current, incoming, memberId, memberName) {
  for (const key of CLIENT_SCALAR_KEYS_MEMBER_MAY_NOT_TOUCH) {
    if (JSON.stringify(current[key]) !== JSON.stringify(incoming[key])) {
      return { allowed: false, reason: `members cannot edit client.${key}` };
    }
  }

  for (const listKey of ['services', 'recurringServices']) {
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
  const curLocs = current.locations || [], incLocs = incoming.locations || [];
  const locsStructurallyEqual = curLocs.length === incLocs.length
    && curLocs.every((l, i) => l.id === incLocs[i]?.id && l.name === incLocs[i]?.name);
  if (!locsStructurallyEqual) {
    return { allowed: false, reason: 'members cannot add/remove/rename franchises (locations)' };
  }
  for (const loc of curLocs) {
    const incLoc = incLocs.find(l => l.id === loc.id);
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
async function getNotificationSettings(supabase) {
  if (_notifSettingsCache) return _notifSettingsCache;
  const { data } = await supabase.from('ops_settings').select('data').eq('key', 'notificationSettings').maybeSingle();
  _notifSettingsCache = { assignment: true, timeOff: true, message: true, ...(data?.data || {}) };
  return _notifSettingsCache;
}

function genNotifId() {
  return `notif_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

// Resolves "the affected person + their admin/manager": the assignee
// themselves, plus — in order of preference — their configured manager
// (users[].managerId), or any admin scoped to them (admins[].assignedUsers),
// or, if neither is configured, every super/owner admin as a fallback so a
// notification is never silently dropped for lack of a configured manager.
export function resolveNotifyRecipients(userId, users, admins) {
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
  const seen = new Set();
  return out.filter(r => (seen.has(r.id) ? false : seen.add(r.id)));
}

export function assigneeChanged(prev, next) {
  const prevId = prev?.assigneeId || '';
  const nextId = next?.assigneeId || '';
  return nextId && nextId !== prevId;
}

// Walks one client's services (top-level + every franchise location's own
// services) comparing current vs incoming, returning every service whose
// assigneeId newly changed in THIS write.
export function collectServiceAssignmentEvents(client, curClient, incClient) {
  const events = [];
  const scan = (curList, incList, locationName) => {
    const curById = new Map((curList || []).filter(s => s?.id).map(s => [s.id, s]));
    (incList || []).forEach(s => {
      if (!s?.id) return;
      const prev = curById.get(s.id);
      if (assigneeChanged(prev, s)) {
        events.push({
          serviceId: s.id, serviceName: s.name, locationName,
          assigneeId: s.assigneeId, clientId: client.id, clientName: client.name,
        });
      }
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

let _directoryCache; // per-request cache — users/admins are fetched at most once per request
async function getDirectory(supabase) {
  if (_directoryCache) return _directoryCache;
  const [{ data: usersData }, { data: adminsData }] = await Promise.all([
    supabase.from('ops_users').select('id, data'),
    supabase.from('ops_admins').select('id, data'),
  ]);
  _directoryCache = {
    users: (usersData || []).map(r => ({ id: r.id, ...r.data })),
    admins: (adminsData || []).map(r => ({ id: r.id, ...r.data })),
  };
  return _directoryCache;
}

function personOf(id, kind, { users, admins }) {
  return kind === 'admin' ? admins.find(a => a.id === id) : users.find(u => u.id === id);
}

async function fireAssignmentNotifications(supabase, events, warnings) {
  if (!events.length) return;
  const { users, admins } = await getDirectory(supabase);
  const rows = [];
  events.forEach(ev => {
    resolveNotifyRecipients(ev.assigneeId, users, admins).forEach(r => {
      const person = personOf(r.id, r.kind, { users, admins });
      const isTask = !!ev.taskId;
      const title = isTask ? `New task assigned: ${ev.taskName}` : `New service assigned: ${ev.serviceName}`;
      const body = isTask
        ? `${ev.clientName} — ${ev.projectName}${ev.subName ? ' / ' + ev.subName : ''}`
        : `${ev.clientName}${ev.locationName ? ' — ' + ev.locationName : ''}`;
      rows.push({
        type: 'assignment', recipientId: r.id, recipientKind: r.kind,
        recipientName: person?.name || '', recipientEmail: person?.email || '',
        title, body, link: '',
        context: { clientId: ev.clientId, serviceId: ev.serviceId || null, taskId: ev.taskId || null },
      });
    });
  });
  await insertNotifications(supabase, rows, warnings);
}

async function fireTimeOffNotification(supabase, request, warnings) {
  const { users, admins } = await getDirectory(supabase);
  const requester = users.find(u => String(u.name || '').toLowerCase() === String(request.userName || '').toLowerCase());
  const recipients = requester
    ? resolveNotifyRecipients(requester.id, users, admins)
    : [];
  if (!recipients.length) { warnings.push(`notifications: could not resolve user "${request.userName}" for time-off decision notification`); return; }
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

async function fireMessageNotification(supabase, message, warnings) {
  const { users, admins } = await getDirectory(supabase);
  const toEmail = String(message.to || '').toLowerCase();
  const person = users.find(u => String(u.email || '').toLowerCase() === toEmail)
    || admins.find(a => String(a.email || '').toLowerCase() === toEmail);
  if (!person) { warnings.push(`notifications: could not resolve recipient "${message.to}" for message notification`); return; }
  const kind = users.includes(person) ? 'user' : 'admin';
  await insertNotifications(supabase, [{
    type: 'message', recipientId: person.id, recipientKind: kind,
    recipientName: person.name || '', recipientEmail: person.email || '',
    title: `New message from ${message.fromName || message.from}`,
    body: String(message.content || '').slice(0, 200),
    link: '', context: { messageId: message.id },
  }], warnings);
}

async function insertNotifications(supabase, rows, warnings) {
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
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let session;
  try { session = requireSession(req); }
  catch (err) { await logError({ endpoint: 'ops-sync', error: err }); return res.status(500).json({ error: err.message }); }
  if (!session) return res.status(401).json({ error: 'Missing or invalid session' });
  const tier = tierOf(session); // 'super' | 'manager' | 'member'
  const isAdmin = tier !== 'member';

  let supabase;
  try { supabase = getSupabaseAdmin(); }
  catch (err) { await logError({ endpoint: 'ops-sync', error: err, session }); return res.status(500).json({ error: err.message }); }

  const { changes, tombstones, restoreUserIds } = req.body || {};
  const warnings = [];
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
      const table = isAdmin ? 'ops_admins' : 'ops_users';
      const { data: cur } = await supabase.from(table).select('data').eq('id', session.id).maybeSingle();
      if (cur && cur.data) {
        const merged = { ...cur.data, password: c.selfPasswordChange.password };
        if ('mustChangePassword' in c.selfPasswordChange) merged.mustChangePassword = !!c.selfPasswordChange.mustChangePassword;
        const { error } = await supabase.from(table).update({ data: merged }).eq('id', session.id);
        if (error) warnings.push(`selfPasswordChange: ${error.message}`); else applied.selfPasswordChange = 1;
      } else {
        warnings.push('selfPasswordChange: own record not found');
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
      // users: both tiers manage the team, but payroll/pay-rate fields are
      // Super Admin/CEO exclusive — stripped (not rejected) for manager tier
      // so an unrelated title/role edit isn't blocked by a stale field.
      const usersIncoming = (c.users || []).filter(validUserOrAdmin);
      if (usersIncoming.length) {
        let toWrite = usersIncoming;
        if (tier === 'manager') {
          const ids = usersIncoming.map(r => r.id);
          const { data: currentRows } = await supabase.from('ops_users').select('id, data').in('id', ids);
          const byId = new Map((currentRows || []).map(r => [r.id, r.data]));
          toWrite = usersIncoming.map(u => stripPayrollFields(u, byId.get(u.id)));
        }
        applied.users = await upsertRows(supabase, 'ops_users', toWrite, warnings);
      }

      // admins/roadmap/org chart/business settings/payroll ledger: Super
      // Admin/CEO exclusive — dropped for manager tier, same as for members.
      if (tier === 'super') {
        applied.admins = await upsertRows(supabase, 'ops_admins', (c.admins || []).filter(validUserOrAdmin), warnings);
        applied.roadmapTasks = await upsertRows(supabase, 'ops_roadmap_tasks', (c.roadmapTasks || []).filter(validGeneric), warnings);
        applied.orgNodes = await upsertRows(supabase, 'ops_org_nodes', (c.orgNodes || []).filter(validGeneric), warnings);
        applied.orgLinks = await upsertRows(supabase, 'ops_org_links', (c.orgLinks || []).filter(validGeneric), warnings);
        if (Array.isArray(c.timeOffLedger) && c.timeOffLedger.length) {
          applied.timeOffLedger = await insertNewOnly(supabase, 'ops_time_off_ledger', c.timeOffLedger.filter(validGeneric), warnings);
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
        for (const key of ['admins', 'roadmapTasks', 'orgNodes', 'orgLinks', 'timeOffLedger', 'settings']) {
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

      if (isAdmin) {
        applied.clients = await upsertRows(supabase, 'ops_clients', incoming, warnings, true);
        if (notifSettings.assignment) {
          for (const inc of incoming) {
            const cur = byId.get(inc.id);
            if (!cur) continue; // brand-new client (e.g. a bulk import) — nothing to diff against
            assignmentEvents.push(...collectServiceAssignmentEvents(inc, cur.data, inc));
            assignmentEvents.push(...collectTaskAssignmentEvents(inc, cur.data, inc));
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
          }
        }
        applied.clients = n;
      }

      await fireAssignmentNotifications(supabase, assignmentEvents, warnings);
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
          if (!existingIds.has(m.id)) await fireMessageNotification(supabase, m, warnings);
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
          if (isNewDecision && notifSettings.timeOff) await fireTimeOffNotification(supabase, inc, warnings);
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
    if (warnings.length) {
      await logError({ endpoint: 'ops-sync', error: `${warnings.length} write warning(s)`, session, extra: { warnings, rejected } });
    }
    return res.status(200).json({ ok: true, applied, warnings, rejected });
  } catch (err) {
    await logError({ endpoint: 'ops-sync', error: err, session, extra: { warnings, rejected } });
    return res.status(500).json({ error: err.message || 'Sync failed', warnings, rejected });
  }
}
