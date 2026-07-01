// Verifies login credentials against Supabase and issues a signed session
// token (see lib/opsSession.js). Passwords are checked exactly as they are
// stored today (plaintext) — this migration does NOT change login or hash
// anything; that is a separate, later follow-up. What's new is that the
// *role* the server will trust for /api/ops-sync comes from this signed
// token, not from anything the browser can edit.

import { getSupabaseAdmin } from '../lib/supabaseAdmin.js';
import { signSession } from '../lib/opsSession.js';

const PRIMARY_ADMIN_EMAIL = 'ssamy@weblightmedia.com';
const PRIMARY_ADMIN_DEFAULT_PW = '1234567';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email and password are required' });
  const normEmail = String(email).trim().toLowerCase();

  let supabase;
  try { supabase = getSupabaseAdmin(); }
  catch (err) { return res.status(500).json({ error: err.message }); }

  try {
    // ── Hardcoded primary admin (parity with the app's existing behavior) ──
    const { data: pwRow } = await supabase.from('ops_settings').select('data').eq('key', 'primaryAdminPw').maybeSingle();
    const primaryPw = (pwRow && pwRow.data) || PRIMARY_ADMIN_DEFAULT_PW;
    if (normEmail === PRIMARY_ADMIN_EMAIL && password === primaryPw) {
      const token = signSession({ id: 'primary-admin', role: 'admin', level: 'owner', name: 'Sarah Samy', email: PRIMARY_ADMIN_EMAIL });
      return res.status(200).json({ token, role: 'admin', level: 'owner', id: 'primary-admin', name: 'Sarah Samy', email: PRIMARY_ADMIN_EMAIL });
    }

    // ── Dynamic admins ──
    const { data: admins } = await supabase.from('ops_admins').select('id, data');
    const adminRow = (admins || []).find(a => (a.data?.email || '').toLowerCase() === normEmail && a.data?.password === password);
    if (adminRow) {
      const a = adminRow.data;
      const token = signSession({ id: adminRow.id, role: 'admin', level: a.level || 'admin', name: a.name, email: a.email });
      return res.status(200).json({ token, role: 'admin', level: a.level || 'admin', id: adminRow.id, name: a.name, email: a.email, title: a.title });
    }

    // ── Team members ──
    const { data: deletedRows } = await supabase.from('ops_deleted_user_ids').select('user_id');
    const deletedIds = new Set((deletedRows || []).map(r => r.user_id));
    const { data: users } = await supabase.from('ops_users').select('id, data');
    const userRow = (users || []).find(u => !deletedIds.has(u.id) && (u.data?.email || '').toLowerCase() === normEmail && u.data?.password === password);
    if (userRow) {
      const u = userRow.data;
      const token = signSession({ id: userRow.id, role: 'member', name: u.name, email: u.email });
      return res.status(200).json({ token, role: 'member', id: userRow.id, name: u.name, email: u.email, title: u.title, mustChangePassword: !!u.mustChangePassword });
    }

    return res.status(401).json({ error: 'Invalid email or password' });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Login failed' });
  }
}
