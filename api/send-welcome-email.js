// Sends the new-hire/new-admin welcome email directly to the person just
// created, via Resend — triggered ONLY by an explicit admin click on the
// "Send Invitation Email" button in index.html's invitation preview modal
// (sendWelcomeEmail() for members, _sendAdminWelcomeEmail() for admins).
// Never called on page load, on user creation itself, or from any
// timer/poll — CLAUDE.md rule #2's load-time/background-write ban has no
// bearing here since this endpoint doesn't write anything at all (see
// below), but the "never auto-fire" discipline still applies to WHEN it's
// invoked from the client.
//
// Previously, both invitation flows only built forward-to-Sarah text for
// the admin to copy/paste or open in their own mail client — nothing was
// ever actually sent. This endpoint is the real send: the new user's own
// welcome email, from the standard Ops Hub sender (no admin signature),
// plus a short best-effort confirmation back to the admin.
//
// Read-only with respect to app data — this only sends email. It never
// touches ops_users/ops_admins/any other table; a "welcomeEmailSentAt"
// stamp, if ever wanted, is a separate, explicitly-approved follow-up that
// would go through the normal per-record sync path (api/ops-sync.js), not
// a side effect bolted onto this endpoint.
import { buildEmailHtml, sendResendEmail } from '../lib/resendClient.js';
import { logError } from '../lib/errorLog.js';
import { requireSession, tierOf } from '../lib/opsSession.js';

const ADMIN_CONFIRMATION_EMAIL = 'ssamy@weblightmedia.com';

// Member wording — same substance as the old forward-to-Sarah body's inner
// "Subject: Welcome to WebLight Media..." block, minus the "Have a great
// day, Sarah Samy / Director of Systems & Operations" sign-off: this email
// now comes directly from the Ops Hub's own sender, not from Sarah, so a
// personal signature under a system-sent email would be misleading (the
// ticket's own explicit instruction — "not from the admin, no signature").
function buildMemberInviteBody({ title, email, password, hubUrl }) {
  return `Welcome to the team! 🎉

This is your official invitation to join our Operations Hub as ${title || 'a Team Member'} with WebLight Media.

Your login credentials are below:
🔗 Hub Link: ${hubUrl}
📧 Username: ${email}
🔑 Temporary Password: ${password}

Please log in at your earliest convenience and change your password to something you will remember.

If you run into any trouble logging in or have any questions, don't hesitate to reach out.
Looking forward to working with you!`;
}

// Admin wording — same substance as the old forward-to-Sarah body's inner
// block, same sign-off removal as above.
function buildAdminInviteBody({ title, email, password, hubUrl, levelLabel, levelDesc }) {
  return `Welcome to the team! 🎉

You have been granted ${levelLabel} access to the WebLight Media Operations Hub${title ? ' as ' + title : ''}.

Your login credentials are below:
🔗 Admin Panel: ${hubUrl}
📧 Username: ${email}
🔑 Temporary Password: ${password}
🔐 Access Level: ${levelLabel}${levelDesc ? ' — ' + levelDesc : ''}

Please log in at your earliest convenience and change your password on first login.

If you have any questions, don't hesitate to reach out.`;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let session;
  try { session = await requireSession(req); }
  catch (err) { await logError({ endpoint: 'send-welcome-email', error: err }); return res.status(500).json({ error: err.message }); }
  if (!session) return res.status(401).json({ error: 'Missing or invalid session' });
  if (tierOf(session) === 'member') return res.status(403).json({ error: 'Admin only' });

  if (!process.env.RESEND_API_KEY) {
    return res.status(500).json({ error: 'RESEND_API_KEY is not configured on the server.' });
  }

  const { kind, name, email, title, password, levelLabel, levelDesc, hubUrl } = req.body || {};
  if (kind !== 'user' && kind !== 'admin') {
    return res.status(400).json({ error: '"kind" must be "user" or "admin"' });
  }
  if (!name || typeof name !== 'string') {
    return res.status(400).json({ error: '"name" is required' });
  }
  if (!email || typeof email !== 'string' || !email.includes('@')) {
    return res.status(400).json({ error: 'A valid "email" is required' });
  }
  if (!password || typeof password !== 'string') {
    return res.status(400).json({ error: '"password" is required' });
  }
  // The client always supplies hubUrl (window.location.origin + the right
  // portal page), since only the browser knows its own real origin; this
  // fallback only covers a request missing it, it's never the normal path.
  const safeHubUrl = (typeof hubUrl === 'string' && hubUrl)
    || (process.env.APP_URL || 'https://opshub.weblightmedia.com') + (kind === 'admin' ? '/index' : '/user');

  const subject = kind === 'admin'
    ? 'Welcome to WebLight Media — Your Admin Panel Access'
    : 'Welcome to WebLight Media — Your Operations Hub Access';

  const inviteBody = kind === 'admin'
    ? buildAdminInviteBody({ title, email, password, hubUrl: safeHubUrl, levelLabel: levelLabel || 'Admin', levelDesc })
    : buildMemberInviteBody({ title, email, password, hubUrl: safeHubUrl });

  const firstName = String(name).trim().split(/\s+/)[0] || name;
  const html = buildEmailHtml({ name: firstName, title: subject, body: inviteBody, link: safeHubUrl });

  try {
    // No bypassDavidSuppression / no inactive-user bypass — this is a brand
    // new account, so it can never match an already-inactive roster row, and
    // if it somehow matched David's own address (he already has an admin
    // account; addAdmin()/addUser() both already reject a duplicate email
    // before this endpoint is ever reached) the safe default is still to
    // suppress, same as every other Resend-sending path in this codebase.
    await sendResendEmail({ to: email, subject, html, type: 'welcomeInvite' });
  } catch (err) {
    await logError({ endpoint: 'send-welcome-email', error: err, session, extra: { to: email, kind } });
    return res.status(500).json({ error: err.message || 'Failed to send invitation email' });
  }

  // Confirmation to the admin — best-effort. The actual job (getting the
  // new hire/admin their own credentials) already succeeded by this point,
  // so a confirmation-send failure must not turn this response into a
  // failure (the invite truly was sent) — but it must never be silently
  // dropped either, so it's logged exactly like any other failure here.
  try {
    const confirmSubject = `Invitation sent — ${name}`;
    const confirmBody = `The ${kind === 'admin' ? 'admin' : 'team'} invitation for ${name} was sent directly to ${email}.`;
    const confirmHtml = buildEmailHtml({ name: 'Sarah', title: confirmSubject, body: confirmBody, link: safeHubUrl });
    await sendResendEmail({ to: ADMIN_CONFIRMATION_EMAIL, subject: confirmSubject, html: confirmHtml, type: 'welcomeInviteConfirmation' });
  } catch (err) {
    await logError({ endpoint: 'send-welcome-email:adminConfirmation', error: err, session, extra: { to: email, kind } });
  }

  return res.status(200).json({ ok: true });
}
