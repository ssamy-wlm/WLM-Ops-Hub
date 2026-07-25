// Replaces GET /api/cloud-data. Assembles the shared record from the ops_*
// Supabase tables and returns it in the same shape the app already consumes
// (users/admins/clients/goals/... ), so the client-side rendering code barely
// changes. The response is filtered by the caller's TIER (see
// lib/opsSession.js tierOf()), taken from the signed session token (never
// trusted from the request body/query):
//   - 'super' (Super Admin/CEO — super/owner levels): sees everything,
//     including payroll/pay rates, admin accounts, business settings, org
//     chart, and roadmap.
//   - 'manager' (every other admin level): team + client management — full
//     user records, all time-off requests, summaries, archive/tombstones —
//     but NOT the payroll ledger, NOT business settings/org chart/roadmap.
//     Within this tier, the three specialized manager levels (creative/
//     production/account manager — see canEditUsers()) additionally get
//     other people's payRate/hours stripped from user records, and lose
//     payroll-save/time-off events from the Live Feed (see
//     stripSensitiveFeed()); plain 'admin' keeps the full access it
//     always had.
//   - 'member': clients (read-only visibility), own time-off only, minimal
//     user/admin fields for display, Live Feed with the same
//     payroll/time-off events stripped, nothing else.
import { getSupabaseAdmin } from '../lib/supabaseAdmin.js';
import { requireSession, tierOf, canEditUsers } from '../lib/opsSession.js';
import { logError } from '../lib/errorLog.js';
import { isHashed } from '../lib/passwordHash.js';

function rows(data) { return (data || []).map(r => ({ id: r.id, ...r.data })); }

// Live Feed entries are free-text (see logActivity() in index.html) — the
// sensitive ones aren't a separate field to strip, the entire event IS the
// sensitive content (e.g. a payroll save logs the literal dollar total as
// its "detail" string). 'admin' covers user/admin account CRUD and the
// payroll-save event; 'timeoff' covers individual time-off decisions/dates.
// Dropped entirely (not redacted) for member tier and the three restricted
// manager levels — 'admin' level and super/owner see the full feed.
const SENSITIVE_FEED_TYPES = new Set(['admin', 'timeoff']);
function stripSensitiveFeed(feed) {
  return (feed || []).filter(e => !SENSITIVE_FEED_TYPES.has(e.type));
}

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
      supabase.from('ops_org_nodes').select('id, data').is('deleted_at', null),
      supabase.from('ops_org_links').select('id, data').is('deleted_at', null),
      supabase.from('ops_catalog_suggestions').select('id, data').is('deleted_at', null),
      supabase.from('ops_notifications').select('id, data').order('created_at', { ascending: false }).limit(200),
    ]);

    // A single table's query failing (e.g. a column a newer deploy expects
    // but a pending migration hasn't been applied for yet — see CLAUDE.md's
    // ops_org_links.deleted_at outage) must never take down every OTHER
    // table, and above all must never block tier/session resolution — that
    // outage pinned every admin, including the primary admin, to the
    // fail-closed member/view-only default because the whole endpoint
    // 500'd over one missing column. Log the specific failure and degrade
    // just that one section to empty/absent; everything else — and
    // viewerTier/viewerLevel above, which don't depend on any of these
    // queries at all — still resolves normally. Every consumer of `.data`
    // below already falls back to `[]`/`{}` on null/undefined, so simply
    // clearing a failed query's `.data` is enough; nothing else changes.
    const namedQueries = [
      ['users', usersQ], ['admins', adminsQ], ['clients', clientsQ], ['goals', goalsQ],
      ['feed', feedQ], ['messages', messagesQ], ['roadmapTasks', roadmapQ],
      ['timeOffRequests', timeOffReqQ], ['timeOffLedger', timeOffLedgerQ], ['summaries', summariesQ],
      ['settings', settingsQ], ['deletedUserIds', deletedQ], ['orgNodes', orgNodesQ],
      ['orgLinks', orgLinksQ], ['catalogSuggestions', catalogSuggestionsQ], ['notifications', notificationsQ],
    ];
    for (const [table, q] of namedQueries) {
      if (q.error) {
        await logError({ endpoint: 'ops-state', error: q.error, session, extra: { table } });
        q.data = null;
      }
    }

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

    // Password-hash migration progress (Super Admin/CEO only, see rule #6 in
    // the migration plan) — a read-only count of accounts still on the
    // legacy plaintext path, computed from the RAW rows here, before
    // record.users strips the password field below. Never triggers or
    // performs any migration itself — every account only ever upgrades
    // lazily, on its own next successful login (see api/ops-auth.js).
    const pwValues = [...users.map(u => u.password), ...admins.map(a => a.password), settingsMap.primaryAdminPw]
      .filter(v => v !== undefined && v !== null && v !== '');
    const passwordMigrationStatus = {
      hashed: pwValues.filter(isHashed).length,
      legacy: pwValues.filter(v => !isHashed(v)).length,
      total: pwValues.length,
    };

    const record = {
      // Server-verified identity — the ONLY legitimate source of tier/role for
      // every frontend's UI gating. Never derive admin capability from a
      // client-cached session object (that's the whole bug this fixes): a
      // stale/leftover localStorage key from a different login on the same
      // browser must never grant anything. viewerLevel is the specific admin
      // level string (e.g. 'super', 'owner', 'creative_manager') and is only
      // ever present for admin-role sessions — always null for members, since
      // signSession() never puts a level on a member token.
      viewerTier: tier, // 'super' | 'manager' | 'member'
      viewerLevel: session.level ?? null,
      // Temporary diagnostic (added while investigating a report that the
      // primary admin sees view-only on the Tracker despite tierOf()
      // resolving her sentinel token to 'super' in every test we can
      // reproduce) — echoes the caller's OWN token id back, so the browser
      // console can show definitively whether a given session actually
      // resolved via the 'primary-admin' sentinel or via some other row.
      // Harmless to expose: it's only ever the caller's own identity, never
      // anyone else's. Remove once the discrepancy is resolved.
      viewerId: session.id ?? null,
      // Dual-mode account model (see CLAUDE.md, api/ops-auth.js): present
      // only when the signed session actually carries them — undefined on
      // the token becomes null here, exactly like viewerLevel above. Lets
      // each portal detect a dual-role account (both fields set) on every
      // load/reload, not just at the moment of a fresh login, so the mode
      // switcher control can stay correctly shown/hidden across sessions.
      viewerEmployeeId: session.employeeId ?? null,
      viewerAdminId: session.adminId ?? null,
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
      // Onboarding tour/tips flags: personal to the caller, same scoping as
      // notifications above — every tier, including the primary-admin
      // sentinel (which has no ops_users/ops_admins row), gets only its OWN
      // key back, never another user's. Stored under a per-user key in the
      // existing ops_settings table (see api/ops-sync.js) rather than a new
      // table or a field on a row that may not exist for every account.
      tourFlags: settingsMap['tourFlags_' + session.id] ?? { tourSeen: {}, dismissedTips: [] },
      // Notification on/off toggles: same Super Admin/CEO-only visibility as
      // otPolicy/coc below — everyone still GETS notified server-side
      // regardless (the toggle is read directly from ops_settings inside
      // api/ops-sync.js, not from this tier-filtered response), this only
      // controls who can see/change the toggle in the Settings UI.
      notificationSettings: settingsMap.notificationSettings ?? { assignment: true, timeOff: true, message: true, serviceUpdate: true },
      passwordMigrationStatus,
    };

    // Password (plaintext credential): never leave this endpoint, for any
    // tier — no admin UI ever needs it, and stripping it doesn't affect what
    // an admin can edit (saveEditUser() only ever sends a NEW password,
    // never round-trips the existing hash). mustChangePassword is NOT a
    // credential — it's the non-sensitive status flag the admin UI's
    // "awaiting first login" badge needs, so it stays in the response.
    record.users = record.users.map(u => { const { password, ...rest } = u; return rest; });

    // Payroll/pay-rate fields (payRate, hours): member tier ONLY — every
    // admin tier (manager and super) manages the team and needs to see and
    // edit these, not just literal Super Admin/CEO. This used to also strip
    // them for manager-tier admins, which meant a manager-tier admin's local
    // cache never had a real payRate to begin with — the confirmed root
    // cause of a real incident where saving an unrelated field on a user's
    // record silently zeroed their payRate (see saveEditUser() fix,
    // index.html). Applied to every OTHER user's record only, matching the
    // member-tier-safe-fields carve-out below for the caller's own record.
    if (tier === 'member') {
      // Members: minimal admin/user display fields only for every OTHER
      // person — this used to only apply to admins; the users table carried
      // near-full records (phone, emergencyContact, probationStart/End,
      // personalEmail, resumeUrl, adminNotes, and even platform `credentials`
      // — plaintext third-party logins) to every tier, for every teammate.
      // The caller's OWN record is left otherwise intact (minus the
      // credential fields already stripped above for everyone) — user.html's
      // Credentials tab and profile display legitimately need a person's own
      // phone/credentials/etc.; nobody else's business to see them, though.
      const MEMBER_SAFE_OTHER_USER_FIELDS = ['id', 'name', 'email', 'title', 'role', 'resp', 'status'];
      record.users = record.users.map(u => {
        if (u.id === session.id) return u;
        const safe = {};
        MEMBER_SAFE_OTHER_USER_FIELDS.forEach(f => { if (f in u) safe[f] = u[f]; });
        return safe;
      });
      // Time-off is scoped to their own records — matched by userName (time-off
      // requests) / employeeId (ledger entries), the actual fields the app
      // writes (see user.html submitTimeOffRequest() / index.html
      // logTimeOffEntry()) — NOT userId, which never exists on either record shape.
      record.admins = record.admins.map(a => ({ id: a.id, name: a.name, title: a.title }));
      record.roadmapTasks = [];
      record.summaries = [];
      const myName = String(session.name || '').toLowerCase();
      record.timeOffRequests = record.timeOffRequests.filter(r => String(r.userName || '').toLowerCase() === myName);
      record.timeOffLedger = record.timeOffLedger.filter(r => r.employeeId === session.id);
      record.deletedUserIds = [];
      // orgNodes/orgLinks: unlike everything else stripped in this branch,
      // this is intentionally NOT redacted for member tier — it's just a
      // diagram of names/titles/positions (see ORG_NODES_DEFAULT in
      // index.html), no sensitive fields at all, and the read-only Company
      // Overview chart in user.html needs the exact same data the admin
      // chart renders from. Members still have no write path to either
      // table — ops-sync.js gates admins/orgNodes/orgLinks writes to
      // tier==='super' regardless of what this read returns.
      record.coc = null;
      record.settings = null;
      record.otPolicy = null;
      record.orgExcluded = '[]';
      record.orgLayoutVersion = null;
      record.primaryAdminPw = null;
      record.notificationSettings = null;
      record.passwordMigrationStatus = null;
      // Payroll saves and time-off decisions are stripped out of the Live
      // Feed for members too — same leak, same fix (see the permission
      // project's Insights follow-up) — never gated by tier before this.
      record.feed = stripSensitiveFeed(record.feed);
      // announcement, goals, messages, clients, notifications stay visible to everyone.
    } else if (tier === 'manager') {
      // Every other admin level: team + client management (full user records,
      // all time-off requests, summaries, archive), but NOT the payroll
      // ledger and NOT business settings/org chart/roadmap — those stay
      // Super Admin/CEO exclusive.
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
      record.passwordMigrationStatus = null;
      // Creative/Production/Account Manager (canEditUsers()===false) also
      // lose visibility into OTHER people's payRate/hours — 'admin' keeps
      // the full read access it always had. The caller's own record is left
      // intact, same carve-out already used for member tier above. This is a
      // read-only transform of the in-memory response array — it never
      // writes anything back to ops_users, on purpose: an earlier stripping
      // pass here that also touched writes is what caused a real incident
      // where a user's payRate got silently zeroed (see saveEditUser() in
      // index.html) — this strips on OUTPUT only, every request, fresh.
      if (!canEditUsers(session)) {
        record.users = record.users.map(u => {
          if (u.id === session.id) return u;
          const { payRate, hours, ...rest } = u;
          return rest;
        });
        // Same Live Feed leak as member tier above — payroll saves and
        // time-off decisions dropped entirely for these three levels too.
        record.feed = stripSensitiveFeed(record.feed);
      }
      // deletedUserIds, timeOffRequests, summaries stay full — team/client management.
    }
    // tier === 'super': record is returned exactly as assembled above.

    return res.status(200).json({ record });
  } catch (err) {
    await logError({ endpoint: 'ops-state', error: err, session });
    return res.status(500).json({ error: err.message || 'Failed to read state' });
  }
}
