// Replaces GET /api/cloud-data. Assembles the shared record from the ops_*
// Supabase tables and returns it in the same shape the app already consumes
// (users/admins/clients/goals/... ), so the client-side rendering code barely
// changes. The response is filtered by the caller's TIER (see
// lib/opsSession.js tierOf()), taken from the signed session token (never
// trusted from the request body/query):
//   - 'super' (Super Admin/CEO — super/owner levels): sees everything,
//     including payroll/pay rates, admin accounts, business settings, org
//     chart, and roadmap.
//   - 'manager' (every other admin level): team + client management —
//     users/admins minus payroll fields, all time-off requests, summaries,
//     archive/tombstones — but NOT payroll ledger, NOT business
//     settings/org chart/roadmap.
//   - 'member': clients (read-only visibility), own time-off only, minimal
//     user/admin fields for display, nothing else.
import { getSupabaseAdmin } from '../lib/supabaseAdmin.js';
import { requireSession, tierOf } from '../lib/opsSession.js';
import { logError } from '../lib/errorLog.js';

function rows(data) { return (data || []).map(r => ({ id: r.id, ...r.data })); }

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  let session;
  try { session = requireSession(req); }
  catch (err) { await logError({ endpoint: 'ops-state', error: err }); return res.status(500).json({ error: err.message }); }
  if (!session) return res.status(401).json({ error: 'Missing or invalid session' });

  const tier = tierOf(session); // 'super' | 'manager' | 'member'
  let supabase;
  try { supabase = getSupabaseAdmin(); }
  catch (err) { await logError({ endpoint: 'ops-state', error: err, session }); return res.status(500).json({ error: err.message }); }

  try {
    const [
      usersQ, adminsQ, clientsQ, goalsQ, feedQ, messagesQ, roadmapQ,
      timeOffReqQ, timeOffLedgerQ, summariesQ, settingsQ, deletedQ,
      orgNodesQ, orgLinksQ, catalogSuggestionsQ, notificationsQ,
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
      supabase.from('ops_catalog_suggestions').select('id, data').is('deleted_at', null),
      supabase.from('ops_notifications').select('id, data').order('created_at', { ascending: false }).limit(200),
    ]);

    const err = [usersQ, adminsQ, clientsQ, goalsQ, feedQ, messagesQ, roadmapQ, timeOffReqQ, timeOffLedgerQ, summariesQ, settingsQ, deletedQ, orgNodesQ, orgLinksQ, catalogSuggestionsQ, notificationsQ].find(q => q.error)?.error;
    if (err) { await logError({ endpoint: 'ops-state', error: err, session }); return res.status(500).json({ error: err.message }); }

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
    let catalogSuggestions = rows(catalogSuggestionsQ.data);
    // Notifications are inherently personal — scoped to the caller's own id
    // regardless of tier (unlike every other field below, which is scoped by
    // tier). A super admin does not see anyone else's notifications either.
    let notifications = rows(notificationsQ.data).filter(n => n.recipientId === session.id);

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
      // Service Catalog: visible to every tier (members need it to see options
      // and submit suggestions), unlike the other settings keys below.
      serviceCatalog: settingsMap.serviceCatalog ?? null,
      catalogSuggestions,
      notifications,
      // Notification on/off toggles: same Super Admin/CEO-only visibility as
      // otPolicy/coc below — everyone still GETS notified server-side
      // regardless (the toggle is read directly from ops_settings inside
      // api/ops-sync.js, not from this tier-filtered response), this only
      // controls who can see/change the toggle in the Settings UI.
      notificationSettings: settingsMap.notificationSettings ?? { assignment: true, timeOff: true, message: true },
    };

    // Payroll/pay-rate fields: Super Admin/CEO only, for every non-super caller.
    if (tier !== 'super') {
      record.users = record.users.map(u => { const { payRate, hours, ...rest } = u; return rest; });
    }

    if (tier === 'member') {
      // Members: minimal admin/user display fields only. Time-off is scoped to
      // their own records — matched by userName (time-off requests) / employeeId
      // (ledger entries), the actual fields the app writes (see
      // user.html submitTimeOffRequest() / index.html logTimeOffEntry()) — NOT
      // userId, which never exists on either record shape.
      record.admins = record.admins.map(a => ({ id: a.id, name: a.name, title: a.title }));
      record.roadmapTasks = [];
      record.summaries = [];
      const myName = String(session.name || '').toLowerCase();
      record.timeOffRequests = record.timeOffRequests.filter(r => String(r.userName || '').toLowerCase() === myName);
      record.timeOffLedger = record.timeOffLedger.filter(r => r.employeeId === session.id);
      record.deletedUserIds = [];
      record.orgNodes = [];
      record.orgLinks = [];
      record.coc = null;
      record.settings = null;
      record.otPolicy = null;
      record.orgExcluded = '[]';
      record.orgLayoutVersion = null;
      record.primaryAdminPw = null;
      record.notificationSettings = null;
      // announcement, goals, feed, messages, clients, notifications stay visible to everyone.
    } else if (tier === 'manager') {
      // Every other admin level: team + client management (users minus payroll
      // already applied above, all time-off requests, summaries, archive), but
      // NOT the payroll ledger and NOT business settings/org chart/roadmap —
      // those stay Super Admin/CEO exclusive.
      record.admins = record.admins.map(a => ({ id: a.id, name: a.name, title: a.title, level: a.level, status: a.status }));
      record.roadmapTasks = [];
      record.timeOffLedger = [];
      record.orgNodes = [];
      record.orgLinks = [];
      record.coc = null;
      record.settings = null;
      record.otPolicy = null;
      record.orgExcluded = '[]';
      record.orgLayoutVersion = null;
      record.primaryAdminPw = null;
      record.notificationSettings = null;
      // deletedUserIds, timeOffRequests, summaries stay full — team/client management.
    }
    // tier === 'super': record is returned exactly as assembled above.

    return res.status(200).json({ record });
  } catch (err) {
    await logError({ endpoint: 'ops-state', error: err, session });
    return res.status(500).json({ error: err.message || 'Failed to read state' });
  }
}
