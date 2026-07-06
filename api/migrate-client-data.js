// Client-data delete-and-replace migration (CSV restructuring project).
// Gated on a signed session token like every other ops-* endpoint, restricted
// to tier 'super' only — this is the highest-blast-radius operation in the
// app: it deletes every existing client and replaces them with a freshly
// mapped roster. Three actions, meant to be called in this exact order from
// the admin UI:
//
//   backup   — snapshot every current ops_clients row into ops_backups
//              (durable, server-side) AND return the same data so the
//              browser can also save it as a downloadable file. Read-only
//              against ops_clients.
//   dry-run  — body: { rows: [...] } (the parsed final CSV). Groups rows
//              into client records, validates each row's bundle against the
//              LIVE service catalog (ops_settings.serviceCatalog), and
//              reports counts + a full name diff + sample records. Writes
//              NOTHING. Returns a confirmToken bound to this exact row set
//              and the most recent backup, valid for 30 minutes.
//   commit   — body: { rows: [...], confirmToken, backupId }. Refuses to run
//              unless a backup with that id still exists and the token
//              matches a hash of these exact rows + that backup. Deletes
//              every ops_clients row, then inserts the newly built roster.
//              This is the only action that writes.
//
// No real client data lives in this file — the admin's browser uploads the
// CSV she was given and this endpoint only ever sees what's in the request
// body, same privacy model as api/import-legacy-data.js.

import crypto from 'crypto';
import { getSupabaseAdmin } from '../lib/supabaseAdmin.js';
import { requireSession, tierOf } from '../lib/opsSession.js';

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

// Groups flat CSV rows into full client records in the app's shape, and
// checks each row's declared bundle against the live catalog — a bundle
// name that doesn't exist in the live catalog is demoted to standalone
// (bundle:null) rather than rejected, and reported back for review.
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
      });
    }
    const client = byClient.get(clientName);
    const serviceName = String(r.service_name || '').trim();
    if (!serviceName) return;
    let bundle = String(r.bundle || '').trim() || null;
    if (bundle && liveCatalogBundleNames && !liveCatalogBundleNames.has(bundle)) {
      catalogMismatches.push({ row: i, client: clientName, service: serviceName, declaredBundle: bundle });
      bundle = null;
    }
    const freq = r.frequency === 'yearly' ? 'yearly' : 'monthly';
    const svc = {
      id: `svc_${slugify(clientName)}_${slugify(serviceName)}_${client.services.length}`,
      name: serviceName,
      bundle,
      freq,
      freqLabel: freqLabel(freq),
      assignee: '', assigneeName: '', assigneeId: '',
      lastDone: null, due: null, status: 'active',
      platforms: '', notes: '',
    };
    const franchiseLocation = String(r.franchise_location || '').trim();
    if (franchiseLocation) svc.franchiseLocation = franchiseLocation;
    client.services.push(svc);
  });

  return { clients: Array.from(byClient.values()), catalogMismatches };
}

function canonicalRowsString(rows) {
  // Stable stringify: same rows in the same order always hash the same way.
  return JSON.stringify(rows.map(r => [r.client_name, r.service_name, r.bundle, r.frequency, r.franchise_location]));
}

function makeToken(rows, backupId, expiresAt) {
  const secret = process.env.SESSION_SECRET;
  const payload = `${canonicalRowsString(rows)}|${backupId}|${expiresAt}`;
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${expiresAt}.${sig}`;
}

function verifyToken(token, rows, backupId) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return { ok: false, reason: 'malformed token' };
  const [expiresAtStr] = token.split('.');
  const expiresAt = Number(expiresAtStr);
  if (!expiresAt || Date.now() > expiresAt) return { ok: false, reason: 'token expired — run the dry run again' };
  const expected = makeToken(rows, backupId, expiresAt);
  if (expected !== token) return { ok: false, reason: 'token does not match these rows/backup — run the dry run again' };
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
  catch (err) { return res.status(500).json({ error: err.message }); }
  if (!session) return res.status(401).json({ error: 'Missing or invalid session' });
  if (tierOf(session) !== 'super') {
    return res.status(403).json({ error: 'Super Admin/Owner only' });
  }

  const { action } = req.body || {};
  let supabase;
  try { supabase = getSupabaseAdmin(); }
  catch (err) { return res.status(500).json({ error: err.message }); }

  if (action === 'backup') {
    const { data: rows, error } = await supabase.from('ops_clients').select('id, status, data');
    if (error) return res.status(500).json({ error: `Failed to read ops_clients: ${error.message}` });
    const backupId = `clients_backup_${Date.now()}`;
    const snapshot = (rows || []).map(r => ({ id: r.id, status: r.status, ...r.data }));
    const { error: insErr } = await supabase.from('ops_backups').insert({
      id: backupId, kind: 'ops_clients_pre_migration', data: snapshot,
    });
    if (insErr) return res.status(500).json({ error: `Backup write failed — nothing else will proceed without this: ${insErr.message}` });
    return res.status(200).json({ ok: true, backupId, count: snapshot.length, clients: snapshot });
  }

  if (action === 'dry-run') {
    const { rows } = req.body || {};
    if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: '"rows" must be a non-empty array' });

    const { data: catalogRow } = await supabase.from('ops_settings').select('data').eq('key', 'serviceCatalog').maybeSingle();
    const liveBundles = catalogRow?.data?.bundles;
    const liveCatalogBundleNames = Array.isArray(liveBundles) ? new Set(liveBundles.map(b => b.name)) : null;

    const { clients: newClients, catalogMismatches } = buildClientsFromRows(rows, liveCatalogBundleNames);

    const { data: currentRows, error } = await supabase.from('ops_clients').select('id, data');
    if (error) return res.status(500).json({ error: `Failed to read current ops_clients: ${error.message}` });
    const currentNames = (currentRows || []).map(r => r?.data?.name || r.id);

    const { data: latestBackup } = await supabase
      .from('ops_backups').select('id, created_at').eq('kind', 'ops_clients_pre_migration')
      .order('created_at', { ascending: false }).limit(1).maybeSingle();

    const expiresAt = Date.now() + TOKEN_TTL_MS;
    const confirmToken = latestBackup ? makeToken(rows, latestBackup.id, expiresAt) : null;

    return res.status(200).json({
      ok: true, dryRun: true,
      clientsToDelete: currentNames.length,
      clientsToDeleteNames: currentNames,
      clientsToInsert: newClients.length,
      clientsToInsertNames: newClients.map(c => c.name),
      totalServiceRows: rows.length,
      sampleClients: newClients.slice(0, 5),
      catalogMismatches,
      liveCatalogFound: !!liveCatalogBundleNames,
      backupId: latestBackup ? latestBackup.id : null,
      backupAge: latestBackup ? Date.now() - new Date(latestBackup.created_at).getTime() : null,
      confirmToken,
      confirmTokenExpiresAt: latestBackup ? expiresAt : null,
      warning: latestBackup ? null : 'No backup found yet — run the Backup step before Confirm will be allowed.',
    });
  }

  if (action === 'commit') {
    const { rows, confirmToken, backupId } = req.body || {};
    if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: '"rows" must be a non-empty array' });
    if (!backupId) return res.status(400).json({ error: 'Missing backupId — run Backup and Dry Run first.' });

    const { data: backupRow, error: backupErr } = await supabase.from('ops_backups').select('id').eq('id', backupId).eq('kind', 'ops_clients_pre_migration').maybeSingle();
    if (backupErr) return res.status(500).json({ error: `Could not verify backup: ${backupErr.message}` });
    if (!backupRow) return res.status(403).json({ error: 'That backup no longer exists — run Backup and Dry Run again before confirming.' });

    const check = verifyToken(confirmToken, rows, backupId);
    if (!check.ok) return res.status(403).json({ error: `Refusing to write: ${check.reason}` });

    const { data: catalogRow } = await supabase.from('ops_settings').select('data').eq('key', 'serviceCatalog').maybeSingle();
    const liveBundles = catalogRow?.data?.bundles;
    const liveCatalogBundleNames = Array.isArray(liveBundles) ? new Set(liveBundles.map(b => b.name)) : null;
    const { clients: newClients } = buildClientsFromRows(rows, liveCatalogBundleNames);

    const { data: existingRows, error: fetchErr } = await supabase.from('ops_clients').select('id');
    if (fetchErr) return res.status(500).json({ error: `Failed to read current ops_clients before delete: ${fetchErr.message}` });
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

    const { count: finalCount } = await supabase.from('ops_clients').select('id', { count: 'exact', head: true });

    return res.status(200).json({
      ok: deleteErrors.length === 0 && insertErrors.length === 0,
      deleted, inserted, deleteErrors, insertErrors,
      countBefore: existingIds.length, countAfter: finalCount,
      backupIdUsed: backupId,
    });
  }

  return res.status(400).json({ error: `Unknown action "${action}" — expected "backup", "dry-run", or "commit".` });
}
