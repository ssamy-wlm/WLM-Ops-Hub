// Replaces GET /api/cloud-data. Assembles the shared record from the ops_*
// Supabase tables and returns it in the same shape the app already consumes
// (users/admins/clients/goals/... ), so the client-side rendering code barely
// changes. The response is filtered by the caller's ROLE, taken from the
// signed session token (never trusted from the request body/query) — a
// member never receives payroll fields, admin accounts, business settings,
// org chart, roadmap, or summaries data, even if the browser asked for it.

import { getSupabaseAdmin } from '../lib/supabaseAdmin.js';
import { requireSession } from '../lib/opsSession.js';

function rows(data) { return (data || []).map(r => ({ id: r.id, ...r.data })); }

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  let session;
  try { session = requireSession(req); }
  catch (err) { return res.status(500).json({ error: err.message }); }
  if (!session) return res.status(401).json({ error: 'Missing or invalid session' });

  const isAdmin = session.role === 'admin';
  let supabase;
  try { supabase = getSupabaseAdmin(); }
  catch (err) { return res.status(500).json({ error: err.message }); }

  try {
    const [
      usersQ, adminsQ, clientsQ, goalsQ, feedQ, messagesQ, roadmapQ,
      timeOffReqQ, timeOffLedgerQ, summariesQ, settingsQ, deletedQ,
      orgNodesQ, orgLinksQ,
    ] = await Promise.all([
      supabase.from('ops_users').select('id, data'),
      supabase.from('ops_admins').select('id, data'),
      supabase.from('ops_clients').select('id, status, data'),
      supabase.from('ops_goals').select('id, data'),
      supabase.from('ops_feed').select('id, data').order('created_at', { ascending: false }).limit(300),
      supabase.from('ops_messages').select('id, data'),
      supabase.from('ops_roadmap_tasks').select('id, data'),
      supabase.from('ops_time_off_requests').select('id, data'),
      supabase.from('ops_time_off_ledger').select('id, data'),
      supabase.from('ops_summaries').select('client_id, kind, period_key, data'),
      supabase.from('ops_settings').select('key, data'),
      supabase.from('ops_deleted_user_ids').select('user_id'),
      supabase.from('ops_org_nodes').select('id, data'),
      supabase.from('ops_org_links').select('id, data'),
    ]);

    const err = [usersQ, adminsQ, clientsQ, goalsQ, feedQ, messagesQ, roadmapQ, timeOffReqQ, timeOffLedgerQ, summariesQ, settingsQ, deletedQ, orgNodesQ, orgLinksQ].find(q => q.error)?.error;
    if (err) return res.status(500).json({ error: err.message });

    const deletedIds = new Set((deletedQ.data || []).map(r => r.user_id));
    const settingsMap = {};
    (settingsQ.data || []).forEach(r => { settingsMap[r.key] = r.data; });

    let users = rows(usersQ.data).filter(u => !deletedIds.has(u.id));
    let admins = rows(adminsQ.data);
    const clients = (clientsQ.data || []).map(r => ({ id: r.id, status: r.status, ...r.data }));
    let goals = rows(goalsQ.data);
    let feed = rows(feedQ.data);
    let messages = rows(messagesQ.data);
    let roadmapTasks = rows(roadmapQ.data);
    let timeOffRequests = rows(timeOffReqQ.data);
    let timeOffLedger = rows(timeOffLedgerQ.data);
    let summaries = (summariesQ.data || []).map(r => ({ clientId: r.client_id, kind: r.kind, periodKey: r.period_key, ...r.data }));
    let orgNodes = rows(orgNodesQ.data);
    let orgLinks = rows(orgLinksQ.data);

    const record = {
      users, admins, clients, goals, feed, messages, roadmapTasks,
      timeOffRequests, timeOffLedger, summaries,
      deletedUserIds: [...deletedIds],
      announcement: settingsMap.announcement ?? null,
      coc: settingsMap.coc ?? null,
      settings: settingsMap.appSettings ?? null,
      otPolicy: settingsMap.otPolicy ?? null,
      orgNodes, orgLinks,
      orgExcluded: settingsMap.orgExcluded ?? '[]',
      orgLayoutVersion: settingsMap.orgLayoutVersion ?? null,
      primaryAdminPw: settingsMap.primaryAdminPw ?? null,
    };

    if (!isAdmin) {
      // Members: strip payroll fields, admin accounts, business settings, org
      // chart, roadmap, and summaries. Time-off is scoped to their own records.
      record.users = record.users.map(u => { const { payRate, hours, ...rest } = u; return rest; });
      record.admins = record.admins.map(a => ({ id: a.id, name: a.name, title: a.title }));
      record.roadmapTasks = [];
      record.summaries = [];
      record.timeOffRequests = record.timeOffRequests.filter(r => r.userId === session.id);
      record.timeOffLedger = record.timeOffLedger.filter(r => r.userId === session.id);
      record.deletedUserIds = [];
      record.orgNodes = [];
      record.orgLinks = [];
      record.coc = null;
      record.settings = null;
      record.otPolicy = null;
      record.orgExcluded = '[]';
      record.orgLayoutVersion = null;
      record.primaryAdminPw = null;
      // announcement, goals, feed, messages, clients stay visible to everyone.
    }

    return res.status(200).json({ record });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Failed to read state' });
  }
}
