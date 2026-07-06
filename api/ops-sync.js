// Replaces PUT /api/cloud-data. Instead of overwriting the whole shared
// record, this endpoint upserts ONLY the specific rows the caller says
// changed. There is no "replace all" code path anywhere in this file, which
// is what makes the old "empty/stale browser silently wipes everyone else's
// data" bug structurally impossible here — a browser with a stale or empty
// local cache simply has nothing to send.
//
// Body shape: { changes: { users?, admins?, clients?, goals?, feed?,
// messages?, roadmapTasks?, timeOffRequests?, timeOffLedger?, summaries?,
// settings?, orgNodes?, orgLinks?, catalogSuggestions? },
// tombstones?: { users?: [ids] }, restoreUserIds?: [ids] }
//
// Every array in `changes` is a list of ONLY the records that actually
// changed (new or edited) — never the full dataset. Role comes from the
// signed session token, never from the request body.

import { getSupabaseAdmin } from '../lib/supabaseAdmin.js';
import { requireSession, tierOf } from '../lib/opsSession.js';

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
  catch (err) { return res.status(500).json({ error: err.message }); }
  if (!session) return res.status(401).json({ error: 'Missing or invalid session' });
  const tier = tierOf(session); // 'super' | 'manager' | 'member'
  const isAdmin = tier !== 'member';

  let supabase;
  try { supabase = getSupabaseAdmin(); }
  catch (err) { return res.status(500).json({ error: err.message }); }

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
      if (isAdmin) {
        applied.clients = await upsertRows(supabase, 'ops_clients', incoming, warnings, true);
      } else {
        const ids = incoming.map(r => r.id);
        const { data: currentRows, error } = await supabase.from('ops_clients').select('id, status, data').in('id', ids);
        if (error) { warnings.push(`clients: ${error.message}`); }
        else {
          const byId = new Map((currentRows || []).map(r => [r.id, r]));
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
            if (uErr) warnings.push(`clients(${inc.id}): ${uErr.message}`); else n++;
          }
          applied.clients = n;
        }
      }
    }

    applied.goals = await upsertRows(supabase, 'ops_goals', (c.goals || []).filter(validGeneric), warnings);
    applied.messages = await upsertRows(supabase, 'ops_messages', (c.messages || []).filter(validGeneric), warnings);
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
      let n = 0;
      for (const inc of incoming) {
        const cur = byId.get(inc.id);
        if (isAdmin) {
          const { error } = await supabase.from('ops_time_off_requests').upsert({ id: inc.id, data: inc }, { onConflict: 'id' });
          if (error) warnings.push(`timeOffRequests(${inc.id}): ${error.message}`); else n++;
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

    return res.status(200).json({ ok: true, applied, warnings, rejected });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Sync failed', warnings, rejected });
  }
}
