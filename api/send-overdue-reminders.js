// Emails each active owner their own list of OVERDUE services via Resend, on
// demand (a super-admin clicks "Email overdue owners" in the Overview). One
// email per person, auto-generated from live data — nobody types the lists by
// hand. Inactive people (e.g. a departed employee) are never emailed; their
// items are reported back so they can be reassigned instead.
//
// Triggered only by an explicit button click with a signed super-admin
// session — never a cron/load-time send. No data writes: this is a read +
// send only.

import { buildEmailHtml, sendResendEmail } from '../lib/resendClient.js';
import { logError } from '../lib/errorLog.js';
import { requireSession, tierOf } from '../lib/opsSession.js';
import { getSupabaseAdmin } from '../lib/supabaseAdmin.js';

const SKIP_FREQ = new Set(['per-request', 'one-time']);

function todayStr() { return new Date().toISOString().slice(0, 10); }
function fmtDue(d) {
  try { return new Date(d + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }); }
  catch (e) { return String(d); }
}

// Overdue = active service on an active client with a real recurring due date
// in the past. Mirrors _chSvcDueStatus()/_chIsDoneThisCycle() in index.html:
// a past due date is overdue regardless of lastDone (the "done but not rolled
// forward" case the Hub itself surfaces) — except per-request/one-time, which
// carry no meaningful cadence, and a service that is itself inactive/archived.
export function isOverdueService(s, t) {
  if (!s || typeof s !== 'object') return false;
  const status = s.status || 'active';
  if (status === 'inactive' || status === 'archived') return false;
  if (!s.due) return false;
  if (SKIP_FREQ.has(s.freq || '')) return false;
  return String(s.due) < t;
}

export function collectServices(c) {
  const out = [];
  const add = (arr) => { if (Array.isArray(arr)) arr.forEach(s => { if (s && typeof s === 'object') out.push(s); }); };
  add(c.services); add(c.recurringServices);
  if (Array.isArray(c.locations)) c.locations.forEach(loc => add(loc && loc.services));
  return out;
}

// Pure, testable: build the per-owner overdue map from roster + clients.
export function buildOverdueByOwner({ users, admins, clients, today }) {
  const byId = new Map();
  const nameSeen = new Map(); // lowercased unique name -> id (null if ambiguous)
  [...(users || []), ...(admins || [])].forEach(row => {
    const d = row.data || {};
    byId.set(row.id, { id: row.id, name: d.name || '', email: d.email || '', status: d.status || 'active' });
    const k = (d.name || '').trim().toLowerCase();
    if (k) { if (nameSeen.has(k)) nameSeen.set(k, null); else nameSeen.set(k, row.id); }
  });

  const owners = new Map(); // key -> {name,email,status,items}
  (clients || []).forEach(row => {
    const c = row.data || {};
    if ((c.status || '') !== 'active') return;
    const clientName = c.name || '(unnamed client)';
    collectServices(c).forEach(s => {
      if (!isOverdueService(s, today)) return;
      let id = s.assigneeId || null;
      let rec = id ? byId.get(id) : null;
      if (!rec && s.assigneeName) {
        const nid = nameSeen.get(String(s.assigneeName).trim().toLowerCase());
        if (nid) { id = nid; rec = byId.get(nid); }
      }
      const key = id || ('name:' + String(s.assigneeName || '').toLowerCase());
      if (!owners.has(key)) owners.set(key, {
        name: (rec && rec.name) || s.assigneeName || '(unassigned)',
        email: (rec && rec.email) || '',
        status: (rec && rec.status) || 'unknown',
        items: [],
      });
      owners.get(key).items.push({
        client: clientName,
        service: s.name || '(service)',
        due: s.due,
        notStarted: (s.workStatus === 'not_started' || !s.workStatus),
      });
    });
  });
  // stable order: most overdue first
  owners.forEach(o => o.items.sort((a, b) => String(a.due).localeCompare(String(b.due))));
  return owners;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let session;
  try { session = await requireSession(req); }
  catch (err) { await logError({ endpoint: 'send-overdue-reminders', error: err }); return res.status(500).json({ error: err.message }); }
  if (!session) return res.status(401).json({ error: 'Missing or invalid session' });
  if (tierOf(session) !== 'super') return res.status(403).json({ error: 'Super admin only' });
  if (!process.env.RESEND_API_KEY) return res.status(500).json({ error: 'RESEND_API_KEY is not configured on the server.' });

  const dryRun = !!(req.body && req.body.dryRun);
  const supabase = getSupabaseAdmin();
  const today = todayStr();

  const usersRes = await supabase.from('ops_users').select('id, data');
  const adminsRes = await supabase.from('ops_admins').select('id, data');
  const clientsRes = await supabase.from('ops_clients').select('id, data');
  if (usersRes.error || adminsRes.error || clientsRes.error) {
    await logError({ endpoint: 'send-overdue-reminders', error: usersRes.error || adminsRes.error || clientsRes.error });
    return res.status(500).json({ error: 'Failed to load data' });
  }

  const owners = buildOverdueByOwner({ users: usersRes.data, admins: adminsRes.data, clients: clientsRes.data, today });

  const results = [];
  for (const [, o] of owners) {
    const base = { owner: o.name, count: o.items.length };
    if (o.status === 'inactive') { results.push({ ...base, status: 'skipped_inactive' }); continue; }
    if (!o.email || !o.email.includes('@')) { results.push({ ...base, status: 'skipped_no_email' }); continue; }
    if (dryRun) { results.push({ ...base, status: 'would_send', email: o.email }); continue; }

    const lines = o.items.map(it => `• ${it.client} — ${it.service} — due ${fmtDue(it.due)}${it.notStarted ? ' — NOT STARTED' : ''}`).join('\n');
    const body = `The Ops Hub shows these services on your plate as overdue as of ${fmtDue(today)}. Please open each in the Hub and either mark the current cycle done and set the next due date, or flag it if you're blocked. If a service is already done, just update its due date so it stops showing overdue.\n\n${lines}`;
    const html = buildEmailHtml({ name: o.name, title: 'Please review your overdue services', body });
    try {
      const r = await sendResendEmail({
        to: o.email,
        subject: 'URGENT: Please review your overdue services',
        html,
        type: 'overdueServicesReminder',
        headers: { 'X-Priority': '1', 'Importance': 'high' },
      });
      results.push({ ...base, status: (r && r.suppressed) ? 'suppressed' : 'sent', email: o.email });
    } catch (err) {
      await logError({ endpoint: 'send-overdue-reminders', error: err });
      results.push({ ...base, status: 'error', email: o.email, error: err.message });
    }
  }

  results.sort((a, b) => b.count - a.count);
  return res.status(200).json({
    ok: true,
    dryRun,
    today,
    summary: { owners: results.length, sent: results.filter(r => r.status === 'sent').length, wouldSend: results.filter(r => r.status === 'would_send').length },
    results,
  });
}
