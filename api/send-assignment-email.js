// Sends an "assigned work" notification email via Resend (https://resend.com).
// Requires RESEND_API_KEY (and optionally RESEND_FROM_EMAIL) set as Vercel env vars.

import { buildEmailHtml, sendResendEmail } from '../lib/resendClient.js';
import { logError } from '../lib/errorLog.js';
import { requireSession, tierOf } from '../lib/opsSession.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let session;
  try { session = requireSession(req); }
  catch (err) { await logError({ endpoint: 'send-assignment-email', error: err }); return res.status(500).json({ error: err.message }); }
  if (!session) return res.status(401).json({ error: 'Missing or invalid session' });
  if (tierOf(session) === 'member') return res.status(403).json({ error: 'Admin only' });

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'RESEND_API_KEY is not configured on the server.' });
  }

  const { to, name, title, body, link } = req.body || {};
  if (!to || typeof to !== 'string' || !to.includes('@')) {
    return res.status(400).json({ error: 'A valid "to" email address is required' });
  }
  if (!title || typeof title !== 'string') {
    return res.status(400).json({ error: '"title" is required' });
  }

  const html = buildEmailHtml({ name, title, body, link });

  try {
    const data = await sendResendEmail({ to, subject: title, html });
    return res.status(200).json({ ok: true, id: data?.id });
  } catch (err) {
    await logError({ endpoint: 'send-assignment-email', error: err, extra: { to } });
    return res.status(500).json({ error: err.message || 'Failed to send email' });
  }
}
