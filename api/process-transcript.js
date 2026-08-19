import Anthropic from '@anthropic-ai/sdk';
import { logError } from '../lib/errorLog.js';
import { getSupabaseAdmin } from '../lib/supabaseAdmin.js';
import { requireSession, tierOf } from '../lib/opsSession.js';

const VALID_CATEGORIES = ['hr','finance','security','systems','production','clients','personal','operations','marketing','sales'];

// ── Task Assignments / Daily Tasks email-parsing mode (mode:'taskEmail' in
// the request body) — a completely separate feature from the Roadmap
// meeting-transcript extractor above/below, sharing this file only because
// this app is capped at 12 serverless functions (Vercel Hobby plan) and
// this was the closest existing "paste text, get structured JSON back from
// Claude" endpoint. Unlike the Roadmap mode (an optional, loosely-checked
// static API key), this mode requires a REAL signed ops session — every
// caller (admin or employee) must be logged in, since the extracted tasks
// get written into ops_tasks via api/ops-sync.js under that same identity.
// The Roadmap mode's own request handling below is completely untouched. ──
const TASK_CATEGORIES = ['Production', 'Updates', 'Sales', 'Admin', 'Other', 'Invoices/Payments'];
const TASK_TYPES = ['Task', 'Client Update', 'New Service', 'New Sale', 'Follow-up'];
const TASK_PRIORITIES = ['Urgent', 'High', 'Normal', 'Low'];

// Built fresh per request from the LIVE active roster (see activeRoster()
// below) — deliberately NOT a static list of example names baked into the
// prompt. A stale hardcoded roster is exactly the failure mode the Roadmap
// mode's own SYSTEM_PROMPT below has (a fixed "sarah/david/emily/jacob/
// rania" example list) — someone hired or renamed after this file was last
// edited would never be extractable as an owner. Every call rebuilds this
// list from ops_users/ops_admins, so it can never drift from who's actually
// on the team right now.
function buildTaskEmailSystemPrompt(rosterDisplayList) {
  return `You extract action items from an email or pasted transcript for a small marketing agency called Weblight Media, for a work-tracking tool. The text may be a raw .eml file (with visible headers like From/Subject/Date) or a plain pasted email/transcript.

For EACH distinct task or action item you find:
- "subject": a concise one-line summary (under 12 words).
- "notes": any additional relevant detail from the text (can be empty string).
- "tags": an array of short relevant keyword strings (can be empty array).
- "category": exactly one of ${JSON.stringify(TASK_CATEGORIES)} — "Invoices/Payments" for billing/invoice/payment items, "Other" only if truly nothing else fits.
- "type": exactly one of ${JSON.stringify(TASK_TYPES)}.
- "priority": exactly one of ${JSON.stringify(TASK_PRIORITIES)} — infer from urgency language, default "Normal" if unclear.
- "dueDate": an ISO YYYY-MM-DD date if one is mentioned or clearly implied, otherwise empty string.
- "senderEmail": the sender's email address if the text contains one (e.g. a "From:" header), otherwise empty string.
- "senderName": the sender's display name if available, otherwise empty string.
- "emailReceivedDate": an ISO YYYY-MM-DD date from a "Date:" header or explicit date in the text, otherwise empty string.
- "emailThreadId": a Message-ID header value if present, otherwise empty string.
- "ownerName": if the text clearly assigns this specific task to one specific person on the team, that person's name EXACTLY as it appears (the part before " — ", their title is shown after it only to help you tell people with the same role apart) in this list: ${JSON.stringify(rosterDisplayList)}. Otherwise empty string. Never invent or guess a name that isn't in this exact list, and never use a role/title in place of a name — if the text names a role but not a specific person ("someone from production"), leave this empty rather than picking a name.
- "alreadyDone": true if the text itself says this specific item is already finished/sent/completed (e.g. "already posted the update", "done", "sent yesterday"), false otherwise. Only true when the text says so explicitly for THIS item — never infer completion just because a task sounds simple or routine.

If the text contains no actionable task at all, return an empty tasks array — do not invent one.

Return ONLY valid JSON, no markdown, no explanation:
{"tasks":[{"subject":"...","notes":"...","tags":[],"category":"Production","type":"Task","priority":"Normal","dueDate":"","senderEmail":"","senderName":"","emailReceivedDate":"","emailThreadId":"","ownerName":"","alreadyDone":false}]}`;
}

// Live, active-only roster (users + admins together — an admin like Abby
// does real production work too, same combined-roster convention as
// index.html's _timeOffRoster()/loadTaskAssignments() assignee dropdown).
// Fetched fresh every request; never cached across requests, unlike the
// per-request _directoryCache pattern in api/ops-sync.js (this is a single
// short-lived serverless invocation, not a warm-instance-reused module).
async function activeRoster(supabase) {
  const [{ data: userRows, error: uErr }, { data: adminRows, error: aErr }] = await Promise.all([
    supabase.from('ops_users').select('id, data'),
    supabase.from('ops_admins').select('id, data'),
  ]);
  const firstErr = uErr || aErr;
  if (firstErr) throw new Error(firstErr.message);
  const users = (userRows || []).map(r => ({ id: r.id, kind: 'user', ...r.data })).filter(u => u.status === 'active' && u.name);
  const admins = (adminRows || []).map(r => ({ id: r.id, kind: 'admin', ...r.data })).filter(a => a.status === 'active' && a.name);
  return [...users, ...admins];
}

// Deterministic, same "plain code, never ask the model to guess" convention
// as matchClient() below. Exact full-name match first; otherwise a
// first-name match, but ONLY if it's unambiguous (exactly one roster member
// shares that first name) — two "Sarah"s on the roster must never resolve
// to a coin-flip.
function matchOwner(ownerName, roster) {
  const q = String(ownerName || '').trim().toLowerCase();
  if (!q) return null;
  const exact = roster.find(p => String(p.name || '').trim().toLowerCase() === q);
  if (exact) return exact;
  const byFirstName = roster.filter(p => String(p.name || '').trim().split(/\s+/)[0].toLowerCase() === q);
  return byFirstName.length === 1 ? byFirstName[0] : null;
}

// Who a non-admin caller is allowed to see/create tasks for: themselves,
// plus anyone whose configured manager (users[].managerId — the same field
// index.html's assignment-escalation notifications already read) is this
// caller. This is what makes a manager-tier employee (e.g. Sherine, who has
// no special admin/super tier of her own — she's a plain member whom other
// members' managerId happens to point at) distinct from an individual
// contributor (e.g. Rana, Michael) with no reports: the exact same formula
// just yields {self} when nobody's managerId points at them. Admin/super
// tier is unrestricted, same as everywhere else in this app.
function callerTaskScope(session, roster) {
  const tier = tierOf(session);
  if (tier !== 'member') return { isAdmin: true, allowedIds: null };
  const reportIds = roster.filter(p => p.managerId === session.id).map(p => p.id);
  return { isAdmin: false, allowedIds: new Set([session.id, ...reportIds]) };
}

function extractDomain(email) {
  const m = /@([^\s>]+)/.exec(String(email || ''));
  return m ? m[1].toLowerCase() : '';
}

function domainOf(url) {
  const m = /^(?:https?:\/\/)?(?:www\.)?([^/\s]+)/i.exec(String(url || ''));
  return m ? m[1].toLowerCase() : '';
}

// Deterministic, not LLM-guessed — a wrong auto-match here would silently
// attach a task (and whatever it references) to the wrong client, so this
// stays plain code the same way every other client-matching decision in
// this app is server-side and reviewable, never "ask the model to guess."
// Checked in order: exact sender-email match against the client's salvaged
// clientEmails[]/legacy clientEmail, then a case-insensitive sender-name
// vs client-name match, then a sender-domain vs client-website-domain
// match. No match at any step leaves the task unlinked — an admin assigns
// the client manually in the UI rather than the system guessing wrong.
function matchClient(task, activeClients) {
  const senderEmail = String(task.senderEmail || '').toLowerCase().trim();
  const senderDomain = extractDomain(senderEmail);
  const senderName = String(task.senderName || '').toLowerCase().trim();
  if (senderEmail) {
    const byEmail = activeClients.find(c =>
      (Array.isArray(c.clientEmails) && c.clientEmails.some(e => String(e).toLowerCase().trim() === senderEmail)) ||
      String(c.clientEmail || '').toLowerCase().trim() === senderEmail
    );
    if (byEmail) return byEmail;
  }
  if (senderName) {
    const byName = activeClients.find(c => String(c.name || '').toLowerCase().trim() === senderName);
    if (byName) return byName;
  }
  if (senderDomain) {
    const byDomain = activeClients.find(c => domainOf(c.website) && domainOf(c.website) === senderDomain);
    if (byDomain) return byDomain;
  }
  return null;
}

const STOPWORDS = new Set(['a','an','the','to','for','of','on','in','and','or','with','is','are','be','this','that']);
function subjectTokens(subject) {
  return String(subject || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w && !STOPWORDS.has(w));
}
// Plain token-overlap (Jaccard) similarity, not an LLM judgment call — same
// "deterministic, reviewable" conviction as matchClient/matchOwner. Two
// subjects are "clearly the same work" only when most of their significant
// words overlap; this deliberately doesn't try to be clever about synonyms
// or paraphrasing — a near-miss stays a separate task rather than risking a
// wrong merge onto someone's real tracked work.
function subjectSimilarity(a, b) {
  const ta = new Set(subjectTokens(a)), tb = new Set(subjectTokens(b));
  if (!ta.size || !tb.size) return 0;
  let overlap = 0;
  for (const w of ta) if (tb.has(w)) overlap++;
  return overlap / new Set([...ta, ...tb]).size;
}
const SUBJECT_SIMILARITY_THRESHOLD = 0.6;
// "Same task" requires BOTH a strong subject match AND agreement on client
// and assignee — a similar-sounding subject about a DIFFERENT client is
// never treated as the same work, no matter how close the wording is.
function isSameTask(a, b) {
  if ((a.clientId || null) !== (b.clientId || null)) return false;
  if ((a.assigneeId || null) !== (b.assigneeId || null)) return false;
  return subjectSimilarity(a.subject, b.subject) >= SUBJECT_SIMILARITY_THRESHOLD;
}

// Collapses duplicates WITHIN one parse response — e.g. four pasted
// meeting transcripts all mentioning the same follow-up. Merging is purely
// additive: notes are concatenated (never dropped), tags unioned, the
// earliest non-empty due date wins, and alreadyDone is true if ANY of the
// merged mentions says so. Never touches anything already in storage —
// this only ever combines candidates that don't exist yet.
function dedupeWithinBatch(tasks) {
  const kept = [];
  for (const t of tasks) {
    const existing = kept.find(k => isSameTask(k, t));
    if (!existing) { kept.push({ ...t }); continue; }
    if (t.notes && t.notes !== existing.notes) existing.notes = existing.notes ? `${existing.notes}\n${t.notes}` : t.notes;
    existing.tags = [...new Set([...(existing.tags || []), ...(t.tags || [])])];
    if (!existing.dueDate && t.dueDate) existing.dueDate = t.dueDate;
    existing.alreadyDone = existing.alreadyDone || t.alreadyDone;
  }
  return kept;
}

async function handleTaskEmailMode(req, res) {
  let session;
  try { session = await requireSession(req); }
  catch (err) { await logError({ endpoint: 'process-transcript:taskEmail', error: err }); return res.status(500).json({ error: err.message }); }
  if (!session) return res.status(401).json({ error: 'Missing or invalid session' });

  const { text } = req.body || {};
  if (!text || typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'text is required' });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    await logError({ endpoint: 'process-transcript:taskEmail', error: 'ANTHROPIC_API_KEY is not configured on the server.', session });
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY is not configured on the server.' });
  }

  let supabase;
  try { supabase = getSupabaseAdmin(); }
  catch (err) { await logError({ endpoint: 'process-transcript:taskEmail', error: err, session }); return res.status(500).json({ error: err.message }); }

  // Roster + client-matching data are fetched BEFORE calling the model, not
  // after — the roster feeds the prompt itself (see buildTaskEmailSystemPrompt),
  // and the caller's scope (below) is derived from this same live data,
  // never from anything the request body claims about the caller's role.
  let activeClients, roster, scope, existingOpenTasks;
  try {
    const [{ data: clientRows, error: clientErr }, rosterList, { data: taskRows, error: taskErr }] = await Promise.all([
      // Active clients ONLY — an inactive/archived client can never be
      // auto-matched or assigned a parsed task (CLAUDE.md-required
      // constraint for this feature).
      supabase.from('ops_clients').select('id, status, data').eq('status', 'active'),
      activeRoster(supabase),
      // Existing NOT-done tasks — dedupe/merge candidates for the pass
      // below. A task already marked Done is never a merge target: the
      // point is to stop a still-open item from getting duplicated, not to
      // reopen something already finished.
      supabase.from('ops_tasks').select('id, data'),
    ]);
    if (clientErr) throw new Error(clientErr.message);
    if (taskErr) throw new Error(taskErr.message);
    activeClients = (clientRows || []).map(r => ({ id: r.id, ...r.data }));
    roster = rosterList;
    scope = callerTaskScope(session, roster);
    existingOpenTasks = (taskRows || [])
      .map(r => ({ id: r.id, ...r.data }))
      .filter(t => t.status !== 'Done');
  } catch (err) {
    await logError({ endpoint: 'process-transcript:taskEmail', error: err, session });
    return res.status(500).json({ error: err.message });
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  try {
    const message = await client.messages.create({
      model: 'claude-opus-4-7',
      max_tokens: 4096,
      system: buildTaskEmailSystemPrompt(roster.map(p => {
        const title = p.title || p.level;
        return title ? `${p.name} — ${title}` : p.name;
      })),
      messages: [{ role: 'user', content: text.trim() }],
    });

    const raw = message.content[0]?.text || '{}';
    let parsed;
    try {
      const cleaned = raw.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim();
      parsed = JSON.parse(cleaned);
    } catch (parseErr) {
      await logError({ endpoint: 'process-transcript:taskEmail', error: parseErr, session, extra: { raw: raw.slice(0, 300) } });
      return res.status(500).json({ error: 'Claude returned invalid JSON. Raw: ' + raw.slice(0, 300) });
    }

    const rawTasks = Array.isArray(parsed.tasks) ? parsed.tasks : [];

    // Owner-matching and the role-scoped filter below run over EVERY
    // extracted task before any of it is returned — a member/manager-tier
    // caller never even receives an out-of-scope task in the HTTP response,
    // let alone gets a chance to import it. This is enforcement, not just
    // UX: the client sent nothing about its own role in the request body
    // (mode/text only), so there is nothing here for a modified client to
    // spoof — the scope above came entirely from the signed session token.
    const tasks = rawTasks
      .filter(t => t && typeof t.subject === 'string' && t.subject.trim())
      .map(t => {
        const matchedClient = matchClient(t, activeClients);
        const owner = matchOwner(t.ownerName, roster);
        return {
          subject: t.subject.trim(),
          notes: typeof t.notes === 'string' ? t.notes : '',
          tags: Array.isArray(t.tags) ? t.tags.filter(x => typeof x === 'string') : [],
          category: TASK_CATEGORIES.includes(t.category) ? t.category : 'Other',
          type: TASK_TYPES.includes(t.type) ? t.type : 'Task',
          priority: TASK_PRIORITIES.includes(t.priority) ? t.priority : 'Normal',
          dueDate: typeof t.dueDate === 'string' ? t.dueDate : '',
          clientId: matchedClient ? matchedClient.id : null,
          clientName: matchedClient ? matchedClient.name : '',
          source: 'parsed-email',
          emailReceivedDate: typeof t.emailReceivedDate === 'string' ? t.emailReceivedDate : '',
          emailThreadId: typeof t.emailThreadId === 'string' ? t.emailThreadId : '',
          assigneeId: owner ? owner.id : null,
          alreadyDone: t.alreadyDone === true,
        };
      })
      .filter(t => {
        if (scope.isAdmin) return true;
        if (t.assigneeId) return scope.allowedIds.has(t.assigneeId);
        // No owner identified at all — default it to the caller themselves
        // rather than dropping it, matching how api/ops-sync.js already
        // treats an unassigned member-created task (forced to self); an
        // admin's unmatched tasks are left null so they get manually
        // assigned instead, same as before this change.
        t.assigneeId = session.id;
        return true;
      });

    // Collapse duplicates mentioned more than once across the pasted
    // text (e.g. four transcripts all referencing the same follow-up)
    // BEFORE ever comparing against what's already stored — a candidate
    // that's a duplicate of another candidate should merge with THAT one
    // first, not independently match the same existing task twice.
    const deduped = dedupeWithinBatch(tasks);

    // Match each surviving candidate against existing NOT-done tasks
    // within this caller's own scope — an admin can merge into anyone's
    // task, a member/manager-tier caller only into one already visible to
    // them (self, or a direct report), same allowedIds used above. A
    // match never overwrites the existing task's stored data here — it
    // only tells the client WHICH existing row to update instead of
    // inserting a new one; the client performs a narrow, additive merge
    // (see runTaskEmailParse/runDtEmailParse), never a full overwrite.
    const scopedExistingTasks = scope.isAdmin
      ? existingOpenTasks
      : existingOpenTasks.filter(t => scope.allowedIds.has(t.assigneeId));
    const finalTasks = deduped.map(t => {
      const match = scopedExistingTasks.find(ex => isSameTask(ex, t));
      return {
        ...t,
        status: t.alreadyDone ? 'Done' : 'Not started',
        mergeIntoId: match ? match.id : null,
        mergeIntoSubject: match ? match.subject : '',
      };
    });

    return res.status(200).json({ tasks: finalTasks, raw_count: rawTasks.length });
  } catch (err) {
    console.error('Anthropic API error (taskEmail):', err);
    await logError({ endpoint: 'process-transcript:taskEmail', error: err, session });
    return res.status(500).json({ error: err.message || 'Anthropic API call failed' });
  }
}

const SYSTEM_PROMPT = `You are a planning assistant for a small business called Weblight Media. Read this meeting transcript and extract every task, action item, goal, or idea mentioned.

IMPORTANT — SKIP the following entirely (do not include them as tasks):
- Personal notes, personal reminders, or personal to-dos (e.g. "I need to buy groceries", "remind me to call my dentist")
- Off-topic side comments unrelated to Weblight Media business

Sort each item into one of these buckets based on urgency:
- "7": critical or overdue, must happen within the week
- "30": urgent, needed within the month
- "60": medium-term, 1-2 months out
- "90": longer runway, no immediate pressure
- "dream": big picture, long-term vision, someday goals

Identify who owns each task. Use the person's first name in lowercase (e.g. "sarah", "david", "emily", "jacob", "rania"). Use "both" only if Sarah AND David share responsibility. If someone else on the team owns it, use their first name in lowercase. Never leave owner blank.

Assign one category to each task from this list:
- "hr" — hiring, compensation, onboarding, team management
- "finance" — payments, payroll, invoices, budget
- "security" — passwords, access, VPN, protocols
- "systems" — tools, software, automations, integrations
- "production" — design, development, content creation, delivery
- "clients" — client work, deliverables, communication
- "operations" — internal processes, SOPs, meetings, scheduling
- "marketing" — ads, social media, outreach, branding
- "sales" — leads, pipelines, proposals, follow-ups

Always spell these names and terms correctly: Servpro, Wuzzuf, Rania, Weblight Media, Candidates, GoHighLevel.

Return ONLY valid JSON, no markdown, no explanation:
{"tasks":[{"bucket":"30","text":"Concise task description under 10 words","owner":"sarah","category":"hr"}],"summary":"One sentence about what this meeting covered."}`;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-claude-api-key, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method === 'POST' && req.body?.mode === 'taskEmail') {
    return handleTaskEmailMode(req, res);
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKeyHeader = req.headers['x-claude-api-key'];
  const expectedKey  = process.env.CLAUDE_ROADMAP_KEY;
  if (apiKeyHeader && expectedKey && apiKeyHeader !== expectedKey) {
    return res.status(403).json({ error: 'Invalid API key' });
  }

  const { transcript, meeting_name, meeting_date } = req.body || {};
  if (!transcript || typeof transcript !== 'string' || !transcript.trim()) {
    return res.status(400).json({ error: 'transcript is required' });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    await logError({ endpoint: 'process-transcript', error: 'ANTHROPIC_API_KEY is not configured on the server.' });
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY is not configured on the server.' });
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const userMessage = `Meeting: ${meeting_name || 'Untitled Meeting'}
Date: ${meeting_date || new Date().toISOString().slice(0, 10)}

TRANSCRIPT:
${transcript.trim()}`;

  try {
    const message = await client.messages.create({
      model: 'claude-opus-4-7',
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    });

    const raw = message.content[0]?.text || '{}';

    let parsed;
    try {
      const cleaned = raw.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim();
      parsed = JSON.parse(cleaned);
    } catch (parseErr) {
      await logError({ endpoint: 'process-transcript', error: parseErr, extra: { raw: raw.slice(0, 300) } });
      return res.status(500).json({ error: 'Claude returned invalid JSON. Raw: ' + raw.slice(0, 300) });
    }

    const tasks   = Array.isArray(parsed.tasks) ? parsed.tasks : [];
    const summary = typeof parsed.summary === 'string' ? parsed.summary : '';

    const valid = tasks.filter(t =>
      t && typeof t.text === 'string' && t.text.trim() &&
      ['7', '30', '60', '90', 'dream'].includes(t.bucket) &&
      typeof t.owner === 'string' && /^[a-z]{2,30}$/.test(t.owner) &&
      t.category !== 'personal'
    ).map(t => ({
      bucket:      t.bucket,
      text:        t.text.trim(),
      owner:       t.owner,
      category:    VALID_CATEGORIES.includes(t.category) ? t.category : '',
      source:      meeting_name || 'Untitled Meeting',
      source_date: meeting_date || new Date().toISOString().slice(0, 10),
    }));

    return res.status(200).json({ tasks: valid, summary, raw_count: tasks.length });
  } catch (err) {
    console.error('Anthropic API error:', err);
    await logError({ endpoint: 'process-transcript', error: err });
    return res.status(500).json({ error: err.message || 'Anthropic API call failed' });
  }
}
