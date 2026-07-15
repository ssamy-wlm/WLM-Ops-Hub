// Signed, stateless session tokens for the Supabase-backed API. Replaces trust
// in a client-supplied role: the browser cannot forge admin access by editing
// localStorage, because the role is embedded in a token that only the server
// (holding SESSION_SECRET) can produce or verify.
import crypto from 'crypto';

const MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000; // 90 days — internal small-team tool, no refresh flow

function b64url(input) {
  return Buffer.from(input).toString('base64url');
}

export function signSession(payload) {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error('SESSION_SECRET is not configured on the server.');
  const body = JSON.stringify({ ...payload, iat: Date.now() });
  const sig = crypto.createHmac('sha256', secret).update(body).digest();
  return `${b64url(body)}.${b64url(sig)}`;
}

export function verifySession(token) {
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
  return payload; // { id, role, name, email, iat }
}

export function requireSession(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  return verifySession(token);
}

// Three access bands, replacing the old binary isAdmin check:
//   'super'   — super/owner (Super Admin + CEO/primary account): unrestricted.
//   'manager' — every other admin level (account_manager, production_manager,
//               creative_manager, admin): team + client management, but NOT
//               payroll/pay rates and NOT business settings/org chart.
//   'member'  — team members: view all clients, edit only assigned items.
const SUPER_CEO_LEVELS = new Set(['super', 'owner']);
export function tierOf(session) {
  if (!session || session.role !== 'admin') return 'member';
  return SUPER_CEO_LEVELS.has(session.level) ? 'super' : 'manager';
}

// Three specialized manager levels get full client/bundle access (same as
// 'admin') but are hard-blocked from team accounts and payroll — the
// permission-project's Step 1. A missing/unrecognized level is treated as
// unrestricted (falls through to the 'admin' default), matching the
// existing _getLevelInfo() fallback behavior in index.html rather than
// fail-closed, since that's the already-established convention here.
const RESTRICTED_MANAGER_LEVELS = new Set(['creative_manager', 'production_manager', 'account_manager']);
export function canEditUsers(session) {
  if (!session || session.role !== 'admin') return false;
  return !RESTRICTED_MANAGER_LEVELS.has(session.level);
}
