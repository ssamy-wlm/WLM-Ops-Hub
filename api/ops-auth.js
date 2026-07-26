// Verifies login credentials against Supabase and issues a signed session
// token (see lib/opsSession.js). The *role* the server trusts for
// /api/ops-sync comes from this signed token, not from anything the
// browser can edit.
//
// Password storage is being migrated from plaintext to scrypt hashes
// (lib/passwordHash.js), lazily and per-row: a stored value that's already
// a hash is verified as a hash; a value that's still plaintext is compared
// as plaintext (so every existing account keeps logging in unchanged), and
// on a SUCCESSFUL legacy-plaintext login that row is immediately re-saved
// as a hash. No bulk rewrite, no forced reset — see CLAUDE.md.

import { getSupabaseAdmin } from '../lib/supabaseAdmin.js';
import { signSession } from '../lib/opsSession.js';
import { logError } from '../lib/errorLog.js';
import { isHashed, hashPassword, verifyPassword } from '../lib/passwordHash.js';

// Checks a submitted password against a stored value that may be a hash or
// still plaintext, returning both the verdict and whether this call just
// upgraded a legacy plaintext match — kept as one shared helper so the
// primary-admin branch and the regular user/admin branch (below) apply the
// exact same rule instead of two hand-copies drifting apart.
function checkPassword(submitted, stored) {
  if (isHashed(stored)) return { ok: verifyPassword(submitted, stored), upgraded: false };
  const ok = stored === submitted;
  return { ok, upgraded: ok };
}

const PRIMARY_ADMIN_EMAIL = 'ssamy@weblightmedia.com';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email and password are required' });
  const normEmail = String(email).trim().toLowerCase();

  let supabase;
  try { supabase = getSupabaseAdmin(); }
  catch (err) { await logError({ endpoint: 'ops-auth', error: err }); return res.status(500).json({ error: err.message }); }

  try {
    // ── Primary admin — password lives only in ops_settings.primaryAdminPw
    // (set via Settings), never in code. ──
    const { data: pwRow } = await supabase.from('ops_settings').select('data').eq('key', 'primaryAdminPw').maybeSingle();
    const primaryPw = pwRow && pwRow.data;
    if (normEmail === PRIMARY_ADMIN_EMAIL && primaryPw) {
      const { ok, upgraded } = checkPassword(password, primaryPw);
      if (ok) {
        if (upgraded) {
          await supabase.from('ops_settings').upsert({ key: 'primaryAdminPw', data: hashPassword(password) }, { onConflict: 'key' });
        }
        const token = signSession({ id: 'primary-admin', role: 'admin', level: 'owner', name: 'Sarah Samy', email: PRIMARY_ADMIN_EMAIL });
        return res.status(200).json({ token, role: 'admin', level: 'owner', id: 'primary-admin', name: 'Sarah Samy', email: PRIMARY_ADMIN_EMAIL });
      }
    }

    // ── One account per email: an ops_admins row optionally carries
    // linkedUserId, pointing at the ops_users row for the SAME person, when
    // that person holds both an employee profile and an admin/manager role
    // (see CLAUDE.md's dual-mode permission project). This is additive —
    // every existing single-role row (plain admin, plain member) simply has
    // no linkedUserId and resolves exactly as it always has.
    //
    // Email alone is NEVER enough to treat two rows as one account — that's
    // the exact collision bug this field exists to prevent (see Sherine: an
    // ops_users row and an ops_admins row today share an email with no
    // formal link between them, and until she's actually consolidated that
    // stays true, so her login keeps resolving exactly as it does now, admin
    // row only). Only an explicit linkedUserId makes two rows one account.
    const { data: admins } = await supabase.from('ops_admins').select('id, data');
    const { data: deletedRows } = await supabase.from('ops_deleted_user_ids').select('user_id');
    const deletedIds = new Set((deletedRows || []).map(r => r.user_id));
    const { data: users } = await supabase.from('ops_users').select('id, data');
    const liveUsers = (users || []).filter(u => !deletedIds.has(u.id));

    const adminByEmail = (admins || []).find(a => (a.data?.email || '').toLowerCase() === normEmail);
    const userByEmail = liveUsers.find(u => (u.data?.email || '').toLowerCase() === normEmail);

    // employeeRow: the ops_users row this login resolves to, if any.
    // adminRow: the ops_admins row this login resolves to, if any.
    // passwordSource: whichever row's password is authoritative for this identity.
    let employeeRow = null, adminRow = null, passwordSource = null;

    if (adminByEmail && adminByEmail.data?.linkedUserId) {
      // Genuine dual-role account — re-fetch the linked row by id, never
      // trust the email match alone, in case the link is stale.
      const linked = liveUsers.find(u => u.id === adminByEmail.data.linkedUserId);
      if (linked) { employeeRow = linked; adminRow = adminByEmail; passwordSource = linked; }
    }
    if (!employeeRow && !adminRow && adminByEmail) {
      // Admin match with no (valid) link — resolves as admin-only, same as
      // before this change. Covers both real admin-only accounts and any
      // not-yet-consolidated accidental duplicate (Sherine, today).
      adminRow = adminByEmail; passwordSource = adminByEmail;
    }
    if (!employeeRow && !adminRow && userByEmail) {
      // Plain member match, and no unlinked admin match already claimed this
      // login above — check for an admin row linked TO this employee row
      // too, so a dual-role account discovered via its employee identity
      // still surfaces its admin capability.
      const linkedAdmin = (admins || []).find(a => a.data?.linkedUserId === userByEmail.id);
      employeeRow = userByEmail; adminRow = linkedAdmin || null; passwordSource = userByEmail;
    }

    if (!passwordSource) return res.status(401).json({ error: 'Invalid email or password' });

    if (adminRow && adminRow.data?.status === 'inactive') {
      if (employeeRow) {
        // Deactivating the manager role on a dual-role account drops the
        // admin capability, not the person's whole login — they're still an
        // active employee. Re-check the password against the employee row,
        // which is already passwordSource in this branch.
        adminRow = null;
      } else {
        // Admins are never hard-deleted, only deactivated (see index.html
        // _removeAdminImpl()) — a deactivated admin's credentials still
        // exist but must not be able to sign in.
        return res.status(401).json({ error: 'This admin account has been deactivated' });
      }
    }

    const { ok: pwOk, upgraded: pwUpgraded } = checkPassword(password, passwordSource.data?.password);
    if (!pwOk) return res.status(401).json({ error: 'Invalid email or password' });
    if (pwUpgraded) {
      // passwordSource is always either employeeRow (ops_users) or adminRow
      // (ops_admins) — whichever branch above set it, re-save that SAME row
      // only, by id, never a bulk rewrite.
      const table = passwordSource === employeeRow ? 'ops_users' : 'ops_admins';
      await supabase.from(table).update({ data: { ...passwordSource.data, password: hashPassword(password) } }).eq('id', passwordSource.id);
    }

    const role = adminRow ? 'admin' : 'member';
    const level = adminRow ? (adminRow.data.level || 'admin') : undefined;
    const id = employeeRow ? employeeRow.id : adminRow.id;
    const primary = employeeRow ? employeeRow.data : adminRow.data;
    // For a dual-role account, EITHER row can force a change — not just the
    // employee row. This is what lets "Grant manager role" (see CLAUDE.md's
    // dual-mode permission project, Step 3) force a password reset on first
    // Manager-mode entry purely by setting mustChangePassword on the NEW
    // ops_admins row, without ever writing to the person's existing ops_users
    // row. For a single-role account this is unchanged — there's only one
    // row to check either way.
    const mustChangePassword = !!(employeeRow?.data?.mustChangePassword || adminRow?.data?.mustChangePassword);

    const token = signSession({
      id, role, level, name: primary.name, email: normEmail,
      employeeId: employeeRow ? employeeRow.id : undefined,
      adminId: adminRow ? adminRow.id : undefined,
    });
    return res.status(200).json({
      token, role, level, id, name: primary.name, email: normEmail, title: primary.title,
      employeeId: employeeRow ? employeeRow.id : undefined,
      adminId: adminRow ? adminRow.id : undefined,
      mustChangePassword,
    });
  } catch (err) {
    await logError({ endpoint: 'ops-auth', error: err });
    return res.status(500).json({ error: err.message || 'Login failed' });
  }
}
