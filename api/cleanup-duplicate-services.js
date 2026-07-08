// One-time duplicate-service cleanup (approved plan, 2026-07-08 production
// read). Removes 5 confirmed-redundant service copies across 4 clients.
// Same dry-run/commit safety model as api/migrate-client-data.js — restricted
// to tier 'super' only, writes nothing until "commit" is called with a valid
// confirmToken AND the typed confirmation phrase (checked server-side, not
// just gated in the UI).
//
// The approved plan gave full client/service NAMES and 1-indexed ARRAY
// POSITIONS for every keep/drop target, but only partial/elided service ids
// (e.g. "..._facebook_7") — and one pair (Leese Flooring's Google Business
// Profile duplicates) shares the exact same id, so id-based matching isn't
// reliable there anyway. Every target below is therefore matched by client
// name + array position + service name + assignee-status, cross-checked at
// BOTH dry-run and commit time — if live data has drifted from what the plan
// described (wrong name at that position, wrong copy count, an "empty" drop
// candidate that turns out to have real work on it), that row FAILS and nothing
// for that client is touched.
//
// Only top-level client.services[] is targeted — none of these 4 clients were
// described as having franchise locations in the approved plan. If any of
// them unexpectedly does, that's reported as a warning, not silently ignored.
//
//   dry-run — body: {}. Re-verifies all 5 target rows against live data,
//             reports full before/after detail per row, writes nothing.
//             Returns a confirmToken bound to a hash of the exact matched
//             objects, valid for 30 minutes — only issued if every row passes.
//   commit  — body: { confirmToken, confirmPhrase }. Refuses unless
//             confirmPhrase === CONFIRM_PHRASE exactly, the token matches a
//             fresh re-verification of the same 5 rows, and hasn't expired.
//             Writes one row per affected client (2 clients here, since
//             Leese Flooring has two target rows) — never a bulk rewrite.

import crypto from 'crypto';
import { getSupabaseAdmin } from '../lib/supabaseAdmin.js';
import { requireSession, tierOf } from '../lib/opsSession.js';
import { logError } from '../lib/errorLog.js';

const TOKEN_TTL_MS = 30 * 60 * 1000; // 30 minutes
const CONFIRM_PHRASE = 'REMOVE 5 DUPLICATE SERVICES';

export const TARGET_REMOVALS = [
  {
    clientName: 'Leese Flooring Supplies Inc.',
    serviceName: 'Review Generation Grade_Us',
    expectedCopies: 2,
    keepPosition: 11,
    dropPositions: [13],
  },
  {
    clientName: 'AMPM',
    serviceName: 'Business Listings',
    expectedCopies: 2,
    keepPosition: 2,
    dropPositions: [3],
  },
  {
    clientName: 'Connecticut Retail Network (CRN)',
    serviceName: 'LinkedIn',
    expectedCopies: 2,
    keepPosition: 6,
    dropPositions: [11],
  },
  {
    clientName: 'High School Counselor Marketing',
    serviceName: 'Facebook',
    expectedCopies: 3,
    keepPosition: 8,
    dropPositions: [15, 16],
    keepMustBeAssignedTo: 'Sherine Amin',
  },
  {
    clientName: 'Leese Flooring Supplies Inc.',
    serviceName: 'Google Business Profile',
    expectedCopies: 2,
    keepPosition: 3,
    dropPositions: [12],
    keepMustBeAssignedTo: 'Sherine Amin',
    note: 'Both copies share the id svc_leese-flooring-supplies-inc_google-business-profile_11 — matched by array position, never by id.',
  },
];

function isAssignedTo(svc, name) {
  const who = String(svc?.assigneeName || svc?.assignee || '').trim().toLowerCase();
  return !!name && who === String(name).trim().toLowerCase();
}

function isTrulyEmpty(svc) {
  return !svc?.assigneeId && !svc?.assigneeName && !svc?.assignee && !svc?.lastDone && !String(svc?.notes || '').trim();
}

// Pure, exported for direct unit testing (no Supabase needed) — matches one
// TARGET_REMOVALS entry against one client's CURRENT data.services array.
// Returns { ok, reason, client, keepService, dropServices } — never mutates.
export function matchTargetRow(client, target) {
  const services = Array.isArray(client?.services) ? client.services : [];
  const nameLower = target.serviceName.toLowerCase();
  const copies = services.filter(s => String(s?.name || '').toLowerCase() === nameLower);

  if (copies.length !== target.expectedCopies) {
    return { ok: false, reason: `expected ${target.expectedCopies} "${target.serviceName}" cop${target.expectedCopies === 1 ? 'y' : 'ies'}, found ${copies.length}` };
  }

  const keep = services[target.keepPosition - 1];
  if (!keep || String(keep.name || '').toLowerCase() !== nameLower) {
    return { ok: false, reason: `position ${target.keepPosition} is not "${target.serviceName}" (found "${keep?.name || '(nothing there)'}")` };
  }
  if (target.keepMustBeAssignedTo && !isAssignedTo(keep, target.keepMustBeAssignedTo)) {
    return { ok: false, reason: `the keep copy at position ${target.keepPosition} is not assigned to ${target.keepMustBeAssignedTo} (assignee: "${keep.assigneeName || keep.assignee || '(none)'}")` };
  }

  const dropServices = [];
  for (const pos of target.dropPositions) {
    const svc = services[pos - 1];
    if (!svc || String(svc.name || '').toLowerCase() !== nameLower) {
      return { ok: false, reason: `position ${pos} is not "${target.serviceName}" (found "${svc?.name || '(nothing there)'}")` };
    }
    if (svc === keep) {
      return { ok: false, reason: `position ${pos} and the keep position ${target.keepPosition} refer to the same array slot` };
    }
    if (!isTrulyEmpty(svc)) {
      return { ok: false, reason: `position ${pos} is not empty (assignee "${svc.assigneeName || svc.assignee || ''}", lastDone "${svc.lastDone || ''}", or notes present) — refusing to drop a copy with real work on it` };
    }
    dropServices.push(svc);
  }

  return { ok: true, client, keepService: keep, dropServices };
}

// Deterministic hash of exactly what would change — the commit token is bound
// to this, so if live data drifts between dry-run and commit, verification
// fails and nothing is written.
function contentHash(results) {
  const shape = results.map(r => ({
    ok: r.ok,
    clientId: r.client?.id || null,
    keep: r.ok ? { id: r.keepService.id, name: r.keepService.name } : null,
    drops: r.ok ? r.dropServices.map(s => ({ id: s.id, name: s.name })) : null,
  }));
  return crypto.createHash('sha256').update(JSON.stringify(shape)).digest('hex');
}

function makeToken(hash, expiresAt) {
  const secret = process.env.SESSION_SECRET;
  const sig = crypto.createHmac('sha256', secret).update(`${hash}|${expiresAt}`).digest('base64url');
  return `${expiresAt}.${sig}`;
}

function verifyToken(token, hash) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return { ok: false, reason: 'malformed token' };
  const [expiresAtStr] = token.split('.');
  const expiresAt = Number(expiresAtStr);
  if (!expiresAt || Date.now() > expiresAt) return { ok: false, reason: 'token expired — run the dry run again' };
  if (makeToken(hash, expiresAt) !== token) return { ok: false, reason: 'token does not match the current data — run the dry run again' };
  return { ok: true };
}

// Runs every TARGET_REMOVALS row against live `clients`, by exact client name.
export function runAllTargets(clients) {
  return TARGET_REMOVALS.map(target => {
    const matches = clients.filter(c => (c.data?.name || '') === target.clientName);
    if (matches.length !== 1) {
      return { target, ok: false, reason: matches.length === 0 ? `no client named "${target.clientName}" found` : `${matches.length} clients named "${target.clientName}" — ambiguous` };
    }
    const client = { id: matches[0].id, ...matches[0].data };
    if (Array.isArray(client.locations) && client.locations.length) {
      return { target, ok: false, reason: `"${target.clientName}" has franchise locations, which the approved plan didn't account for — refusing to guess` };
    }
    const result = matchTargetRow(client, target);
    return { target, client, ...result };
  });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let session;
  try { session = requireSession(req); }
  catch (err) { await logError({ endpoint: 'cleanup-duplicate-services', error: err }); return res.status(500).json({ error: err.message }); }
  if (!session) return res.status(401).json({ error: 'Missing or invalid session' });
  if (tierOf(session) !== 'super') return res.status(403).json({ error: 'Super Admin/Owner only' });

  const { action } = req.body || {};
  let supabase;
  try { supabase = getSupabaseAdmin(); }
  catch (err) { await logError({ endpoint: 'cleanup-duplicate-services', error: err, session }); return res.status(500).json({ error: err.message }); }

  const { data: clients, error: fetchErr } = await supabase.from('ops_clients').select('id, data');
  if (fetchErr) { await logError({ endpoint: 'cleanup-duplicate-services', error: fetchErr, session }); return res.status(500).json({ error: `Failed to read ops_clients: ${fetchErr.message}` }); }

  const results = runAllTargets(clients || []);
  const allPass = results.every(r => r.ok);
  const hash = contentHash(results);

  if (action === 'dry-run') {
    return res.status(200).json({
      ok: true,
      dryRun: true,
      allPass,
      rows: results.map(r => ({
        clientName: r.target.clientName,
        serviceName: r.target.serviceName,
        ok: r.ok,
        reason: r.reason || null,
        keep: r.ok ? { id: r.keepService.id, name: r.keepService.name, assignee: r.keepService.assigneeName || r.keepService.assignee || null } : null,
        drop: r.ok ? r.dropServices.map(s => ({ id: s.id, name: s.name })) : null,
      })),
      confirmToken: allPass ? makeToken(hash, Date.now() + TOKEN_TTL_MS) : null,
      confirmTokenExpiresAt: allPass ? Date.now() + TOKEN_TTL_MS : null,
      confirmPhraseExpected: CONFIRM_PHRASE,
    });
  }

  if (action === 'commit') {
    const { confirmToken, confirmPhrase } = req.body || {};
    if (confirmPhrase !== CONFIRM_PHRASE) {
      return res.status(403).json({ error: `Refusing to write: confirmation phrase did not match exactly.` });
    }
    if (!allPass) {
      return res.status(409).json({ error: 'Refusing to write: at least one target row no longer verifies against live data. Run the dry run again.', rows: results.map(r => ({ clientName: r.target.clientName, serviceName: r.target.serviceName, ok: r.ok, reason: r.reason || null })) });
    }
    const check = verifyToken(confirmToken, hash);
    if (!check.ok) return res.status(403).json({ error: `Refusing to write: ${check.reason}` });

    // Group by client — Leese Flooring has two target rows, so it gets ONE
    // write with both removals applied, not two separate read-modify-writes
    // racing each other.
    const byClientId = new Map();
    for (const r of results) {
      if (!byClientId.has(r.client.id)) byClientId.set(r.client.id, { client: r.client, drops: [] });
      byClientId.get(r.client.id).drops.push(...r.dropServices);
    }

    const removed = [];
    const writeErrors = [];
    for (const { client, drops } of byClientId.values()) {
      const before = client.services.length;
      const updatedServices = client.services.filter(s => !drops.includes(s));
      const updatedData = { ...client, services: updatedServices };
      delete updatedData.id;
      const { error } = await supabase.from('ops_clients').update({ data: updatedData }).eq('id', client.id);
      if (error) { writeErrors.push({ clientId: client.id, clientName: client.name, error: error.message }); continue; }
      removed.push({ clientId: client.id, clientName: client.name, removedCount: before - updatedServices.length, removedServiceNames: drops.map(s => s.name) });
    }

    if (writeErrors.length) await logError({ endpoint: 'cleanup-duplicate-services', error: `${writeErrors.length} write error(s)`, session, extra: { writeErrors } });

    // Re-read to confirm the removals actually landed and every keep survived.
    const { data: after } = await supabase.from('ops_clients').select('id, data').in('id', [...byClientId.keys()]);
    const verification = (after || []).map(row => {
      const before = byClientId.get(row.id);
      const stillHasKeeps = results.filter(r => r.client.id === row.id).every(r => (row.data.services || []).some(s => s === r.keepService || (s.id === r.keepService.id && (s.assigneeName || s.assignee) === (r.keepService.assigneeName || r.keepService.assignee))));
      return { clientId: row.id, clientName: before.client.name, servicesCountAfter: (row.data.services || []).length, allKeepsStillPresent: stillHasKeeps };
    });

    return res.status(200).json({
      ok: writeErrors.length === 0,
      removed, writeErrors, verification,
      totalRemoved: removed.reduce((n, r) => n + r.removedCount, 0),
    });
  }

  return res.status(400).json({ error: `Unknown action "${action}" — expected "dry-run" or "commit".` });
}
