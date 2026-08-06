// Session-activity capture — the only writer of ops_session_activity, the
// raw signal a later PR turns into "time in app" per person. Capture-only,
// same shape as lib/errorLog.js: never touches any app-data table, never
// participates in cloudPushAll/dirty-sync, and a failure here must never
// become a failure anywhere else in the app (every caller is a fire-and-
// forget client-side ping — "a dropped ping is fine").
//
// user_id/user_name/user_role come from the verified session token, never
// from the request body — the browser cannot claim to be someone else's
// activity.
import { getSupabaseAdmin } from '../lib/supabaseAdmin.js';
import { requireSession } from '../lib/opsSession.js';
import { logError } from '../lib/errorLog.js';

const TABLE = 'ops_session_activity';
const EVENTS = new Set(['start', 'heartbeat', 'end']);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let session;
  try { session = await requireSession(req); }
  catch (err) { await logError({ endpoint: 'session-ping', error: err }); return res.status(500).json({ error: err.message }); }
  if (!session) return res.status(401).json({ error: 'Missing or invalid session' });

  const { event, client_ts } = req.body || {};
  if (!EVENTS.has(event)) return res.status(400).json({ error: "event must be 'start', 'heartbeat', or 'end'" });

  // Everything past this point is best-effort: a broken DB/Supabase config
  // must never surface as a broken app to whichever portal just called this
  // on login, a 60s heartbeat tick, or unload — swallow, log, respond 204
  // exactly as if the write had succeeded.
  try {
    const supabase = getSupabaseAdmin();
    const id = `ping_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const clientTs = client_ts && !Number.isNaN(new Date(client_ts).getTime()) ? new Date(client_ts).toISOString() : null;
    const { error } = await supabase.from(TABLE).insert({
      id,
      user_id: session.id,
      user_name: session.name || null,
      user_role: session.role || null,
      event,
      client_ts: clientTs,
    });
    if (error) await logError({ endpoint: 'session-ping', error, session });
  } catch (err) {
    await logError({ endpoint: 'session-ping', error: err, session });
  }
  return res.status(204).end();
}
