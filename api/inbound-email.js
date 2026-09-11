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

// Services always belong to a client in this app's data model (rule #7 —
// never invent a client-less record) — a parsed row with no matched client
// is never written, only reported back as unmatched. This is deliberately
// a MINIMAL service shape, not the full catalog-linked one client.html's
// own Add Service modal builds: this endpoint reuses the exact same
// task-extraction schema/prompt for BOTH addresses (there is no separate
// service-extraction prompt in this codebase — building one was judged
// out of scope for a first pass, flagged explicitly in this PR's own
// CLAUDE.md entry), so there is no signal for frequency/bundle/catalog
// linkage at all — every email-created service is `freq:'one-time'`,
// the safest default and already a real, supported frequency value in
// this app. Read-modify-write on the whole client row, extending ONLY
// `services[]` — every other field of the client record passes through
// completely untouched, the same non-destructive discipline
// preserveMissingClientFields() established for the browser write path
// (api/ops-sync.js, 2026-08-24), just applied here since this endpoint
// writes directly rather than through that shared merge function.
async function createServicesFromParsed(supabase, parsedTasks, sender, roster) {
  const created = [];
  const unmatched = [];
  const byClient = new Map();
  for (const t of parsedTasks) {
    if (!t.clientId) { unmatched.push({ subject: t.subject }); continue; }
    if (!byClient.has(t.clientId)) byClient.set(t.clientId, []);
    byClient.get(t.clientId).push(t);
  }
  for (const [clientId, group] of byClient) {
    const { data: clientRow, error: readErr } = await supabase.from('ops_clients').select('id, data').eq('id', clientId).maybeSingle();
    if (readErr) throw new Error(readErr.message);
    if (!clientRow) { group.forEach(t => unmatched.push({ subject: t.subject })); continue; }
    const newServices = group.map(t => ({
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
    }));
    const updatedData = { ...clientRow.data, services: [...(clientRow.data.services || []), ...newServices] };
    const { error: writeErr } = await supabase.from('ops_clients').update({ data: updatedData }).eq('id', clientId);
    if (writeErr) throw new Error(writeErr.message);
    // clientRow.data.name is the authoritative source here (the real,
    // just-read client record) — never the parser's own clientName guess,
    // which is only ever used to FIND clientId in the first place.
    newServices.forEach(s => created.push({ ...s, clientId, clientName: clientRow.data?.name || '' }));
  }
  return { created, unmatched };
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
  // this file's own header comment). ──
  let emailText;
  try {
    const r = await fetch(`https://api.resend.com/emails/receiving/${emailId}`, {
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
    });
    if (!r.ok) throw new Error(`Resend receiving-email fetch failed: HTTP ${r.status}`);
    const full = await r.json();
    emailText = [full.subject, full.text || full.html || ''].filter(Boolean).join('\n\n');
    if (!emailText.trim()) throw new Error('Fetched email had no subject or body content');
  } catch (err) {
    await logError({ endpoint: 'inbound-email', error: err, session: sender, extra: { emailId } });
    return res.status(500).json({ error: err.message });
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
      const { created, unmatched } = await createServicesFromParsed(supabase, parsedTasks, sender, roster);
      await markProcessed(supabase, emailId, { kind, createdCount: created.length, unmatchedCount: unmatched.length });
      await sendConfirmation(created.length > 0, buildServiceConfirmationBody(created, unmatched));
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
function buildServiceConfirmationBody(created, unmatched) {
  const lines = created.map(s => `• ${s.name} → ${s.clientName}, assigned to ${s.assigneeName || 'unassigned'}${s.due ? `, due ${s.due}` : ''}`);
  if (unmatched.length) {
    lines.push('', "Couldn't create (no client could be identified):");
    unmatched.forEach(u => lines.push(`• ${u.subject}`));
  }
  return lines.join('\n');
}
