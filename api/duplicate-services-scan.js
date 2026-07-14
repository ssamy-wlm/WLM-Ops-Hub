// Read-only scan for candidate duplicate active services across ops_clients
// (Business Setup tab, Super Admin/Owner only — same tier gate as the error
// log and schema-drift check). Never removes or changes anything — surfaces
// candidates for a human to review, because a same-name match is NOT always
// a real duplicate (see CLAUDE.md: CRN's two legitimate LinkedIn service
// instances would false-positive on name alone). Any actual removal is a
// separate, deliberate, dry-run/typed-confirmation-gated step per a specific
// reviewed list — same pattern as the earlier (now-removed)
// api/cleanup-duplicate-services.js, one batch at a time.
import { getSupabaseAdmin } from '../lib/supabaseAdmin.js';
import { requireSession, tierOf } from '../lib/opsSession.js';
import { logError } from '../lib/errorLog.js';

function isInactive(svc) {
  return svc.status === 'cancelled' || svc.status === 'archived';
}

// Same choke-point shape as client.html's _allClientServices(): every
// top-level and franchise-location service, tagged with which one it is.
function allServices(client) {
  const top = (client.services || []).map(s => ({ ...s, _locationId: '', _locationName: '' }));
  const fromLocs = (client.locations || []).flatMap(loc =>
    (loc.services || []).map(s => ({ ...s, _locationId: loc.id, _locationName: loc.name }))
  );
  return [...top, ...fromLocs];
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  let session;
  try { session = requireSession(req); }
  catch (err) { await logError({ endpoint: 'duplicate-services-scan', error: err }); return res.status(500).json({ error: err.message }); }
  if (!session) return res.status(401).json({ error: 'Missing or invalid session' });
  if (tierOf(session) !== 'super') return res.status(403).json({ error: 'Super Admin/Owner only' });

  let supabase;
  try { supabase = getSupabaseAdmin(); }
  catch (err) { await logError({ endpoint: 'duplicate-services-scan', error: err, session }); return res.status(500).json({ error: err.message }); }

  try {
    const { data: rows, error } = await supabase.from('ops_clients').select('id, status, data');
    if (error) throw error;

    const groups = new Map();
    for (const row of rows || []) {
      const client = { id: row.id, status: row.status, ...row.data };
      if (client.status === 'inactive') continue; // only active clients matter for this review
      const svcs = allServices(client).filter(s => !isInactive(s));
      for (const svc of svcs) {
        const matchKey = (svc.catalogId || (svc.name || '').trim().toLowerCase());
        const key = [row.id, svc._locationId, matchKey].join('::');
        if (!groups.has(key)) {
          groups.set(key, {
            clientId: row.id,
            clientName: client.name || row.id,
            locationId: svc._locationId || null,
            locationName: svc._locationName || null,
            services: [],
          });
        }
        groups.get(key).services.push({
          id: svc.id, name: svc.name || '', catalogId: svc.catalogId || null,
          freq: svc.freq || '', due: svc.due || '', lastDone: svc.lastDone || '',
          assigneeId: svc.assigneeId || null, assigneeName: svc.assigneeName || '',
          notes: svc.notes || '',
        });
      }
    }

    const candidates = [...groups.values()].filter(g => g.services.length > 1);
    return res.status(200).json({
      candidateCount: candidates.length,
      candidates,
      checkedAt: new Date().toISOString(),
    });
  } catch (err) {
    await logError({ endpoint: 'duplicate-services-scan', error: err, session });
    return res.status(500).json({ error: err.message || 'Duplicate service scan failed' });
  }
}
