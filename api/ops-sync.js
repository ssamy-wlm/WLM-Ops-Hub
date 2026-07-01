// Replaces PUT /api/cloud-data. Instead of overwriting the whole shared
// record, this endpoint upserts ONLY the specific rows the caller says
// changed. There is no "replace all" code path anywhere in this file, which
// is what makes the old "empty/stale browser silently wipes everyone else's
// data" bug structurally impossible here — a browser with a stale or empty
// local cache simply has nothing to send.
//
// Body shape: { changes: { users?, admins?, clients?, goals?, feed?,
// messages?, roadmapTasks?, timeOffRequests?, timeOffLedger?, summaries?,
// settings?, orgNodes?, orgLinks? }, tombstones?: { users?: [ids] },
// restoreUserIds?: [ids] }
//
// Every array in `changes` is a list of ONLY the records that actually
// changed (new or edited) — never the full dataset. Role comes from the
// signed session token, never from the request body.

import { getSupabaseAdmin } from '../lib/supabaseAdmin.js';
import { requireSession } from '../lib/opsSession.js';

// NOTE: the Blob-era task-change email notifications (api/_task-notifications.js)
// are deferred to a follow-up PR — they depended on the whole-record diffing
// this endpoint intentionally no longer does. On-demand assignment emails
// (api/send-assignment-email.js) are untouched and still work.

const ADMIN_ONLY_TABLES = new Set(['users', 'admins', 'roadmapTasks', 'timeOffLedger', 'summaries', 'orgNodes', 'orgLinks', 'settings']);

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

function walkTasksAssignedTo(clientData, memberId) {
  // Returns the set of task ids inside this client's projects/subprojects that
  // are assigned to memberId — the ONLY items a member may write to.
  const ids = new Set();
  for (const p of clientData.projects || []) {
    for (const t of p.tasks || []) if (t.assigneeId === memberId) ids.add(t.id);
    for (const sp of p.subprojects || []) {
      for (const t of sp.tasks || []) if (t.assigneeId === memberId) ids.add(t.id);
    }
  }
  return ids;
}

// Builds a client record where every field is taken from the CURRENT db copy
// except tasks assigned to this member, which may be taken from the incoming
// payload. Everything else the member sent (client-level fields, project
// metadata, other people's tasks) is discarded — the server enforces this,
// it does not rely on the browser only showing assigned items.
function applyMemberClientPatch(current, incoming, memberId) {
  const assigned = walkTasksAssignedTo(current, memberId);
  const merged = JSON.parse(JSON.stringify(current));
  const incomingProjects = incoming.projects || [];
  for (const mp of merged.projects || []) {
    const ip = incomingProjects.find(x => x.id === mp.id);
    if (!ip) continue;
    mp.tasks = (mp.tasks || []).map(t => {
      if (!assigned.has(t.id)) return t;
      const it = (ip.tasks || []).find(x => x.id === t.id);
      return it || t;
    });
    for (const msp of mp.subprojects || []) {
      const isp = (ip.subprojects || []).find(x => x.id === msp.id);
      if (!isp) continue;
      msp.tasks = (msp.tasks || []).map(t => {
        if (!assigned.has(t.id)) return t;
        const it = (isp.tasks || []).find(x => x.id === t.id);
        return it || t;
      });
    }
  }
  return merged;
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
  const isAdmin = session.role === 'admin';

  let supabase;
  try { supabase = getSupabaseAdmin(); }
  catch (err) { return res.status(500).json({ error: err.message }); }

  const { changes, tombstones, restoreUserIds } = req.body || {};
  const warnings = [];
  const applied = {};

  try {
    const c = changes || {};

    // ── self password change: allowed for EVERY role, but strictly scoped to
    // the caller's OWN row and ONLY the password/mustChangePassword fields —
    // this is the one carve-out into the otherwise admin-only users/admins
    // tables, so a member can change their own login without gaining any
    // other write access to the users table. ──
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

    // ── admin-only tables: silently drop (not error) a member's attempt, so a
    // stray field in a batched payload can't fail the whole sync ──
    for (const key of Object.keys(c)) {
      if (!isAdmin && ADMIN_ONLY_TABLES.has(key) && Array.isArray(c[key]) && c[key].length) {
        warnings.push(`${key}: dropped — admin-only table, caller role is member`);
      }
    }

    if (isAdmin) {
      applied.users = await upsertRows(supabase, 'ops_users', (c.users || []).filter(validUserOrAdmin), warnings);
      applied.admins = await upsertRows(supabase, 'ops_admins', (c.admins || []).filter(validUserOrAdmin), warnings);
      applied.roadmapTasks = await upsertRows(supabase, 'ops_roadmap_tasks', (c.roadmapTasks || []).filter(validGeneric), warnings);
      applied.orgNodes = await upsertRows(supabase, 'ops_org_nodes', (c.orgNodes || []).filter(validGeneric), warnings);
      applied.orgLinks = await upsertRows(supabase, 'ops_org_links', (c.orgLinks || []).filter(validGeneric), warnings);

      if (Array.isArray(c.timeOffLedger) && c.timeOffLedger.length) {
        applied.timeOffLedger = await insertNewOnly(supabase, 'ops_time_off_ledger', c.timeOffLedger.filter(validGeneric), warnings);
      }
      if (c.settings && typeof c.settings === 'object') {
        for (const [key, value] of Object.entries(c.settings)) {
          const { error } = await supabase.from('ops_settings').upsert({ key, data: value }, { onConflict: 'key' });
          if (error) warnings.push(`settings.${key}: ${error.message}`);
        }
        applied.settings = Object.keys(c.settings).length;
      }
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
    }

    // ── clients: allowed for both roles; members are field-restricted server-side ──
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
          const toWrite = [];
          for (const inc of incoming) {
            const cur = byId.get(inc.id);
            if (!cur) { warnings.push(`clients(${inc.id}): skipped — members cannot create new clients`); continue; }
            const patched = applyMemberClientPatch(cur.data, inc, session.id);
            toWrite.push({ id: cur.id, data: patched }); // status untouched — members cannot change active/inactive
          }
          let n = 0;
          for (const row of toWrite) {
            const { error: uErr } = await supabase.from('ops_clients').update({ data: row.data }).eq('id', row.id);
            if (uErr) warnings.push(`clients(${row.id}): ${uErr.message}`); else n++;
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

    // ── time off requests: members may only create their own pending request,
    // or edit their own request's non-status fields; only admins can set status ──
    if (Array.isArray(c.timeOffRequests) && c.timeOffRequests.length) {
      const incoming = c.timeOffRequests.filter(validGeneric);
      const ids = incoming.map(r => r.id);
      const { data: currentRows } = await supabase.from('ops_time_off_requests').select('id, data').in('id', ids);
      const byId = new Map((currentRows || []).map(r => [r.id, r.data]));
      let n = 0;
      for (const inc of incoming) {
        const cur = byId.get(inc.id);
        if (isAdmin) {
          const { error } = await supabase.from('ops_time_off_requests').upsert({ id: inc.id, data: inc }, { onConflict: 'id' });
          if (error) warnings.push(`timeOffRequests(${inc.id}): ${error.message}`); else n++;
          continue;
        }
        if (!cur) {
          if (inc.userId !== session.id) { warnings.push(`timeOffRequests(${inc.id}): skipped — members can only create their own request`); continue; }
          const row = { ...inc, status: 'pending', approvedBy: null, reviewedAt: null };
          const { error } = await supabase.from('ops_time_off_requests').insert({ id: inc.id, data: row });
          if (error) warnings.push(`timeOffRequests(${inc.id}): ${error.message}`); else n++;
        } else {
          if (cur.userId !== session.id) { warnings.push(`timeOffRequests(${inc.id}): skipped — not this member's request`); continue; }
          const row = { ...inc, status: cur.status, approvedBy: cur.approvedBy, reviewedAt: cur.reviewedAt }; // status locked to admin
          const { error } = await supabase.from('ops_time_off_requests').update({ data: row }).eq('id', inc.id);
          if (error) warnings.push(`timeOffRequests(${inc.id}): ${error.message}`); else n++;
        }
      }
      applied.timeOffRequests = n;
    }

    return res.status(200).json({ ok: true, applied, warnings });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Sync failed', warnings });
  }
}
