// Read-only failure capture — records a server endpoint failure or a failed
// cloud write to ops_error_log so it surfaces to an admin instead of failing
// silently. This module NEVER modifies app data and NEVER throws into the
// caller: a broken error log must never become a broken app, so every
// failure here is swallowed and, at most, console.warn'd.
import { getSupabaseAdmin } from './supabaseAdmin.js';

export async function logError({ endpoint, error, session, extra }) {
  try {
    const supabase = getSupabaseAdmin();
    const id = `err_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const message = typeof error === 'string' ? error : (error?.message || String(error));
    await supabase.from('ops_error_log').insert({
      id,
      data: {
        endpoint,
        error: message,
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
