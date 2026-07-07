// Client-data delete-and-replace migration (CSV restructuring project).
// Gated on a signed session token like every other ops-* endpoint, restricted
// to tier 'super' only — this is the highest-blast-radius operation in the
// app: it deletes every existing client and replaces them with a freshly
// mapped roster. No backup step (explicit decision) — the dry run is the
// only safety net, so it reports everything: full delete/insert name lists,
// every service on the sample clients, any bundle that doesn't match the
// live catalog, and any client that would land with zero services. Two
// actions, called in this order from the admin UI:
//
//   dry-run  — body: { rows: [...] } (the parsed final CSV). Groups rows
//              into client records — a row with franchise_location set nests
//              under client.locations[] instead of the client's top-level
//              services — validates each row's bundle against the LIVE
//              service catalog (ops_settings.serviceCatalog), and reports
//              counts + a full name diff + every sample client's full
//              service list. Writes NOTHING. Returns a confirmToken bound to
//              this exact row set, valid for 30 minutes.
//   commit   — body: { rows: [...], confirmToken }. Refuses to run unless
//              the token matches a hash of these exact rows and hasn't
//              expired. Deletes every ops_clients row, then inserts the
//              newly built roster. This is the only action that writes.
//
// No real client data lives in this file — the admin's browser uploads the
// CSV she was given and this endpoint only ever sees what's in the request
// body, same privacy model as api/import-legacy-data.js.

import crypto from 'crypto';
import { getSupabaseAdmin } from '../lib/supabaseAdmin.js';
import { requireSession, tierOf } from '../lib/opsSession.js';
import { logError } from '../lib/errorLog.js';

const TOKEN_TTL_MS = 30 * 60 * 1000; // 30 minutes

function slugify(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function freqLabel(freq) {
  return freq === 'yearly' ? 'Yearly' : 'Monthly';
}

function validRow(r) {
  return r && typeof r === 'object' && r.client_name && String(r.client_name).trim();
}

function buildService(clientName, r, index, liveCatalogBundleNames, catalogMismatches, rowIndex) {
  const serviceName = String(r.service_name || '').trim();
  if (!serviceName) return null;
  let bundle = String(r.bundle || '').trim() || null;
  if (bundle && liveCatalogBundleNames && !liveCatalogBundleNames.has(bundle)) {
    catalogMismatches.push({ row: rowIndex, client: clientName, service: serviceName, declaredBundle: bundle });
    bundle = null;
  }
  const freq = r.frequency === 'yearly' ? 'yearly' : 'monthly';
  return {
    id: `svc_${slugify(clientName)}_${slugify(serviceName)}_${index}`,
    name: serviceName,
    bundle,
    freq,
    freqLabel: freqLabel(freq),
    assignee: '', assigneeName: '', assigneeId: '',
    lastDone: null, due: null, status: 'active',
    platforms: '', notes: '',
  };
}

// Groups flat CSV rows into full client records in the app's shape. A row
// with franchise_location set nests its service under client.locations[]
// (creating the franchise the first time it's seen) instead of the client's
// own top-level services — this is what makes Servpro land as one parent
// client with a nested "Yonkers" franchise rather than flat services tagged
// with a location name.
function buildClientsFromRows(rows, liveCatalogBundleNames) {
  const byClient = new Map();
  const catalogMismatches = [];

  rows.forEach((r, i) => {
    if (!validRow(r)) return;
    const clientName = String(r.client_name).trim();
    if (!byClient.has(clientName)) {
      byClient.set(clientName, {
        id: `c_${slugify(clientName)}`,
        name: clientName,
        status: 'active',
        services: [],
        locations: [],
      });
    }
    const client = byClient.get(clientName);
    const franchiseLocation = String(r.franchise_location || '').trim();

    if (franchiseLocation) {
      let loc = client.locations.find(l => l.name === franchiseLocation);
      if (!loc) {
        loc = { id: `loc_${slugify(clientName)}_${slugify(franchiseLocation)}`, name: franchiseLocation, services: [] };
        client.locations.push(loc);
      }
      const svc = buildService(clientName, r, loc.services.length, liveCatalogBundleNames, catalogMismatches, i);
      if (svc) loc.services.push(svc);
    } else {
      const svc = buildService(clientName, r, client.services.length, liveCatalogBundleNames, catalogMismatches, i);
      if (svc) client.services.push(svc);
    }
  });

  // Drop the empty locations[] array on clients that never had a franchise
  // row, so a plain client's shape stays exactly as it always has been.
  const clients = Array.from(byClient.values()).map(c => {
    if (!c.locations.length) { const { locations, ...rest } = c; return rest; }
    return c;
  });
  return { clients, catalogMismatches };
}

function totalServiceCount(client) {
  return (client.services?.length || 0) + (client.locations || []).reduce((n, l) => n + (l.services?.length || 0), 0);
}

function canonicalRowsString(rows) {
  // Stable stringify: same rows in the same order always hash the same way.
  return JSON.stringify(rows.map(r => [r.client_name, r.service_name, r.bundle, r.frequency, r.franchise_location]));
}

function makeToken(rows, expiresAt) {
  const secret = process.env.SESSION_SECRET;
  const sig = crypto.createHmac('sha256', secret).update(`${canonicalRowsString(rows)}|${expiresAt}`).digest('base64url');
  return `${expiresAt}.${sig}`;
}

function verifyToken(token, rows) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return { ok: false, reason: 'malformed token' };
  const [expiresAtStr] = token.split('.');
  const expiresAt = Number(expiresAtStr);
  if (!expiresAt || Date.now() > expiresAt) return { ok: false, reason: 'token expired — run the dry run again' };
  if (makeToken(rows, expiresAt) !== token) return { ok: false, reason: 'token does not match these rows — run the dry run again' };
  return { ok: true };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let session;
  try { session = requireSession(req); }
  catch (err) { await logError({ endpoint: 'migrate-client-data', error: err }); return res.status(500).json({ error: err.message }); }
  if (!session) return res.status(401).json({ error: 'Missing or invalid session' });
  if (tierOf(session) !== 'super') {
    return res.status(403).json({ error: 'Super Admin/Owner only' });
  }

  const { action } = req.body || {};
  let supabase;
  try { supabase = getSupabaseAdmin(); }
  catch (err) { await logError({ endpoint: 'migrate-client-data', error: err, session }); return res.status(500).json({ error: err.message }); }

  if (action === 'dry-run') {
    const { rows } = req.body || {};
    if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: '"rows" must be a non-empty array' });

    const { data: catalogRow } = await supabase.from('ops_settings').select('data').eq('key', 'serviceCatalog').maybeSingle();
    const liveBundles = catalogRow?.data?.bundles;
    const liveCatalogBundleNames = Array.isArray(liveBundles) ? new Set(liveBundles.map(b => b.name)) : null;

    const { clients: newClients, catalogMismatches } = buildClientsFromRows(rows, liveCatalogBundleNames);

    const { data: currentRows, error } = await supabase.from('ops_clients').select('id, data');
    if (error) { await logError({ endpoint: 'migrate-client-data', error, session, extra: { action: 'dry-run' } }); return res.status(500).json({ error: `Failed to read current ops_clients: ${error.message}` }); }
    const currentNames = (currentRows || []).map(r => r?.data?.name || r.id);

    const zeroServiceClients = newClients.filter(c => totalServiceCount(c) === 0).map(c => c.name);
    const expectedZeroService = new Set(['Coverli', 'JLN Contracting', 'WebLight Media']);
    const unexpectedZeroServiceClients = zeroServiceClients.filter(n => !expectedZeroService.has(n));

    const standaloneServices = [];
    newClients.forEach(c => {
      (c.services || []).forEach(s => { if (!s.bundle) standaloneServices.push({ client: c.name, service: s.name, freq: s.freq }); });
      (c.locations || []).forEach(loc => (loc.services || []).forEach(s => {
        if (!s.bundle) standaloneServices.push({ client: `${c.name} — ${loc.name}`, service: s.name, freq: s.freq });
      }));
    });

    const pick = (name) => newClients.find(c => c.name === name);
    const sampleClients = [
      pick('Ace Auto Body'), pick('Servpro'), pick('WORK_SPACE'),
      pick('Coverli'), pick('Leese Flooring Supplies Inc.'),
    ].filter(Boolean);

    const expiresAt = Date.now() + TOKEN_TTL_MS;
    const confirmToken = makeToken(rows, expiresAt);

    return res.status(200).json({
      ok: true, dryRun: true,
      clientsToDelete: currentNames.length,
      clientsToDeleteNames: currentNames,
      clientsToInsert: newClients.length,
      clientsToInsertNames: newClients.map(c => c.name),
      totalServiceRows: rows.length,
      sampleClients,
      catalogMismatches,
      liveCatalogFound: !!liveCatalogBundleNames,
      zeroServiceClients,
      unexpectedZeroServiceClients,
      standaloneServices,
      confirmToken,
      confirmTokenExpiresAt: expiresAt,
    });
  }

  if (action === 'commit') {
    const { rows, confirmToken } = req.body || {};
    if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: '"rows" must be a non-empty array' });

    const check = verifyToken(confirmToken, rows);
    if (!check.ok) return res.status(403).json({ error: `Refusing to write: ${check.reason}` });

    const { data: catalogRow } = await supabase.from('ops_settings').select('data').eq('key', 'serviceCatalog').maybeSingle();
    const liveBundles = catalogRow?.data?.bundles;
    const liveCatalogBundleNames = Array.isArray(liveBundles) ? new Set(liveBundles.map(b => b.name)) : null;
    const { clients: newClients } = buildClientsFromRows(rows, liveCatalogBundleNames);

    const { data: existingRows, error: fetchErr } = await supabase.from('ops_clients').select('id');
    if (fetchErr) { await logError({ endpoint: 'migrate-client-data', error: fetchErr, session, extra: { action: 'commit' } }); return res.status(500).json({ error: `Failed to read current ops_clients before delete: ${fetchErr.message}` }); }
    const existingIds = (existingRows || []).map(r => r.id);

    let deleted = 0;
    const deleteErrors = [];
    const DEL_BATCH = 100;
    for (let i = 0; i < existingIds.length; i += DEL_BATCH) {
      const batch = existingIds.slice(i, i + DEL_BATCH);
      const { error } = await supabase.from('ops_clients').delete().in('id', batch);
      if (error) deleteErrors.push({ batchStart: i, error: error.message });
      else deleted += batch.length;
    }

    const toInsert = newClients.map(c => ({ id: c.id, status: 'active', data: c }));
    let inserted = 0;
    const insertErrors = [];
    const INS_BATCH = 50;
    for (let i = 0; i < toInsert.length; i += INS_BATCH) {
      const batch = toInsert.slice(i, i + INS_BATCH);
      const { error } = await supabase.from('ops_clients').insert(batch);
      if (error) insertErrors.push({ batchStart: i, error: error.message });
      else inserted += batch.length;
    }

    if (deleteErrors.length || insertErrors.length) {
      await logError({ endpoint: 'migrate-client-data', error: `commit had ${deleteErrors.length} delete error(s) and ${insertErrors.length} insert error(s)`, session, extra: { deleteErrors, insertErrors } });
    }

    const { count: finalCount } = await supabase.from('ops_clients').select('id', { count: 'exact', head: true });

    return res.status(200).json({
      ok: deleteErrors.length === 0 && insertErrors.length === 0,
      deleted, inserted, deleteErrors, insertErrors,
      countBefore: existingIds.length, countAfter: finalCount,
    });
  }

  return res.status(400).json({ error: `Unknown action "${action}" — expected "dry-run" or "commit".` });
}
