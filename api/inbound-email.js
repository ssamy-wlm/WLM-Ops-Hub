// Inbound email → auto-create task/service (2026-09-11).
//
// David or Sarah email task@<inbound-domain> or service@<inbound-domain>;
// Resend receives it, fires an `email.received` webhook here, and this
// endpoint parses the body (reusing the existing Task Assignments email
// parser, api/process-transcript.js's parseTaskEmailForSession — see that
// file's own comment on why it now has a session-independent exported
// core) and writes the result straight into ops_tasks or a client's
// services[]. A confirmation (or "couldn't parse") reply is sent back to
// the sender via Resend.
//
// service@ additionally matches every parsed service name against the
// live Service Catalog (ops_settings key 'serviceCatalog', the same
// single source of truth client.html's own Manage Bundles/Categories
// editor writes — see CLAUDE.md's own architecture note) before creating
// anything, per the 2026-09-11 follow-up: an exact/normalized name reuses
// the catalog entry outright; a close/fuzzy match never auto-creates — it
// holds for a CONFIRM/NEW reply instead (see the big comment on
// pendingKey() below for how that reply is correlated, and why); a
// genuinely unmatched name is created AND added to the catalog, so the
// next email using that same name hits the exact-match case.
//
// This is the app's first piece of unauthenticated EXTERNAL ingress — no
// signed session token exists for an inbound email, so every other
// endpoint's "the server never trusts what the client claims" discipline
// (CLAUDE.md rule #4) has a sharper edge here: the ENTIRE trust boundary is
// (1) the webhook's own cryptographic signature, proving this request
// really came from Resend, and (2) a hardcoded sender allowlist, proving
// the EMAIL really came from David or Sarah. Both must pass before a
// single byte of the email body is read or a single dollar of Anthropic
// API cost is spent — see the strict step ordering below, which mirrors
// this task's own explicit security ordering, not just a stylistic
// convenience.
//
// Only possible now that this project moved off the Vercel Hobby plan's
// 12-serverless-function cap (see CLAUDE.md's extensive history of every
// prior feature in this repo being folded into an existing endpoint to
// stay under that limit) — this is a genuinely new api/*.js file.

import crypto from 'node:crypto';
import { logError } from '../lib/errorLog.js';
import { getSupabaseAdmin } from '../lib/supabaseAdmin.js';
import { sendResendEmail, buildEmailHtml } from '../lib/resendClient.js';
import { parseTaskEmailForSession } from './process-transcript.js';

export const config = { api: { bodyParser: false } };

// Sender allowlist — the cost/abuse gate. Anyone else emailing either
// inbound address is a complete no-op: no signature check is skipped for
// them (that still runs first, since it's cheaper and protects the
// endpoint itself), but nothing past this point ever runs for them — no
// Resend body fetch, no Anthropic call, no database write. Edit this set
// to add/remove allowed senders; it is deliberately a plain, easy-to-read
// constant, not sourced from any table, since the whole point is that this
// gate must be trivially auditable.
const ALLOWED_SENDERS = new Set(['david@weblightmedia.com', 'ssamy@weblightmedia.com']);
const RATE_LIMIT_PER_SENDER_PER_DAY = 20;
// The two inbound addresses this endpoint routes on — matched against each
// entry of the webhook's own `to` array, case-insensitively, as a full
// address (not just the local part) so a similarly-named address on a
// different domain can never accidentally match.
const TASK_INBOX = 'task@opshub.wlmsend.com';
const SERVICE_INBOX = 'service@opshub.wlmsend.com';

async function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Manual Svix verification (Resend's webhook signing provider) — no `svix`
// npm dependency added for this, matching this codebase's own established
// preference to avoid a new dependency when Node's built-in crypto already
// covers it plainly (see the password-hashing entry's identical reasoning
// for scrypt over bcrypt/argon2). Algorithm confirmed against Svix's own
// public docs (docs.svix.com/receiving/verifying-payloads/how-manual),
// not guessed: signedContent = `${svix-id}.${svix-timestamp}.${rawBody}`,
// HMAC-SHA256 keyed by the base64-decoded secret (after stripping its
// `whsec_` prefix), digest base64, compared against every space-separated
// `v1,<sig>` entry in svix-signature using a constant-time comparison.
// The rawBody here MUST be the exact, unparsed bytes Resend sent — any
// re-serialization (even whitespace-identical JSON.stringify(JSON.parse(...)))
// changes the signature — which is the entire reason this endpoint disables
// Vercel's default body parser (see the `config` export above) and reads
// the raw stream itself before anything else touches it.
function verifySvixSignature(rawBody, headers, secret) {
  const svixId = headers['svix-id'];
  const svixTimestamp = headers['svix-timestamp'];
  const svixSignature = headers['svix-signature'];
  if (!svixId || !svixTimestamp || !svixSignature || !secret) return false;

  // Reject a timestamp too far from now — 5 minutes tolerance, Svix's own
  // documented default — so a captured/replayed request can't be re-sent
  // indefinitely even if it once had a valid signature.
  const ts = parseInt(svixTimestamp, 10);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) return false;

  let secretBytes;
  try {
    secretBytes = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  } catch { return false; }

  const signedContent = `${svixId}.${svixTimestamp}.${rawBody.toString('utf8')}`;
  const expectedSig = crypto.createHmac('sha256', secretBytes).update(signedContent).digest('base64');
  const expectedBuf = Buffer.from(expectedSig);

  return svixSignature.split(' ').some(entry => {
    const sig = entry.split(',')[1];
    if (!sig) return false;
    try {
      const sigBuf = Buffer.from(sig);
      return sigBuf.length === expectedBuf.length && crypto.timingSafeEqual(sigBuf, expectedBuf);
    } catch { return false; }
  });
}

// ops_settings is the same generic key-value table (`key text primary key,
// data jsonb`) every other small piece of server-side state in this app
// already lives in (lastTeamSummaryEmailAt, notificationSettings, etc.) —
// no new table for this. One row per processed email_id (rather than one
// growing array) so a dedup check is a single indexed lookup, not an
// ever-larger array scan, and a rate-limit counter keyed by sender+day.
async function alreadyProcessed(supabase, emailId) {
  const { data } = await supabase.from('ops_settings').select('key').eq('key', `inboundEmailSeen:${emailId}`).maybeSingle();
  return !!data;
}
async function markProcessed(supabase, emailId, extra) {
  await supabase.from('ops_settings').upsert(
    { key: `inboundEmailSeen:${emailId}`, data: { processedAt: new Date().toISOString(), ...extra } },
    { onConflict: 'key' }
  );
}
// Read-then-write, not atomic — an accepted, documented limitation given
// the realistic concurrency here (two human senders occasionally emailing
// a task tracker, not a high-throughput system); a genuine race would at
// worst let the count drift a little past the limit for one request, never
// let it grow unbounded.
async function checkAndBumpRateLimit(supabase, senderEmail) {
  const day = new Date().toISOString().slice(0, 10);
  const key = `inboundEmailRate:${senderEmail}:${day}`;
  const { data } = await supabase.from('ops_settings').select('data').eq('key', key).maybeSingle();
  const count = (data?.data?.count) || 0;
  if (count >= RATE_LIMIT_PER_SENDER_PER_DAY) return false;
  await supabase.from('ops_settings').upsert({ key, data: { count: count + 1 } }, { onConflict: 'key' });
  return true;
}

// Builds a session-SHAPED object for the resolved, already-allowlisted
// sender — the same {id, role, level, name, email, employeeId} shape
// api/ops-auth.js issues on a real login, since parseTaskEmailForSession()
// (and the scope/owner-matching logic inside it) only ever reads those
// fields, never anything from an actual signed token. Sarah is the
// PRIMARY_ADMIN_EMAIL login sentinel (see api/ops-auth.js) — she has no
// real ops_admins row, so her shape is the same fixed literal every other
// notification resolver in this codebase already hardcodes for her.
// David's id is NEVER hardcoded — looked up fresh against the live
// ops_admins table by email, the same "never trust an unverified id"
// discipline this codebase's own task-parser Sarah-alias fix already
// established (2026-08-25), so this self-corrects if his account is ever
// recreated under a different id.
async function resolveInboundSender(supabase, fromEmail) {
  if (fromEmail === 'ssamy@weblightmedia.com') {
    return { id: 'primary-admin', role: 'admin', level: 'owner', name: 'Sarah Samy', email: fromEmail };
  }
  const { data: admins, error } = await supabase.from('ops_admins').select('id, data');
  if (error) throw new Error(error.message);
  const row = (admins || []).find(a => (a.data?.email || '').toLowerCase() === fromEmail && a.data?.status !== 'inactive');
  if (!row) return null;
  return { id: row.id, role: 'admin', level: row.data.level || 'admin', name: row.data.name || fromEmail, email: fromEmail };
}

// Name lookup for a resolved assigneeId — the same fallback-fill
// precedence api/ops-sync.js's resolveAssigneeName() already established
// (2026-09-04): the primary-admin sentinel first, then ops_users, then
// ops_admins. Needed here because this endpoint writes directly to
// ops_tasks/ops_clients, bypassing api/ops-sync.js's own write path (and
// its own automatic name-fill) entirely — this is the same guarantee,
// just re-applied at this different write site rather than left blank.
function nameForId(id, { users, admins }) {
  if (!id) return '';
  if (id === 'primary-admin') return 'Sarah Samy';
  const u = (users || []).find(x => x.id === id);
  if (u) return u.data?.name || '';
  const a = (admins || []).find(x => x.id === id);
  return a ? (a.data?.name || '') : '';
}

function genId(prefix) { return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`; }

// process-transcript.js's own '__ALL__' sentinel (EVERYONE_ASSIGNEE_ID,
// not exported — hand-duplicated here as a single literal, same
// documented-duplication convention this codebase already uses across the
// three frontends) means "assign to the whole team," resolved by
// index.html's _taBuildEveryoneClones() into one real clone per active
// roster member BEFORE anything reaches the server — a purely client-side
// expansion step this endpoint has no equivalent for. Rather than silently
// writing a literal, unresolvable "__ALL__" into a stored assigneeId (which
// no portal could ever display correctly), an inbound-email "assign to
// everyone" is deliberately treated as unassigned — flagged as a known,
// documented gap (see this feature's own CLAUDE.md entry) rather than
// reimplementing the whole-roster clone fan-out for what should be a rare
// case in a one-off email.
const EVERYONE_ASSIGNEE_ID = '__ALL__';
function resolveAssigneeIdForWrite(assigneeId) {
  return assigneeId && assigneeId !== EVERYONE_ASSIGNEE_ID ? assigneeId : null;
}

// Creates one real ops_tasks row per parsed task. A row the parser already
// flagged as a likely duplicate of an existing task (mergeIntoId) is
// deliberately SKIPPED, not auto-merged — the parser's own additive-merge
// logic (append notes, union tags, fill an empty dueDate) is implemented
// client-side in both portals' staging-commit functions today, with no
// server-side equivalent to call into from here; re-implementing it just
// for this one-off, low-volume path was judged not worth the added risk of
// a subtly different merge behavior. Skipped rows are reported back in the
// confirmation reply instead of silently vanishing (rule #7) — see the
// caller.
async function createTasksFromParsed(supabase, parsedTasks, sender, roster) {
  const created = [];
  const skippedAsDuplicate = [];
  for (const t of parsedTasks) {
    if (t.mergeIntoId) { skippedAsDuplicate.push({ subject: t.subject, mergeIntoSubject: t.mergeIntoSubject }); continue; }
    const id = genId('task');
    const row = {
      subject: t.subject,
      notes: t.notes,
      tags: t.tags,
      category: t.category,
      priority: t.priority,
      dueDate: t.dueDate,
      dueDateLocked: false,
      assignedDate: t.assignedDate,
      clientId: t.clientId,
      clientName: t.clientName,
      assigneeId: resolveAssigneeIdForWrite(t.assigneeId),
      assigneeName: nameForId(resolveAssigneeIdForWrite(t.assigneeId), roster),
      assignedById: sender.id,
      assignedByName: sender.name,
      origin: 'admin',
      status: t.status,
      recurring: null,
      selfAssignedAt: null,
      source: 'inbound-email',
    };
    const { error } = await supabase.from('ops_tasks').upsert({ id, data: row }, { onConflict: 'id' });
    if (error) throw new Error(error.message);
    created.push({ id, ...row });
  }
  return { created, skippedAsDuplicate };
}

// ── Service Catalog matching (2026-09-11 follow-up) ─────────────────────
// The Catalog (ops_settings key 'serviceCatalog') is the single source of
// truth for service names — see client.html's own header comment on this
// same key. Every parsed service name is matched against it BEFORE
// anything is created:
//   'exact' — a normalized (trim + lowercase + collapsed whitespace)
//             identical name. Reuses the catalog entry's own canonical
//             name/freq/bundle/category. No catalog write.
//   'close' — a fuzzy match: small edit distance, OR one name containing
//             the other (the task's own two named examples). NEVER
//             auto-created — held for a CONFIRM/NEW reply instead.
//   'new'   — no reasonable match. Created immediately, using the parsed
//             name verbatim, AND appended to the catalog in the same
//             request, so the next email with this exact name hits the
//             'exact' case.
const CATALOG_SETTINGS_KEY = 'serviceCatalog';
// Same 0.72 similarity threshold process-transcript.js's own
// _phoneticSimilarity() already established for client-name fuzzy
// matching (2026-08-20/2026-08-25) — reused here as this codebase's own
// precedent for "close enough to ask about, not close enough to assume."
const CLOSE_MATCH_THRESHOLD = 0.72;
const CLOSE_MATCH_MIN_LEN = 3;

function _normalizeServiceName(name) {
  return String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

// Plain iterative Levenshtein distance — no new dependency, same reasoning
// this file's own Svix-verification comment already documents for
// crypto over an npm package: a few lines of well-understood array math
// already cover it.
function _levenshteinDistance(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[n];
}

// Returns a 0..1 similarity score. Containment (one normalized name fully
// inside the other — the task's own "or contains" example) is
// deliberately forced above the close threshold, but this function is
// never the thing deciding "exact" — the caller already compares the two
// normalized strings directly for that, before this is ever called — so
// "Blogging" containing "Blogging Service" only ever lands as 'close'.
function _catalogNameSimilarity(rawA, rawB) {
  const a = _normalizeServiceName(rawA), b = _normalizeServiceName(rawB);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length >= CLOSE_MATCH_MIN_LEN && b.length >= CLOSE_MATCH_MIN_LEN && (a.includes(b) || b.includes(a))) return 0.85;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen < CLOSE_MATCH_MIN_LEN) return 0;
  return 1 - _levenshteinDistance(a, b) / maxLen;
}

// Matches one parsed service name against the live catalog. `ambiguous`
// is true only when two or more distinct catalog names score above the
// close threshold within 0.05 of each other — logged (this feature's own
// explicit "log ambiguous cases" requirement, see the caller), but the
// single best-scoring candidate is still what's offered in the
// CONFIRM/NEW reply — asking about the single strongest guess is more
// useful to the sender than refusing to guess at all; `ambiguous` is only
// ever a signal for the log entry, never a third outcome.
function matchCatalogService(rawName, catalogServices) {
  const norm = _normalizeServiceName(rawName);
  if (!norm) return { tier: 'new' };
  const exact = (catalogServices || []).find(s => _normalizeServiceName(s.name) === norm);
  if (exact) return { tier: 'exact', service: exact };
  const scored = (catalogServices || [])
    .map(s => ({ service: s, score: _catalogNameSimilarity(rawName, s.name) }))
    .filter(x => x.score >= CLOSE_MATCH_THRESHOLD)
    .sort((a, b) => b.score - a.score);
  if (!scored.length) return { tier: 'new' };
  const ambiguous = scored.length > 1 && (scored[0].score - scored[1].score) < 0.05;
  return { tier: 'close', service: scored[0].service, score: scored[0].score, ambiguous, candidateCount: scored.length };
}

// No stored catalog yet (a genuinely fresh install) is treated as EMPTY,
// never reconstructed from client.html's own large hardcoded default seed
// (BUNDLE_DEFS/DEFAULT_CATALOG) — this endpoint has no access to that
// client-side constant and shouldn't guess at it (rule #7). Every match
// then correctly falls to the 'new' tier and starts building the real
// catalog from there, which is the safe direction to err in (an extra
// catalog entry, never a silently-assumed one).
async function loadCatalog(supabase) {
  const { data, error } = await supabase.from('ops_settings').select('data').eq('key', CATALOG_SETTINGS_KEY).maybeSingle();
  if (error) throw new Error(error.message);
  const c = data?.data;
  if (c && typeof c === 'object' && Array.isArray(c.services)) {
    return { bundles: Array.isArray(c.bundles) ? c.bundles : [], services: c.services, categories: Array.isArray(c.categories) ? c.categories : [] };
  }
  return { bundles: [], services: [], categories: [] };
}

// Appends one or more new entries to the catalog's services[] in a single
// read-modify-write — bundles/categories/every existing service pass
// through completely untouched, the same non-destructive discipline this
// file's own service-write functions already use for a client record.
async function addNewCatalogServices(supabase, catalog, names) {
  const additions = names.map(name => ({
    id: genId('svc'),
    name,
    bundle: null,
    category: null,
    freq: 'one-time',
    desc: '',
    defaultAssignee: '',
  }));
  const updated = { bundles: catalog.bundles, categories: catalog.categories, services: [...catalog.services, ...additions] };
  const { error } = await supabase.from('ops_settings').upsert({ key: CATALOG_SETTINGS_KEY, data: updated }, { onConflict: 'key' });
  if (error) throw new Error(error.message);
  return additions;
}

// ── Pending CONFIRM/NEW state for a close-match reply ───────────────────
// One ops_settings row per sender email (never per-item) — a sender only
// ever has one in-flight accumulating list of unresolved close-match
// items, appended to by each new service@ email that produces one.
//
// Reply correlation is deliberately NOT based on Resend's own email-
// threading headers (In-Reply-To/References/thread id): this environment
// has no live access to confirm what threading metadata the webhook
// payload or the Received-Emails API actually exposes for a real reply
// (rule #11), so relying on it unverified risked a silent, untestable
// failure in production. Instead a reply is recognized purely by its own
// content — the ENTIRE first line of the subject or the body must be just
// the word CONFIRM or NEW, optionally followed by a number (required only
// once more than one item is pending at once, to say which one) — from an
// already-allowlisted sender who already has at least one pending item.
// This is a deliberate, explicitly flagged design decision (see this
// feature's own CLAUDE.md entry) — the task's own spec described the
// desired REPLY WORDING, not the correlation mechanism, so this was not a
// literal instruction to follow, but a gap this agent had to fill in and
// is surfacing rather than silently assuming.
function pendingKey(senderEmail) { return `inboundServicePending:${senderEmail}`; }
async function loadPendingConfirmations(supabase, senderEmail) {
  const { data, error } = await supabase.from('ops_settings').select('data').eq('key', pendingKey(senderEmail)).maybeSingle();
  if (error) throw new Error(error.message);
  return Array.isArray(data?.data?.items) ? data.data.items : [];
}
async function savePendingConfirmations(supabase, senderEmail, items) {
  if (!items.length) {
    const { error } = await supabase.from('ops_settings').delete().eq('key', pendingKey(senderEmail));
    if (error) throw new Error(error.message);
    return;
  }
  const { error } = await supabase.from('ops_settings').upsert({ key: pendingKey(senderEmail), data: { items } }, { onConflict: 'key' });
  if (error) throw new Error(error.message);
}

// Requires the WHOLE first line to be just the keyword (+ optional
// number) — never a substring match inside an ordinary sentence — so a
// genuinely unrelated email that merely starts with the word "New" (e.g.
// "New blog post needed...") is never mistaken for a reply.
function parseConfirmReply(subject, body) {
  const tryText = (text) => {
    const line = String(text || '').replace(/^re:\s*/i, '').trim().split(/\r?\n/)[0].trim();
    const m = line.match(/^(confirm|new)\s*#?(\d+)?\.?$/i);
    if (!m) return null;
    return { action: m[1].toLowerCase(), index: m[2] ? parseInt(m[2], 10) : null };
  };
  return tryText(subject) || tryText(body);
}

async function writeOneService(supabase, clientId, serviceRow) {
  const { data: clientRow, error: readErr } = await supabase.from('ops_clients').select('id, data').eq('id', clientId).maybeSingle();
  if (readErr) throw new Error(readErr.message);
  if (!clientRow) throw new Error(`Client ${clientId} no longer exists`);
  const updatedData = { ...clientRow.data, services: [...(clientRow.data.services || []), serviceRow] };
  const { error: writeErr } = await supabase.from('ops_clients').update({ data: updatedData }).eq('id', clientId);
  if (writeErr) throw new Error(writeErr.message);
  return { ...serviceRow, clientId, clientName: clientRow.data?.name || '' };
}

// Resolves a CONFIRM/NEW reply against this sender's pending close-match
// items. Returns null when this email isn't recognizable as such a reply
// at all (no pending items for this sender, or no CONFIRM/NEW keyword
// found) — the caller then falls through to a normal parse, exactly as if
// this function didn't exist, so an ordinary new service@ email from a
// sender who happens to have an old unresolved item is unaffected.
async function resolvePendingServiceReply(supabase, sender, subject, emailText) {
  const pending = await loadPendingConfirmations(supabase, sender.email);
  if (!pending.length) return null;
  const parsed = parseConfirmReply(subject, emailText);
  if (!parsed) return null;

  let target = null;
  if (pending.length === 1 && parsed.index == null) target = pending[0];
  else if (parsed.index != null) target = pending[parsed.index - 1] || null;

  if (!target) {
    return {
      resolved: false,
      body: [
        'Couldn\'t tell which pending item you meant — reply with the number too, e.g. "CONFIRM 1" or "NEW 2":',
        '',
        ...pending.map((p, i) => `${i + 1}. "${p.parsedName}" ~ "${p.matchedService.name}" for ${p.clientName}`),
      ].join('\n'),
    };
  }

  const remaining = pending.filter(p => p.id !== target.id);
  await savePendingConfirmations(supabase, sender.email, remaining);

  let created;
  if (parsed.action === 'confirm') {
    created = await writeOneService(supabase, target.clientId, {
      id: genId('svc'),
      name: target.matchedService.name,
      notes: target.notes,
      freq: target.matchedService.freq || 'one-time',
      bundle: target.matchedService.bundle || null,
      category: target.matchedService.category || '',
      due: target.dueDate || '',
      assigneeId: target.assigneeId,
      assigneeName: target.assigneeName,
      workStatus: 'not_started',
      status: 'active',
      source: 'inbound-email',
      fromCatalogServiceId: target.matchedService.id,
    });
  } else {
    created = await writeOneService(supabase, target.clientId, {
      id: genId('svc'),
      name: target.parsedName,
      notes: target.notes,
      freq: 'one-time',
      due: target.dueDate || '',
      assigneeId: target.assigneeId,
      assigneeName: target.assigneeName,
      workStatus: 'not_started',
      status: 'active',
      category: '',
      source: 'inbound-email',
      addedToCatalog: true,
    });
    const catalog = await loadCatalog(supabase);
    await addNewCatalogServices(supabase, catalog, [target.parsedName]);
  }

  return {
    resolved: true,
    action: parsed.action,
    item: target,
    created,
    body: parsed.action === 'confirm'
      ? `Added your service "${target.matchedService.name}" to ${target.clientName} (used your existing catalog entry).`
      : `Created new service "${target.parsedName}" and added it to the catalog, for ${target.clientName}.`,
  };
}

// Matches every parsed, client-resolved service name against the live
// Catalog (matchCatalogService(), above) before creating anything. Three
// outcomes per item, mirroring this feature's own three numbered tiers:
//  1. exact  → the client's new service row reuses the CATALOG entry's
//     own canonical name/freq/bundle/category (never the raw, possibly
//     differently-capitalized, parsed text) — created immediately, no
//     catalog write.
//  2. close  → nothing is created. Held as a pending confirmation (see
//     pendingKey() above) and reported back to the sender to CONFIRM or
//     NEW. Logged via logError (this feature's own explicit "log
//     ambiguous cases" requirement) regardless of outcome.
//  3. new    → created immediately using the parsed name verbatim, AND
//     the exact same name is appended to the Catalog in the same request
//     (addNewCatalogServices(), one single catalog write for every
//     'new'-tier item across the whole email, never one write per item)
//     — so the NEXT email using this name hits tier 1 instead.
// A parsed item with no matched clientId is still reported as unmatched,
// unchanged from before this feature.
async function createServicesFromParsed(supabase, parsedTasks, sender, roster, emailId) {
  const unmatched = [];
  const withClient = [];
  for (const t of parsedTasks) {
    if (!t.clientId) { unmatched.push({ subject: t.subject }); continue; }
    withClient.push(t);
  }
  if (!withClient.length) return { createdExisting: [], createdNew: [], pendingConfirmDisplay: [], totalPendingAfter: 0, unmatched };

  const catalog = await loadCatalog(supabase);
  const matched = withClient.map(t => ({ t, m: matchCatalogService(t.subject, catalog.services) }));

  const exactItems = matched.filter(x => x.m.tier === 'exact');
  const closeItems = matched.filter(x => x.m.tier === 'close');
  const newItems = matched.filter(x => x.m.tier === 'new');

  for (const { t, m } of closeItems) {
    await logError({
      endpoint: 'inbound-email:catalog-match',
      error: `Ambiguous catalog match: "${t.subject}" ~ "${m.service.name}" (score ${m.score.toFixed(2)}${m.ambiguous ? ', multiple close candidates' : ''})`,
      session: sender,
      extra: { emailId, parsedName: t.subject, matchedServiceId: m.service.id, matchedServiceName: m.service.name, candidateCount: m.candidateCount },
    });
  }

  // One read+write per CLIENT, not per service — matching this file's own
  // pre-existing batching convention for createTasksFromParsed()'s sibling.
  async function writeGrouped(items, buildRow) {
    const byClient = new Map();
    for (const item of items) {
      if (!byClient.has(item.t.clientId)) byClient.set(item.t.clientId, []);
      byClient.get(item.t.clientId).push(item);
    }
    const created = [];
    for (const [clientId, group] of byClient) {
      const { data: clientRow, error: readErr } = await supabase.from('ops_clients').select('id, data').eq('id', clientId).maybeSingle();
      if (readErr) throw new Error(readErr.message);
      if (!clientRow) { group.forEach(({ t }) => unmatched.push({ subject: t.subject })); continue; }
      const newServices = group.map(({ t, m }) => buildRow(t, m));
      const updatedData = { ...clientRow.data, services: [...(clientRow.data.services || []), ...newServices] };
      const { error: writeErr } = await supabase.from('ops_clients').update({ data: updatedData }).eq('id', clientId);
      if (writeErr) throw new Error(writeErr.message);
      newServices.forEach(s => created.push({ ...s, clientId, clientName: clientRow.data?.name || '' }));
    }
    return created;
  }

  const createdExisting = await writeGrouped(exactItems, (t, m) => ({
    id: genId('svc'),
    name: m.service.name,
    notes: t.notes,
    freq: m.service.freq || 'one-time',
    bundle: m.service.bundle || null,
    category: m.service.category || '',
    due: t.dueDate || '',
    assigneeId: resolveAssigneeIdForWrite(t.assigneeId) || m.service.defaultAssignee || null,
    assigneeName: nameForId(resolveAssigneeIdForWrite(t.assigneeId) || m.service.defaultAssignee || null, roster),
    workStatus: 'not_started',
    status: 'active',
    source: 'inbound-email',
    fromCatalogServiceId: m.service.id,
  }));

  const createdNew = await writeGrouped(newItems, (t) => ({
    id: genId('svc'),
    name: t.subject,
    notes: t.notes,
    freq: 'one-time',
    due: t.dueDate || '',
    assigneeId: resolveAssigneeIdForWrite(t.assigneeId),
    assigneeName: nameForId(resolveAssigneeIdForWrite(t.assigneeId), roster),
    workStatus: 'not_started',
    status: 'active',
    category: '',
    source: 'inbound-email',
    addedToCatalog: true,
  }));

  if (newItems.length) {
    await addNewCatalogServices(supabase, catalog, newItems.map(({ t }) => t.subject));
  }

  // Display numbering reflects each item's REAL position in the persisted
  // pending array (existing items first, these appended after) — not just
  // 1..N within this email — so a later "CONFIRM 2" reply correctly
  // resolves against what's actually stored, even if this sender already
  // had an earlier, still-unresolved item pending from a previous email.
  let pendingConfirmDisplay = [];
  let totalPendingAfter = 0;
  if (closeItems.length) {
    const pendingNew = closeItems.map(({ t, m }) => ({
      id: genId('pend'),
      parsedName: t.subject,
      clientId: t.clientId,
      clientName: t.clientName,
      notes: t.notes,
      dueDate: t.dueDate || '',
      assigneeId: resolveAssigneeIdForWrite(t.assigneeId),
      assigneeName: nameForId(resolveAssigneeIdForWrite(t.assigneeId), roster),
      matchedService: { id: m.service.id, name: m.service.name, freq: m.service.freq || 'one-time', bundle: m.service.bundle || null, category: m.service.category || '' },
      createdAt: new Date().toISOString(),
    }));
    const existingPending = await loadPendingConfirmations(supabase, sender.email);
    const merged = [...existingPending, ...pendingNew];
    await savePendingConfirmations(supabase, sender.email, merged);
    pendingConfirmDisplay = pendingNew.map((p, i) => ({ ...p, displayIndex: existingPending.length + i + 1 }));
    totalPendingAfter = merged.length;
  }

  return { createdExisting, createdNew, pendingConfirmDisplay, totalPendingAfter, unmatched };
}

function confirmationSubject(kind, ok) {
  return ok ? `Re: your ${kind} email — added ✓` : `Re: your ${kind} email — couldn't parse`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // ── Step 2: verify BEFORE parsing anything. Reads the raw stream exactly
  // once, so nothing downstream can accidentally re-serialize (and so
  // change) the bytes the signature was computed over. ──
  const rawBody = await readRawBody(req);
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret || !verifySvixSignature(rawBody, req.headers, secret)) {
    // Fail closed: a missing secret (misconfiguration) is treated exactly
    // like a bad signature — never "verification unavailable, allow
    // anyway." Never logs the raw body (unauthenticated input) to avoid
    // recording arbitrary attacker-controlled content.
    return res.status(401).json({ error: 'Invalid signature' });
  }

  let payload;
  try { payload = JSON.parse(rawBody.toString('utf8')); }
  catch { return res.status(400).json({ error: 'Invalid JSON' }); }

  if (payload?.type !== 'email.received') return res.status(200).json({ ok: true, ignored: 'not an email.received event' });

  const emailId = payload?.data?.email_id;
  const fromRaw = String(payload?.data?.from || '');
  const fromEmail = (fromRaw.match(/<([^>]+)>/)?.[1] || fromRaw).trim().toLowerCase();
  const toRaw = payload?.data?.to;
  const toList = (Array.isArray(toRaw) ? toRaw : [toRaw]).filter(Boolean).map(x => String(x).toLowerCase());

  if (!emailId) return res.status(200).json({ ok: true, ignored: 'missing email_id' });

  let supabase;
  try { supabase = getSupabaseAdmin(); }
  catch (err) { await logError({ endpoint: 'inbound-email', error: err }); return res.status(500).json({ error: err.message }); }

  // ── Step 3: dedupe. ──
  try {
    if (await alreadyProcessed(supabase, emailId)) return res.status(200).json({ ok: true, ignored: 'already processed' });
  } catch (err) {
    await logError({ endpoint: 'inbound-email', error: err, extra: { emailId } });
    return res.status(500).json({ error: err.message });
  }

  // ── Step 4: sender allowlist — the cost/abuse gate. Runs BEFORE any
  // parsing or body fetch, per this feature's own explicit security
  // ordering. A non-allowlisted sender is a complete, silent no-op: 200 OK,
  // nothing written, nothing read from Resend beyond the webhook metadata
  // already in hand, and — critically — the Anthropic API is never called
  // for them at all. ──
  if (!ALLOWED_SENDERS.has(fromEmail)) {
    return res.status(200).json({ ok: true, ignored: 'sender not allowlisted' });
  }

  let rateOk;
  try { rateOk = await checkAndBumpRateLimit(supabase, fromEmail); }
  catch (err) { await logError({ endpoint: 'inbound-email', error: err, extra: { emailId, fromEmail } }); return res.status(500).json({ error: err.message }); }
  if (!rateOk) {
    await logError({ endpoint: 'inbound-email', error: `Rate limit exceeded for ${fromEmail}`, extra: { emailId } });
    return res.status(200).json({ ok: true, ignored: 'rate limit exceeded' });
  }

  // ── Step 5: route by recipient. ──
  const isTask = toList.includes(TASK_INBOX);
  const isService = toList.includes(SERVICE_INBOX);
  if (!isTask && !isService) return res.status(200).json({ ok: true, ignored: 'recipient did not match task@ or service@' });
  const kind = isTask ? 'task' : 'service';

  let sender;
  try {
    sender = await resolveInboundSender(supabase, fromEmail);
    if (!sender) throw new Error(`Allowlisted sender ${fromEmail} has no matching active admin record`);
  } catch (err) {
    await logError({ endpoint: 'inbound-email', error: err, extra: { emailId, fromEmail } });
    return res.status(500).json({ error: err.message });
  }

  // ── Step 9 (defined here, used from every outcome below): confirmation
  // reply. A failed reply must never fail the whole request — by the time
  // this ever runs, the real task/service write (or the definitive
  // "nothing to create" decision) has already happened; losing the reply
  // is a real but much smaller problem than re-running the whole webhook.
  // Same non-fatal email-failure discipline api/ops-sync.js's own
  // insertNotifications() already established (2026-09-02, "Log when
  // email is skipped"). ──
  async function sendConfirmation(ok, body) {
    try {
      await sendResendEmail({
        to: sender.email,
        subject: confirmationSubject(kind, ok),
        html: buildEmailHtml({ name: sender.name, title: ok ? `✅ Added your ${kind}` : `⚠️ Couldn't process your ${kind} email`, body, link: process.env.APP_URL }),
      });
    } catch (err) {
      await logError({ endpoint: 'inbound-email:confirmation', error: err, session: sender, extra: { emailId } });
    }
  }

  // ── Step 6: fetch the full body (metadata-only webhook payload — see
  // this file's own header comment). emailBody is kept SEPARATE from
  // emailText (subject+body joined, what the parser wants) — the reply
  // detector below needs the body's own first line in isolation, not a
  // string that starts with the subject line again. ──
  let emailText, emailSubject, emailBody;
  try {
    const r = await fetch(`https://api.resend.com/emails/receiving/${emailId}`, {
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
    });
    if (!r.ok) throw new Error(`Resend receiving-email fetch failed: HTTP ${r.status}`);
    const full = await r.json();
    emailSubject = full.subject || '';
    emailBody = full.text || full.html || '';
    emailText = [full.subject, emailBody].filter(Boolean).join('\n\n');
    if (!emailText.trim()) throw new Error('Fetched email had no subject or body content');
  } catch (err) {
    await logError({ endpoint: 'inbound-email', error: err, session: sender, extra: { emailId } });
    return res.status(500).json({ error: err.message });
  }

  // ── Step 6.5 (service@ only): is this a CONFIRM/NEW reply to a pending
  // close-match item? Runs BEFORE the parser — no Anthropic cost for a
  // plain "CONFIRM" reply — and, when recognized, completely replaces the
  // normal parse-and-create flow for this email. Returns null (falls
  // through to the normal parse below) whenever this sender has nothing
  // pending, or the email doesn't look like a reply at all. ──
  if (isService) {
    let replyResult;
    try {
      replyResult = await resolvePendingServiceReply(supabase, sender, emailSubject, emailBody);
    } catch (err) {
      await logError({ endpoint: 'inbound-email', error: err, session: sender, extra: { emailId } });
      return res.status(500).json({ error: err.message });
    }
    if (replyResult) {
      await markProcessed(supabase, emailId, { kind, outcome: replyResult.resolved ? `reply-${replyResult.action}` : 'reply-ambiguous' });
      await sendConfirmation(replyResult.resolved, replyResult.body);
      return res.status(200).json({ ok: true, outcome: replyResult.resolved ? `reply-${replyResult.action}` : 'reply-ambiguous' });
    }
  }

  // ── Step 7: parse — reuses the existing, already-tested Task Assignments
  // parser wholesale (see process-transcript.js's own comment on why this
  // function is now exported), never a re-implementation. Used for BOTH
  // task@ and service@ — see createServicesFromParsed()'s own comment on
  // why there's no separate service-extraction prompt. ──
  const parseResult = await parseTaskEmailForSession(sender, emailText);
  if (parseResult.status !== 200) {
    // A definitive "nothing to create" outcome (bad/incomplete model JSON,
    // too-long input) is reported back to the sender and marked processed
    // — retrying would produce the identical result. A genuine
    // infrastructure failure (Anthropic/network) is NOT marked processed,
    // so a Resend retry can still succeed later.
    const definitive = parseResult.status === 422 || (parseResult.status === 500 && /invalid JSON/i.test(parseResult.body?.error || ''));
    if (definitive) {
      await markProcessed(supabase, emailId, { kind, outcome: 'parse-failed', reason: parseResult.body?.error });
      await sendConfirmation(false, `Couldn't parse this email: ${parseResult.body?.error || 'unknown error'}`);
      return res.status(200).json({ ok: true, outcome: 'parse-failed' });
    }
    await logError({ endpoint: 'inbound-email', error: parseResult.body?.error || 'parse failed', session: sender, extra: { emailId } });
    return res.status(500).json({ error: parseResult.body?.error || 'Parse failed' });
  }

  const parsedTasks = parseResult.body.tasks || [];
  if (!parsedTasks.length) {
    await markProcessed(supabase, emailId, { kind, outcome: 'no-items-found' });
    await sendConfirmation(false, 'No tasks or services could be identified in this email.');
    return res.status(200).json({ ok: true, outcome: 'no-items-found' });
  }

  // ── Roster, for resolving a real display name onto each created row
  // (see nameForId()'s own comment on why this is needed at all). ──
  let roster;
  try {
    const [{ data: users, error: uErr }, { data: admins, error: aErr }] = await Promise.all([
      supabase.from('ops_users').select('id, data'),
      supabase.from('ops_admins').select('id, data'),
    ]);
    if (uErr) throw new Error(uErr.message);
    if (aErr) throw new Error(aErr.message);
    roster = { users: (users || []).map(r => ({ id: r.id, data: r.data })), admins: (admins || []).map(r => ({ id: r.id, data: r.data })) };
  } catch (err) {
    await logError({ endpoint: 'inbound-email', error: err, session: sender, extra: { emailId } });
    return res.status(500).json({ error: err.message });
  }

  // ── Step 8: write. ──
  try {
    if (isTask) {
      const { created, skippedAsDuplicate } = await createTasksFromParsed(supabase, parsedTasks, sender, roster);
      await markProcessed(supabase, emailId, { kind, createdCount: created.length, skippedAsDuplicateCount: skippedAsDuplicate.length });
      await sendConfirmation(created.length > 0, buildTaskConfirmationBody(created, skippedAsDuplicate));
    } else {
      const { createdExisting, createdNew, pendingConfirmDisplay, totalPendingAfter, unmatched } = await createServicesFromParsed(supabase, parsedTasks, sender, roster, emailId);
      const totalCreated = createdExisting.length + createdNew.length;
      await markProcessed(supabase, emailId, {
        kind,
        createdExistingCount: createdExisting.length,
        createdNewCount: createdNew.length,
        pendingConfirmCount: pendingConfirmDisplay.length,
        unmatchedCount: unmatched.length,
      });
      await sendConfirmation(
        totalCreated > 0 || pendingConfirmDisplay.length > 0,
        buildServiceConfirmationBody(createdExisting, createdNew, pendingConfirmDisplay, totalPendingAfter, unmatched)
      );
    }
  } catch (err) {
    // A write failure here is NOT marked processed — a retry should be
    // able to try the write again.
    await logError({ endpoint: 'inbound-email', error: err, session: sender, extra: { emailId } });
    return res.status(500).json({ error: err.message });
  }

  return res.status(200).json({ ok: true });
}

function buildTaskConfirmationBody(created, skippedAsDuplicate) {
  const lines = created.map(t => `• ${t.subject} → assigned to ${t.assigneeName || 'unassigned'}, due ${t.dueDate || 'no due date'}`);
  if (skippedAsDuplicate.length) {
    lines.push('', 'Not re-added (looked like an existing task already tracks this):');
    skippedAsDuplicate.forEach(d => lines.push(`• ${d.subject} → already tracked as "${d.mergeIntoSubject}"`));
  }
  return lines.join('\n');
}

function buildServiceConfirmationBody(createdExisting, createdNew, pendingConfirmDisplay, totalPendingAfter, unmatched) {
  const lines = [];
  createdExisting.forEach(s => lines.push(`• ${s.name} → ${s.clientName}, assigned to ${s.assigneeName || 'unassigned'}${s.due ? `, due ${s.due}` : ''} (matched your existing catalog entry)`));
  createdNew.forEach(s => lines.push(`• ${s.name} → ${s.clientName}, assigned to ${s.assigneeName || 'unassigned'}${s.due ? `, due ${s.due}` : ''}. Created new service "${s.name}" and added it to the catalog.`));
  if (pendingConfirmDisplay.length) {
    const numbered = totalPendingAfter > 1;
    lines.push('', "Waiting on you — these looked like an existing catalog service, but weren't an exact match:");
    pendingConfirmDisplay.forEach(p => {
      const n = numbered ? ` ${p.displayIndex}` : '';
      lines.push(`"${p.parsedName}" looks like your existing "${p.matchedService.name}" — reply CONFIRM${n} to use it, or NEW${n} to create a separate service.`);
    });
  }
  if (unmatched.length) {
    lines.push('', "Couldn't create (no client could be identified):");
    unmatched.forEach(u => lines.push(`• ${u.subject}`));
  }
  return lines.join('\n');
}
