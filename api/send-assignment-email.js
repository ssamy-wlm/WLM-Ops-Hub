// Sends an "assigned work" notification email via Resend (https://resend.com).
// Requires RESEND_API_KEY (and optionally RESEND_FROM_EMAIL) set as Vercel env vars.

import { buildEmailHtml, sendResendEmail } from '../lib/resendClient.js';
import { logError } from '../lib/errorLog.js';
import { requireSession, tierOf } from '../lib/opsSession.js';
import { getSupabaseAdmin } from '../lib/supabaseAdmin.js';
import { isWithinQuietHours } from '../lib/quietHours.js';

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
  try { session = await requireSession(req); }
  catch (err) { await logError({ endpoint: 'send-assignment-email', error: err }); return res.status(500).json({ error: err.message }); }
  if (!session) return res.status(401).json({ error: 'Missing or invalid session' });
  if (tierOf(session) === 'member') return res.status(403).json({ error: 'Admin only' });

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'RESEND_API_KEY is not configured on the server.' });
  }

  // recipientId/recipientKind (2026-09-13, both optional): passed by the
  // real automated caller (index.html's _emailUserAssignment(), which
  // already knows the assignee's own record) so this endpoint can resolve
  // THAT person's team and apply the same per-team weekend quiet hours
  // every other notification email in this codebase now respects. Omitted
  // by the Admin Controls "Send Test Email" diagnostic tool
  // (sendTestAssignmentEmail() in index.html), which sends to an arbitrary
  // typed address with no linked record at all — team is genuinely not
  // resolvable there, so a request with no recipientId is NEVER suppressed,
  // the same way api/cron-backup.js's own backup email is never suppressed:
  // a deliberate, on-demand action, not a scheduled/automatic notification.
  const { to, name, title, body, link, recipientId, recipientKind } = req.body || {};
  if (!to || typeof to !== 'string' || !to.includes('@')) {
    return res.status(400).json({ error: 'A valid "to" email address is required' });
  }
  if (!title || typeof title !== 'string') {
    return res.status(400).json({ error: '"title" is required' });
  }

  if (recipientId && (recipientKind === 'user' || recipientKind === 'admin')) {
    try {
      const supabase = getSupabaseAdmin();
      const table = recipientKind === 'admin' ? 'ops_admins' : 'ops_users';
      const { data: row } = await supabase.from(table).select('data').eq('id', recipientId).maybeSingle();
      if (isWithinQuietHours(row?.data?.team, new Date())) {
        return res.status(200).json({ ok: true, suppressed: true });
      }
    } catch (err) {
      // Never let a quiet-hours lookup failure block a real assignment
      // email from sending — fail open here, same non-fatal discipline
      // every other best-effort check in this codebase already follows.
      await logError({ endpoint: 'send-assignment-email:quietHours', error: err, extra: { recipientId } });
    }
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
