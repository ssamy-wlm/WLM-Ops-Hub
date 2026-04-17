import Anthropic from '@anthropic-ai/sdk';

const VALID_CATEGORIES = ['hr','finance','security','systems','production','clients','personal','operations','marketing','sales'];

const SYSTEM_PROMPT = `You are a planning assistant for a small business called Weblight Media. Read this meeting transcript and extract every task, action item, goal, or idea mentioned.

Sort each item into one of these buckets based on urgency:
- "7": critical or overdue, must happen within the week
- "30": urgent, needed within the month
- "60": medium-term, 1-2 months out
- "90": longer runway, no immediate pressure
- "dream": big picture, long-term vision, someday goals

Identify who owns each task:
- "sarah" if owned by Sarah
- "david" if owned by David
- "both" if it is a shared responsibility

Assign one category to each task from this list:
- "hr" — hiring, compensation, onboarding, team management
- "finance" — payments, payroll, invoices, budget
- "security" — passwords, access, VPN, protocols
- "systems" — tools, software, automations, integrations
- "production" — design, development, content creation, delivery
- "clients" — client work, deliverables, communication
- "personal" — personal goals, equipment, self-development
- "operations" — internal processes, SOPs, meetings, scheduling
- "marketing" — ads, social media, outreach, branding
- "sales" — leads, pipelines, proposals, follow-ups

Always spell these names and terms correctly: Servpro, Wuzzuf, Rania, Weblight Media, Candidates, GoHighLevel.

Return ONLY valid JSON, no markdown, no explanation:
{"tasks":[{"bucket":"30","text":"Concise task description under 10 words","owner":"sarah","category":"hr"}],"summary":"One sentence about what this meeting covered."}`;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-claude-api-key');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
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
    } catch {
      return res.status(500).json({ error: 'Claude returned invalid JSON. Raw: ' + raw.slice(0, 300) });
    }

    const tasks   = Array.isArray(parsed.tasks) ? parsed.tasks : [];
    const summary = typeof parsed.summary === 'string' ? parsed.summary : '';

    const valid = tasks.filter(t =>
      t && typeof t.text === 'string' && t.text.trim() &&
      ['7', '30', '60', '90', 'dream'].includes(t.bucket) &&
      ['sarah', 'david', 'both'].includes(t.owner)
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
    return res.status(500).json({ error: err.message || 'Anthropic API call failed' });
  }
}
