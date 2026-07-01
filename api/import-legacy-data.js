// One-time bulk client importer (Phase 5 data recovery). Requires
// MIGRATION_SECRET (same env var /api/migrate-schema.js uses — set it in
// Vercel env vars; this endpoint refuses to run without it, fail closed).
//
// Body: { clients: [...], dryRun?: boolean }
// Each entry in `clients` is a full client record in the app's shape (id,
// name, status, services/recurringServices, notes, etc.) — this endpoint
// takes no client data of its own, so nothing about real clients ever lives
// in this file or in git.
//
// Safety model: INSERT ONLY, never UPDATE, never DELETE. A client already in
// ops_clients — matched by normalized name, not by the incoming id, since a
// prior import or manual entry may have used a different id for the same
// business — is left completely untouched and reported as skipped. This is
// deliberately more conservative than /api/ops-sync's admin upsert path,
// because a bulk backfill has no business overwriting anything that's
// already there. Re-running with the same input is a no-op the second time.

import { getSupabaseAdmin } from '../lib/supabaseAdmin.js';

function normalizeName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function slugify(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function validClient(row) {
  return row && typeof row === 'object' && row.name && String(row.name).trim();
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-migration-secret');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const expectedSecret = process.env.MIGRATION_SECRET;
  if (!expectedSecret) {
    return res.status(500).json({ error: 'MIGRATION_SECRET is not configured on the server. Set it in Vercel env vars before using this endpoint.' });
  }
  const providedSecret = req.headers['x-migration-secret'];
  if (!providedSecret || providedSecret !== expectedSecret) {
    return res.status(403).json({ error: 'Invalid or missing x-migration-secret header' });
  }

  const { clients, dryRun } = req.body || {};
  if (!Array.isArray(clients) || !clients.length) {
    return res.status(400).json({ error: '"clients" must be a non-empty array' });
  }

  const invalid = [];
  const incoming = [];
  clients.forEach((c, i) => {
    if (validClient(c)) incoming.push(c);
    else invalid.push({ index: i, reason: 'missing/empty name' });
  });

  let supabase;
  try { supabase = getSupabaseAdmin(); }
  catch (err) { return res.status(500).json({ error: err.message }); }

  const { data: existingRows, error: fetchErr } = await supabase.from('ops_clients').select('id, data');
  if (fetchErr) return res.status(500).json({ error: `Failed to read existing clients: ${fetchErr.message}` });

  const existingNames = new Set((existingRows || []).map(r => normalizeName(r?.data?.name)));

  const toInsert = [];
  const skipped = [];
  const seenInBatch = new Set();
  for (const c of incoming) {
    const key = normalizeName(c.name);
    if (existingNames.has(key)) { skipped.push({ name: c.name, reason: 'already exists in ops_clients' }); continue; }
    if (seenInBatch.has(key)) { skipped.push({ name: c.name, reason: 'duplicate within this import batch' }); continue; }
    seenInBatch.add(key);
    const id = c.id || `c_${slugify(c.name)}`;
    toInsert.push({ id, status: c.status === 'inactive' ? 'inactive' : 'active', data: { ...c, id, status: c.status === 'inactive' ? 'inactive' : 'active' } });
  }

  if (dryRun) {
    return res.status(200).json({
      ok: true, dryRun: true,
      wouldInsert: toInsert.length,
      wouldSkip: skipped,
      invalid,
      currentCountInDb: existingRows.length,
      countAfterIfRun: existingRows.length + toInsert.length,
    });
  }

  let inserted = 0;
  const insertErrors = [];
  const BATCH = 50;
  for (let i = 0; i < toInsert.length; i += BATCH) {
    const batch = toInsert.slice(i, i + BATCH);
    const { error } = await supabase.from('ops_clients').insert(batch);
    if (error) insertErrors.push({ batchStart: i, error: error.message });
    else inserted += batch.length;
  }

  const { count: finalCount, error: countErr } = await supabase.from('ops_clients').select('id', { count: 'exact', head: true });

  return res.status(200).json({
    ok: insertErrors.length === 0,
    inserted,
    skipped,
    invalid,
    insertErrors,
    countBefore: existingRows.length,
    countAfter: countErr ? null : finalCount,
  });
}
