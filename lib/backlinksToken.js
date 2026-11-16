// Signed, stateless tokens for the monthly backlinks-renewal reminder's
// one-click confirmation links — api/cron-backlinks-reminder.js creates
// one per button, api/backlinks-confirm.js verifies it. Deliberately its
// own small HMAC implementation rather than reusing lib/opsSession.js's
// signSession()/verifySession(): those are the real login-session signer,
// and this token has nothing to do with being signed in at all (David
// clicks it with no session, no login, from inside his email client) — a
// future change to MAX_AGE_MS or the payload shape there for genuine
// session-expiry reasons must never be able to silently change how long a
// backlinks-confirm link stays valid, or vice versa. Shares the same
// SESSION_SECRET env var (no new secret to configure or document) but is
// a fully separate code path from the real session signer.
import crypto from 'crypto';

// Comfortably past the longest this link could still matter: the repeat-
// reminder cycle stops the instant David responds, and even an unanswered
// month is superseded by next month's own fresh reminder/links well
// before this expiry would ever bite.
const MAX_AGE_MS = 45 * 24 * 60 * 60 * 1000;

function b64url(input) { return Buffer.from(input).toString('base64url'); }

export function signBacklinksToken(payload) {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error('SESSION_SECRET is not configured on the server.');
  const body = JSON.stringify({ ...payload, iat: Date.now() });
  const sig = crypto.createHmac('sha256', secret).update(body).digest();
  return `${b64url(body)}.${b64url(sig)}`;
}

export function verifyBacklinksToken(token) {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error('SESSION_SECRET is not configured on the server.');
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [bodyB64, sigB64] = token.split('.');
  let body, gotSig;
  try {
    body = Buffer.from(bodyB64, 'base64url').toString('utf8');
    gotSig = Buffer.from(sigB64, 'base64url');
  } catch { return null; }
  const expectedSig = crypto.createHmac('sha256', secret).update(body).digest();
  if (expectedSig.length !== gotSig.length || !crypto.timingSafeEqual(expectedSig, gotSig)) return null;
  let payload;
  try { payload = JSON.parse(body); } catch { return null; }
  if (!payload.iat || Date.now() - payload.iat > MAX_AGE_MS) return null;
  return payload;
}
