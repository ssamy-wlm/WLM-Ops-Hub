// Signed, stateless session tokens for the Supabase-backed API. Replaces trust
// in a client-supplied role: the browser cannot forge admin access by editing
// localStorage, because the role is embedded in a token that only the server
// (holding SESSION_SECRET) can produce or verify.
import crypto from 'crypto';
import { getSupabaseAdmin } from './supabaseAdmin.js';

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

// Session kill-switch: a token is otherwise valid (correct signature, not yet
// 90 days old) for its entire lifetime with no way to invalidate it early —
// there's no revocation list, so a stolen/leaked token stays usable until it
// naturally expires. sessionsRevokedAt is a plain timestamp field on the
// account's own row (ops_users.data.sessionsRevokedAt / ops_admins.data.
// sessionsRevokedAt for a dual-role account's admin identity; the primary
// admin sentinel has no row, so its equivalent lives at
// ops_settings.primaryAdminSessionsRevokedAt) — set by an explicit action
// only (a password change, or the Super Admin's "Sign out everywhere"/"Sign
// out ALL" buttons in api/ops-sync.js), never by a background process. A
// token issued (iat) before that timestamp is rejected here on every request,
// which is what actually revokes it — the token itself is never edited or
// blocklisted, just outlived.
async function isSessionRevoked(session) {
  if (!session) return false;
  const supabase = getSupabaseAdmin();
  if (session.id === 'primary-admin') {
    const { data } = await supabase.from('ops_settings').select('data').eq('key', 'primaryAdminSessionsRevokedAt').maybeSingle();
    const revokedAt = data?.data ? new Date(data.data).getTime() : 0;
    return !!revokedAt && session.iat < revokedAt;
  }
  // A dual-role account's token can carry BOTH an employeeId and an adminId
  // (see api/ops-auth.js) — revoking either identity must kill the whole
  // session, so both rows are checked and the later of the two wins.
  const lookups = [];
  const userId = session.employeeId || (session.role === 'member' ? session.id : null);
  const adminId = session.adminId || (session.role === 'admin' ? session.id : null);
  if (userId) lookups.push(supabase.from('ops_users').select('data').eq('id', userId).maybeSingle());
  if (adminId) lookups.push(supabase.from('ops_admins').select('data').eq('id', adminId).maybeSingle());
  if (!lookups.length) return false;
  const results = await Promise.all(lookups);
  const revokedTimes = results
    .map(r => r.data?.data?.sessionsRevokedAt)
    .filter(Boolean)
    .map(t => new Date(t).getTime());
  if (!revokedTimes.length) return false;
  return session.iat < Math.max(...revokedTimes);
}

export async function requireSession(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const session = verifySession(token);
  if (!session) return null;
  if (await isSessionRevoked(session)) return null;
  return session;
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
