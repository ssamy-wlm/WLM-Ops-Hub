// One-time importer: reads the live Vercel Blob cloud-data.json record and
// loads it into the new ops_* Supabase tables (see
// supabase/migrations/20260629130000_ops_hub_core_schema.sql). Mirrors
// api/migrate-schema.js's fail-closed secret-header pattern. Every insert is
// an upsert keyed on legacy_id, so re-running this after fixing a bug
// overwrites previously-imported rows instead of duplicating them — safe to
// run multiple times against the same target schema.
//
// Run this against a schema with no live app traffic depending on it yet
// (Phase 1 of the migration plan): nothing here keeps the new tables in sync
// with Blob after the fact, so this is an offline snapshot import, not a
// dual-write bridge.

import bcrypt from 'bcryptjs';
import { dualGet } from './_blob-dual.js';
import { getSupabaseAdmin } from '../lib/supabaseAdmin.js';
import {
  transformUsers, transformAdmins, transformAdminAssignedUsers, transformDeletedUserIds,
  transformClients, transformServices, transformProjects, transformProjectUsers,
  transformSubprojects, transformSubprojectUsers, transformTasks,
  transformOrgNodes, transformOrgLinks, transformGoals, transformFeed, transformMessages,
  transformRoadmapTasks, transformTimeOffRequests, transformTimeOffLedger,
  transformSettingsSingleton, transformRecurringServicesDropped,
} from '../lib/legacyDataTransform.js';

const BLOB_PATH = 'wlm-ops-hub/cloud-data.json';
const BCRYPT_ROUNDS = 10;

// Upserts rows keyed on legacy_id and returns a Map<legacy_id, newUuid> built
// from the inserted/updated rows, for resolving this batch's FKs in the next.
async function upsertBatch(supabase, table, rows, warnings) {
  const map = new Map();
  if (!rows.length) return map;
  const { data, error } = await supabase
    .from(table)
    .upsert(rows, { onConflict: 'legacy_id' })
    .select('id, legacy_id');
  if (error) {
    warnings.push(`${table}: upsert failed — ${error.message}`);
    return map;
  }
  for (const row of data || []) map.set(row.legacy_id, row.id);
  return map;
}

function resolveFk(map, legacyId, label, warnings) {
  if (!legacyId) return null;
  const id = map.get(legacyId);
  if (!id) warnings.push(`${label}: unresolved legacy id "${legacyId}", left null`);
  return id || null;
}

async function extractPhoto(supabase, legacyId, dataUrl, warnings) {
  if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) return null;
  try {
    const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) return null;
    const [, mime, base64] = match;
    const ext = mime.split('/')[1]?.split('+')[0] || 'png';
    const path = `${legacyId}.${ext}`;
    const buffer = Buffer.from(base64, 'base64');
    const { error } = await supabase.storage
      .from('org-photos')
      .upload(path, buffer, { contentType: mime, upsert: true });
    if (error) {
      warnings.push(`org-photos upload for ${legacyId}: ${error.message}`);
      return null;
    }
    return path;
  } catch (err) {
    warnings.push(`org-photos upload for ${legacyId}: ${err.message || err}`);
    return null;
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-migration-secret');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const expectedSecret = process.env.MIGRATION_SECRET;
  if (!expectedSecret) {
    return res.status(500).json({ error: 'MIGRATION_SECRET is not configured on the server. Set it in Vercel env vars before using this endpoint.' });
  }
  const providedSecret = req.headers['x-migration-secret'];
  if (!providedSecret || providedSecret !== expectedSecret) {
    return res.status(403).json({ error: 'Invalid or missing x-migration-secret header' });
  }

  let supabase;
  try {
    supabase = getSupabaseAdmin();
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  const warnings = [];
  const counts = {};

  try {
    const blob = await dualGet(BLOB_PATH, { access: 'private', useCache: false });
    if (!blob) return res.status(404).json({ error: 'No live cloud-data blob found to import' });
    const record = JSON.parse((await new Response(blob.stream).text()) || '{}');

    // ── people ────────────────────────────────────────────────────────────
    const userRows = transformUsers(record).map(u => ({
      ...u, password_hash: bcrypt.hashSync(u.password || '', BCRYPT_ROUNDS), password: undefined,
    }));
    for (const u of userRows) delete u.password;
    const usersNoMgr = userRows.map(({ manager_legacy_id, ...rest }) => rest);
    const userMap = await upsertBatch(supabase, 'ops_users', usersNoMgr, warnings);
    counts.ops_users = userMap.size;

    // second pass: now that every user has an id, resolve manager_id self-references
    const userMgrRows = userRows
      .filter(u => u.manager_legacy_id)
      .map(u => ({
        legacy_id: u.legacy_id,
        manager_id: resolveFk(userMap, u.manager_legacy_id, `ops_users(${u.legacy_id}).manager_id`, warnings),
      }))
      .filter(u => u.manager_id);
    if (userMgrRows.length) await upsertBatch(supabase, 'ops_users', userMgrRows, warnings);

    const adminRows = transformAdmins(record).map(a => ({
      ...a, password_hash: bcrypt.hashSync(a.password || '', BCRYPT_ROUNDS), password: undefined,
    }));
    for (const a of adminRows) delete a.password;
    const adminMap = await upsertBatch(supabase, 'ops_admins', adminRows, warnings);
    counts.ops_admins = adminMap.size;

    const assignedUserRows = transformAdminAssignedUsers(record)
      .map(r => ({
        admin_id: resolveFk(adminMap, r.admin_legacy_id, 'ops_admin_assigned_users.admin_id', warnings),
        user_id: resolveFk(userMap, r.user_legacy_id, 'ops_admin_assigned_users.user_id', warnings),
      }))
      .filter(r => r.admin_id && r.user_id);
    if (assignedUserRows.length) {
      const { error } = await supabase.from('ops_admin_assigned_users').upsert(assignedUserRows, { onConflict: 'admin_id,user_id' });
      if (error) warnings.push(`ops_admin_assigned_users: ${error.message}`);
    }
    counts.ops_admin_assigned_users = assignedUserRows.length;

    const deletedIdRows = transformDeletedUserIds(record);
    if (deletedIdRows.length) {
      const { error } = await supabase.from('ops_deleted_user_ids').upsert(deletedIdRows, { onConflict: 'legacy_user_id' });
      if (error) warnings.push(`ops_deleted_user_ids: ${error.message}`);
    }
    counts.ops_deleted_user_ids = deletedIdRows.length;

    // ── clients / services / projects / subprojects / tasks ───────────────
    const clientRows = transformClients(record).map(({ manager_legacy_id, ...rest }) => ({
      ...rest,
      manager_id: resolveFk(userMap, manager_legacy_id, `ops_clients(${rest.legacy_id}).manager_id`, warnings),
    }));
    const clientMap = await upsertBatch(supabase, 'ops_clients', clientRows, warnings);
    counts.ops_clients = clientMap.size;

    const serviceRows = transformServices(record).map(({ client_legacy_id, assignee_legacy_id, ...rest }) => ({
      ...rest,
      client_id: resolveFk(clientMap, client_legacy_id, `ops_services(${rest.legacy_id}).client_id`, warnings),
      assignee_id: resolveFk(userMap, assignee_legacy_id, `ops_services(${rest.legacy_id}).assignee_id`, warnings),
    })).filter(s => s.client_id);
    const serviceMap = await upsertBatch(supabase, 'ops_services', serviceRows, warnings);
    counts.ops_services = serviceMap.size;

    const projectRows = transformProjects(record).map(({ client_legacy_id, service_legacy_id, ...rest }) => ({
      ...rest,
      client_id: resolveFk(clientMap, client_legacy_id, `ops_projects(${rest.legacy_id}).client_id`, warnings),
      service_id: resolveFk(serviceMap, service_legacy_id, `ops_projects(${rest.legacy_id}).service_id`, warnings),
    })).filter(p => p.client_id);
    const projectMap = await upsertBatch(supabase, 'ops_projects', projectRows, warnings);
    counts.ops_projects = projectMap.size;

    const projectUserRows = transformProjectUsers(record)
      .map(r => ({
        project_id: resolveFk(projectMap, r.project_legacy_id, 'ops_project_users.project_id', warnings),
        user_id: resolveFk(userMap, r.user_legacy_id, 'ops_project_users.user_id', warnings),
      }))
      .filter(r => r.project_id && r.user_id);
    if (projectUserRows.length) {
      const { error } = await supabase.from('ops_project_users').upsert(projectUserRows, { onConflict: 'project_id,user_id' });
      if (error) warnings.push(`ops_project_users: ${error.message}`);
    }
    counts.ops_project_users = projectUserRows.length;

    const subprojectRows = transformSubprojects(record).map(({ project_legacy_id, ...rest }) => ({
      ...rest,
      project_id: resolveFk(projectMap, project_legacy_id, `ops_subprojects(${rest.legacy_id}).project_id`, warnings),
    })).filter(sp => sp.project_id);
    const subprojectMap = await upsertBatch(supabase, 'ops_subprojects', subprojectRows, warnings);
    counts.ops_subprojects = subprojectMap.size;

    const subprojectUserRows = transformSubprojectUsers(record)
      .map(r => ({
        subproject_id: resolveFk(subprojectMap, r.subproject_legacy_id, 'ops_subproject_users.subproject_id', warnings),
        user_id: resolveFk(userMap, r.user_legacy_id, 'ops_subproject_users.user_id', warnings),
      }))
      .filter(r => r.subproject_id && r.user_id);
    if (subprojectUserRows.length) {
      const { error } = await supabase.from('ops_subproject_users').upsert(subprojectUserRows, { onConflict: 'subproject_id,user_id' });
      if (error) warnings.push(`ops_subproject_users: ${error.message}`);
    }
    counts.ops_subproject_users = subprojectUserRows.length;

    const taskRows = transformTasks(record).map(({ project_legacy_id, subproject_legacy_id, assignee_legacy_id, last_edited_by_legacy_id, ...rest }) => ({
      ...rest,
      project_id: project_legacy_id ? resolveFk(projectMap, project_legacy_id, `ops_tasks(${rest.legacy_id}).project_id`, warnings) : null,
      subproject_id: subproject_legacy_id ? resolveFk(subprojectMap, subproject_legacy_id, `ops_tasks(${rest.legacy_id}).subproject_id`, warnings) : null,
      assignee_id: resolveFk(userMap, assignee_legacy_id, `ops_tasks(${rest.legacy_id}).assignee_id`, warnings),
      last_edited_by_id: resolveFk(userMap, last_edited_by_legacy_id, `ops_tasks(${rest.legacy_id}).last_edited_by_id`, warnings),
    })).filter(t => t.project_id || t.subproject_id);
    const taskMap = await upsertBatch(supabase, 'ops_tasks', taskRows, warnings);
    counts.ops_tasks = taskMap.size;

    const droppedRecurring = transformRecurringServicesDropped(record);
    if (droppedRecurring.count) {
      warnings.push(`Dropped ${droppedRecurring.count} legacy recurringServices[] entries across ${droppedRecurring.byClient.length} client(s) (flagged as legacy/unused, not migrated): ${JSON.stringify(droppedRecurring.byClient)}`);
    }

    // ── org chart ───────────────────────────────────────────────────────
    const orgNodeInputs = transformOrgNodes(record);
    const orgNodeRows = [];
    for (const n of orgNodeInputs) {
      const photo_url = await extractPhoto(supabase, n.legacy_id, n.photo, warnings);
      const { photo, ...rest } = n;
      orgNodeRows.push({ ...rest, photo_url });
    }
    const orgNodeMap = await upsertBatch(supabase, 'ops_org_nodes', orgNodeRows, warnings);
    counts.ops_org_nodes = orgNodeMap.size;

    const orgLinkRows = transformOrgLinks(record)
      .map(l => ({
        manager_node_id: resolveFk(orgNodeMap, l.manager_legacy_id, 'ops_org_links.manager_node_id', warnings),
        report_node_id: resolveFk(orgNodeMap, l.report_legacy_id, 'ops_org_links.report_node_id', warnings),
      }))
      .filter(l => l.manager_node_id && l.report_node_id);
    if (orgLinkRows.length) {
      const { error } = await supabase.from('ops_org_links').upsert(orgLinkRows, { onConflict: 'manager_node_id,report_node_id' });
      if (error) warnings.push(`ops_org_links: ${error.message}`);
    }
    counts.ops_org_links = orgLinkRows.length;

    // ── flat / append collections ─────────────────────────────────────────
    counts.ops_goals = (await upsertBatch(supabase, 'ops_goals', transformGoals(record), warnings)).size;

    const feedRows = transformFeed(record).filter(f => f.legacy_id);
    counts.ops_feed = (await upsertBatch(supabase, 'ops_feed', feedRows, warnings)).size;
    const feedNoLegacy = transformFeed(record).filter(f => !f.legacy_id);
    if (feedNoLegacy.length) {
      const { error } = await supabase.from('ops_feed').insert(feedNoLegacy.map(({ legacy_id, ...r }) => r));
      if (error) warnings.push(`ops_feed (no legacy id, plain insert): ${error.message}`);
      else counts.ops_feed += feedNoLegacy.length;
    }

    const messageRows = transformMessages(record).filter(m => m.legacy_id);
    counts.ops_messages = (await upsertBatch(supabase, 'ops_messages', messageRows, warnings)).size;
    const messagesNoLegacy = transformMessages(record).filter(m => !m.legacy_id);
    if (messagesNoLegacy.length) {
      const { error } = await supabase.from('ops_messages').insert(messagesNoLegacy.map(({ legacy_id, ...r }) => r));
      if (error) warnings.push(`ops_messages (no legacy id, plain insert): ${error.message}`);
      else counts.ops_messages += messagesNoLegacy.length;
    }

    counts.ops_roadmap_tasks = (await upsertBatch(supabase, 'ops_roadmap_tasks', transformRoadmapTasks(record).filter(r => r.legacy_id), warnings)).size;

    const timeOffReqRows = transformTimeOffRequests(record).map(({ user_legacy_id, approved_by_legacy_id, ...rest }) => ({
      ...rest,
      user_id: resolveFk(userMap, user_legacy_id, `ops_time_off_requests(${rest.legacy_id}).user_id`, warnings),
      approved_by: resolveFk(adminMap, approved_by_legacy_id, `ops_time_off_requests(${rest.legacy_id}).approved_by`, warnings),
    })).filter(r => r.user_id);
    counts.ops_time_off_requests = (await upsertBatch(supabase, 'ops_time_off_requests', timeOffReqRows, warnings)).size;

    const ledgerRows = transformTimeOffLedger(record).map(({ user_legacy_id, ...rest }) => ({
      ...rest,
      user_id: resolveFk(userMap, user_legacy_id, `ops_time_off_ledger(${rest.legacy_id}).user_id`, warnings),
    })).filter(r => r.user_id);
    counts.ops_time_off_ledger = (await upsertBatch(supabase, 'ops_time_off_ledger', ledgerRows, warnings)).size;

    // ── settings singleton ─────────────────────────────────────────────────
    const settings = transformSettingsSingleton(record);
    const primary_admin_password_hash = settings.primary_admin_password
      ? bcrypt.hashSync(settings.primary_admin_password, BCRYPT_ROUNDS)
      : null;
    const { error: settingsErr } = await supabase
      .from('ops_settings_singleton')
      .update({
        announcement: settings.announcement,
        coc: settings.coc,
        app_settings: settings.app_settings,
        ot_policy: settings.ot_policy,
        org_layout_version: settings.org_layout_version,
        org_excluded_names: settings.org_excluded_names,
        ...(primary_admin_password_hash ? { primary_admin_password_hash } : {}),
      })
      .eq('id', true);
    if (settingsErr) warnings.push(`ops_settings_singleton: ${settingsErr.message}`);
    counts.ops_settings_singleton = settingsErr ? 0 : 1;

    return res.status(200).json({ ok: true, counts, warnings });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Import failed', counts, warnings });
  }
}
