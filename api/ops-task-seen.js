// Per-user "I've seen this task" acknowledgement — the only writer of
// ops_task_seen, modeled directly on api/session-ping.js: capture-only, same
// shape, never touches any app-data table, never participates in
// cloudPushAll/dirty-sync, and a failure here must never become a failure
// anywhere else in the app (every caller is a fire-and-forget client-side
// POST — "a dropped acknowledgement is fine," see user.html's own call site).
//
// user_id comes from the verified session token, never from the request
// body — the browser cannot mark a task "seen" for anyone but itself.
import { getSupabaseAdmin } from '../lib/supabaseAdmin.js';
import { requireSession } from '../lib/opsSession.js';
import { logError } from '../lib/errorLog.js';

const TABLE = 'ops_task_seen';
const MAX_IDS_PER_CALL = 500;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let session;
  try { session = await requireSession(req); }
  catch (err) { await logError({ endpoint: 'ops-task-seen', error: err }); return res.status(500).json({ error: err.message }); }
  if (!session) return res.status(401).json({ error: 'Missing or invalid session' });

  const taskIds = Array.isArray(req.body?.taskIds)
    ? req.body.taskIds.filter(id => typeof id === 'string' && id).slice(0, MAX_IDS_PER_CALL)
    : [];
  if (!taskIds.length) return res.status(400).json({ error: 'taskIds must be a non-empty array of strings' });

  // Everything past this point is best-effort: a broken DB/Supabase config
  // must never surface as a broken app to whichever page just called this
  // on a task-open or a "Mark all as seen" click — swallow, log, respond 204
  // exactly as if the write had succeeded (same convention as
  // api/session-ping.js).
  try {
    const supabase = getSupabaseAdmin();
    const rows = taskIds.map(task_id => ({ user_id: session.id, task_id }));
    // ignoreDuplicates -> a genuine INSERT ... ON CONFLICT DO NOTHING, never
    // an UPDATE — this is what keeps a repeat ack idempotent without ever
    // tripping the ops_block_mutations() trigger (before update or delete).
    const { error } = await supabase
      .from(TABLE)
      .upsert(rows, { onConflict: 'user_id,task_id', ignoreDuplicates: true });
    if (error) await logError({ endpoint: 'ops-task-seen', error, session });
  } catch (err) {
    await logError({ endpoint: 'ops-task-seen', error: err, session });
  }
  return res.status(204).end();
}
