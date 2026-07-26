// Password hashing — scrypt, Node's built-in crypto module (already the
// established pattern in this codebase: lib/opsSession.js uses the same
// module's createHmac/timingSafeEqual for session-token signing). No new
// npm dependency, no native-binary build step, so nothing that can fail to
// build on Vercel's serverless platform the way a compiled bcrypt/argon2
// binding sometimes can.
//
// Stored format is self-identifying, exactly like bcrypt's own "$2b$..."
// prefix: "scrypt:<saltHex>:<hashHex>". This is what isHashed() checks for
// — a real plaintext password is never going to start with "scrypt:", so
// every login/write path can tell a migrated row from a legacy plaintext
// one with a single, cheap check, and the migration itself is lazy/per-row
// (see api/ops-auth.js, api/ops-sync.js) rather than a bulk rewrite.
import crypto from 'crypto';

const PREFIX = 'scrypt';
const KEY_LEN = 64;

export function isHashed(value) {
  return typeof value === 'string' && value.startsWith(PREFIX + ':');
}

export function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(plain, salt, KEY_LEN);
  return `${PREFIX}:${salt}:${derived.toString('hex')}`;
}

// Returns false (never throws) for a malformed stored value — a corrupt or
// unexpected format must fail closed, not crash the login endpoint.
export function verifyPassword(plain, stored) {
  if (!isHashed(stored)) return false;
  const parts = stored.split(':');
  if (parts.length !== 3) return false;
  const [, salt, hashHex] = parts;
  try {
    const expected = Buffer.from(hashHex, 'hex');
    const actual = crypto.scryptSync(plain, salt, KEY_LEN);
    if (expected.length !== actual.length) return false;
    return crypto.timingSafeEqual(expected, actual);
  } catch (e) {
    return false;
  }
}
