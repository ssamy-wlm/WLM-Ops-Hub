// Read-only failure capture — records a server endpoint failure or a failed
// cloud write to ops_error_log so it surfaces to an admin instead of failing
// silently. This module NEVER modifies app data and NEVER throws into the
// caller: a broken error log must never become a broken app, so every
// failure here is swallowed and, at most, console.warn'd.
import { getSupabaseAdmin } from './supabaseAdmin.js';

// Capture-size cap (2026-09-20) — some upstream failures hand back their
// entire raw response body as `error.message` (e.g. a Cloudflare challenge/
// error page's full HTML when a third-party API is unreachable at the edge,
// not just at the origin) — with nothing here to stop it, that whole page
// got stored verbatim, sometimes multiple KB per row. 2000 chars (~2 KB) is
// enough to diagnose from (the real error's own status line/summary is
// always at the very start of `message`, never buried after a huge body),
// while capping how large a single row — and this table's total footprint —
// can grow from one bad response. `extra`/`stack` are left uncapped here;
// `stack` already had its own 2000-char cap below, and `extra` is caller-
// supplied structured context (ids, counts, small snippets), never a raw
// response body, so it hasn't shown this failure mode.
const RAW_MESSAGE_CAP = 2000;
function capMessage(raw) {
  const s = typeof raw === 'string' ? raw : String(raw);
  return s.length > RAW_MESSAGE_CAP
    ? `${s.slice(0, RAW_MESSAGE_CAP)}… [truncated — ${s.length} chars total]`
    : s;
}

export async function logError({ endpoint, error, session, extra }) {
  try {
    const supabase = getSupabaseAdmin();
    const id = `err_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const message = typeof error === 'string' ? error : (error?.message || String(error));
    await supabase.from('ops_error_log').insert({
      id,
      data: {
        endpoint,
        error: capMessage(message),
        stack: error?.stack ? String(error.stack).slice(0, 2000) : null,
        userId: session?.id ?? null,
        userName: session?.name ?? null,
        userRole: session?.role ?? null,
        timestamp: new Date().toISOString(),
        extra: extra ?? null,
      },
    });
  } catch (e) {
    console.warn('[errorLog] failed to record error (non-fatal):', e.message);
  }
}

// Automatic retention (2026-09-20) — soft-archives (never hard-deletes)
// any NOT-YET-archived row older than the retention window, by created_at.
// A genuine hard DELETE isn't an option here even if wanted: the DB-level
// ops_error_log_archive_guard() trigger (see
// supabase/migrations/20260805120000_ops_error_log_archive_guard.sql)
// unconditionally rejects DELETE and any UPDATE touching id/data/
// created_at — the only mutation it ever permits is exactly this, an
// UPDATE that changes archived_at alone, which is also all the existing
// manual admin "Archive" control in Business Setup (api/error-log.js) has
// ever done. This is the same operation, just run automatically on a
// schedule instead of waiting on an admin to click the button — see
// api/cron-backup.js's own call site for why that's the right home for it
// (never runs on page load; capture-side only; touches nothing but
// ops_error_log). Returns the count archived so the caller can log it, and
// throws on a real DB error rather than swallowing it — unlike logError()
// itself, a caller here (a cron job) already has its own logError-wrapped
// try/catch and wants to know if this failed.
export async function pruneErrorLog(supabase, retentionDays = 90) {
  const cutoffIso = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('ops_error_log')
    .update({ archived_at: new Date().toISOString() })
    .lt('created_at', cutoffIso)
    .is('archived_at', null)
    .select('id');
  if (error) throw new Error(error.message);
  return { archivedCount: (data || []).length, cutoffIso, retentionDays };
}
