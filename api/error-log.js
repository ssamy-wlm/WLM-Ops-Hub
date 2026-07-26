// Read-only fetch for the admin-only error log viewer (Business Setup tab).
// Super Admin/CEO only — same tier gate as business settings/org chart/roadmap.
// This endpoint only ever reads ops_error_log; nothing here writes or deletes,
// matching the append-only, read-only-by-design capture in lib/errorLog.js.
import { getSupabaseAdmin } from '../lib/supabaseAdmin.js';
import { requireSession, tierOf } from '../lib/opsSession.js';
import { logError } from '../lib/errorLog.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  let session;
  try { session = await requireSession(req); }
  catch (err) { await logError({ endpoint: 'error-log', error: err }); return res.status(500).json({ error: err.message }); }
  if (!session) return res.status(401).json({ error: 'Missing or invalid session' });
  if (tierOf(session) !== 'super') return res.status(403).json({ error: 'Super Admin/Owner only' });

  let supabase;
  try { supabase = getSupabaseAdmin(); }
  catch (err) { await logError({ endpoint: 'error-log', error: err, session }); return res.status(500).json({ error: err.message }); }

  try {
    const { data, error } = await supabase
      .from('ops_error_log')
      .select('id, data, created_at')
      .order('created_at', { ascending: false })
      .limit(100);
    if (error) { await logError({ endpoint: 'error-log', error, session }); return res.status(500).json({ error: error.message }); }

    const entries = (data || []).map(r => ({ id: r.id, createdAt: r.created_at, ...r.data }));
    return res.status(200).json({ entries });
  } catch (err) {
    await logError({ endpoint: 'error-log', error: err, session });
    return res.status(500).json({ error: err.message || 'Failed to read error log' });
  }
}
