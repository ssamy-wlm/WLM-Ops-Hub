import Anthropic from '@anthropic-ai/sdk';
import { logError } from '../lib/errorLog.js';
import { getSupabaseAdmin } from '../lib/supabaseAdmin.js';
import { requireSession } from '../lib/opsSession.js';

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

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// A reference date is required for relative-language resolution ("by
// Friday", "next week", "end of month") — the model has no other way to
// know what day "today" is. Computed fresh per request from the real
// clock, never hardcoded — this is plain server-side Date usage (not a
// Workflow script, where Date.now()/new Date() are restricted).
function buildTaskEmailSystemPrompt() {
  const now = new Date();
  const todayIso = now.toISOString().slice(0, 10);
  const weekday = WEEKDAY_NAMES[now.getUTCDay()];
  return `You extract action items from an email or pasted transcript for a small marketing agency called Weblight Media, for a work-tracking tool. The text may be a raw .eml file (with visible headers like From/Subject/Date) or a plain pasted email/transcript.

Today's date is ${todayIso} (a ${weekday}). Use this as the reference point for any relative date language in the text.

For EACH distinct task or action item you find:
- "subject": a concise one-line summary (under 12 words).
- "notes": any additional relevant detail from the text (can be empty string).
- "tags": an array of short relevant keyword strings (can be empty array).
- "category": exactly one of ${JSON.stringify(TASK_CATEGORIES)} — "Invoices/Payments" for billing/invoice/payment items, "Other" only if truly nothing else fits.
- "type": exactly one of ${JSON.stringify(TASK_TYPES)}.
- "priority": exactly one of ${JSON.stringify(TASK_PRIORITIES)} — infer from urgency language, default "Normal" if unclear.
- "dueDate": an ISO YYYY-MM-DD date. Resolve relative language against today's date above: "by <weekday>" or "this <weekday>" means the very next occurrence of that weekday (today itself if today IS that weekday); "next <weekday>" means that weekday in the FOLLOWING week (never this week, even if that day hasn't happened yet this week); "next week" means next week's Monday; "end of month"/"end of the month" means the last calendar day of the CURRENT month; "tomorrow" and "today" mean exactly that; "in N days"/"in N weeks" means today plus that many days. If no due date is mentioned or clearly implied at all, return an empty string — never invent one just because a task exists.
- "senderEmail": the sender's email address if the text contains one (e.g. a "From:" header), otherwise empty string.
- "senderName": the sender's display name if available, otherwise empty string.
- "emailReceivedDate": an ISO YYYY-MM-DD date from a "Date:" header or explicit date in the text, otherwise empty string.
- "emailThreadId": a Message-ID header value if present, otherwise empty string.

If the text contains no actionable task at all, return an empty tasks array — do not invent one.

Return ONLY valid JSON, no markdown, no explanation:
{"tasks":[{"subject":"...","notes":"...","tags":[],"category":"Production","type":"Task","priority":"Normal","dueDate":"","senderEmail":"","senderName":"","emailReceivedDate":"","emailThreadId":""}]}`;
}

// A malformed or out-of-range date from the model must never reach storage
// or the sort below as if it were real — dropped to '' (same as "no due
// date mentioned") rather than crashing or silently corrupting the sort.
function validDueDate(value) {
  const m = typeof value === 'string' && /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return '';
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  // Date silently ROLLS OVER an out-of-range day/month (e.g. "2026-02-30"
  // becomes March 2) instead of producing an invalid Date — checking
  // getTime() alone would let that corrupted value through as if it were
  // real. Round-tripping the components back out and comparing catches it.
  const roundTrips = d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
  return roundTrips ? value : '';
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

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  try {
    const message = await client.messages.create({
      model: 'claude-opus-4-7',
      max_tokens: 4096,
      system: buildTaskEmailSystemPrompt(),
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

    let supabase;
    try { supabase = getSupabaseAdmin(); }
    catch (err) { await logError({ endpoint: 'process-transcript:taskEmail', error: err, session }); return res.status(500).json({ error: err.message }); }
    // Active clients ONLY — an inactive/archived client can never be
    // auto-matched or assigned a parsed task (CLAUDE.md-required constraint
    // for this feature).
    const { data: clientRows, error: clientErr } = await supabase.from('ops_clients').select('id, status, data').eq('status', 'active');
    if (clientErr) { await logError({ endpoint: 'process-transcript:taskEmail', error: clientErr, session }); return res.status(500).json({ error: clientErr.message }); }
    const activeClients = (clientRows || []).map(r => ({ id: r.id, ...r.data }));

    const tasks = rawTasks
      .filter(t => t && typeof t.subject === 'string' && t.subject.trim())
      .map(t => {
        const matched = matchClient(t, activeClients);
        return {
          subject: t.subject.trim(),
          notes: typeof t.notes === 'string' ? t.notes : '',
          tags: Array.isArray(t.tags) ? t.tags.filter(x => typeof x === 'string') : [],
          category: TASK_CATEGORIES.includes(t.category) ? t.category : 'Other',
          type: TASK_TYPES.includes(t.type) ? t.type : 'Task',
          priority: TASK_PRIORITIES.includes(t.priority) ? t.priority : 'Normal',
          dueDate: validDueDate(t.dueDate),
          clientId: matched ? matched.id : null,
          clientName: matched ? matched.name : '',
          source: 'parsed-email',
          emailReceivedDate: typeof t.emailReceivedDate === 'string' ? t.emailReceivedDate : '',
          emailThreadId: typeof t.emailThreadId === 'string' ? t.emailThreadId : '',
        };
      });

    return res.status(200).json({ tasks, raw_count: rawTasks.length });
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
