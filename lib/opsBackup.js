// Shared logic for the daily-auto + manual data-snapshot feature (see
// api/cron-overdue-check.js — its end-of-run backup step — and
// api/ops-backups.js). Kept in lib/ so both call sites use the exact same
// table list, snapshot shape, and restore mechanics — never two copies that
// could drift (the exact lesson behind the payroll triple-implementation
// bug — CLAUDE.md).
//
// Table scope: matches the tables api/ops-state.js actually reads (the
// app's real, restorable business data) — deliberately EXCLUDES
// ops_error_log and ops_session_activity, which are diagnostic/log tables,
// not data anyone would want a point-in-time "restore" to touch. Flagged in
// the PR description, not silently decided.
import crypto from 'crypto';

// Primary-key column(s) per table — needed because this schema is NOT
// uniformly `id` (ops_settings uses `key`, ops_deleted_user_ids uses
// `user_id`, ops_summaries has a 3-column composite key, no `id` at all).
export const BACKUP_TABLE_PK = {
  ops_users: ['id'],
  ops_admins: ['id'],
  ops_clients: ['id'],
  ops_goals: ['id'],
  ops_roadmap_tasks: ['id'],
  ops_org_nodes: ['id'],
  ops_org_links: ['id'],
  ops_time_off_requests: ['id'],
  ops_messages: ['id'],
  ops_settings: ['key'],
  ops_deleted_user_ids: ['user_id'],
  ops_feed: ['id'],
  ops_time_off_ledger: ['id'],
  ops_summaries: ['client_id', 'kind', 'period_key'],
  ops_catalog_suggestions: ['id'],
  ops_notifications: ['id'],
  ops_sales_funnel: ['id'],
  ops_tasks: ['id'],
};
export const BACKUP_TABLES = Object.keys(BACKUP_TABLE_PK);

// DB-level append-only tables (ops_block_mutations trigger blocks ALL
// UPDATE/DELETE, even for the service role — see
// 20260630120000_ops_hub_document_schema.sql). Restore can only ever INSERT
// a missing row here, exactly like every other write path in this app
// already treats them (see api/ops-sync.js's insertNewOnly()).
export const APPEND_ONLY_TABLES = new Set(['ops_feed', 'ops_time_off_ledger']);

function pkKey(row, pkCols) {
  return pkCols.map(c => String(row[c])).join(' ');
}

// Reads every table in BACKUP_TABLES in parallel. A single table's read
// failure is recorded as a warning and that table is snapshotted as an
// empty array (never throws — a partial snapshot with a clear warning beats
// no snapshot at all for the tables that DID succeed).
export async function buildBackupSnapshot(supabase) {
  const warnings = [];
  const tables = {};
  await Promise.all(BACKUP_TABLES.map(async (t) => {
    const { data, error } = await supabase.from(t).select('*');
    if (error) { warnings.push(`${t}: ${error.message}`); tables[t] = []; return; }
    tables[t] = data || [];
  }));
  const tableCounts = Object.fromEntries(BACKUP_TABLES.map(t => [t, tables[t].length]));
  return {
    warnings,
    snapshot: { tables, meta: { generatedAt: new Date().toISOString(), tableCounts } },
  };
}

export async function insertBackupRow(supabase, kind, snapshot) {
  const id = `bak_${kind}_${Date.now()}`;
  const json = JSON.stringify(snapshot);
  const { error } = await supabase.from('ops_backups').insert({
    id, kind, data: snapshot, size_bytes: Buffer.byteLength(json, 'utf8'),
  });
  if (error) throw new Error(`insert ops_backups failed: ${error.message}`);
  return id;
}

// Retention: keep the most recent `keep` daily-auto rows, delete the rest.
// Manual snapshots are never touched here (and the DB trigger would refuse
// to delete one anyway, even if this code had a bug).
export async function pruneOldDailyBackups(supabase, keep = 30) {
  const { data: rows, error } = await supabase
    .from('ops_backups').select('id, created_at')
    .eq('kind', 'daily-auto').order('created_at', { ascending: false });
  if (error) return { trimmed: 0, error: error.message };
  const toDelete = (rows || []).slice(keep).map(r => r.id);
  if (!toDelete.length) return { trimmed: 0 };
  const { error: delErr } = await supabase.from('ops_backups').delete().in('id', toDelete);
  if (delErr) return { trimmed: 0, error: delErr.message };
  return { trimmed: toDelete.length };
}

// Read-only: compares every table in the snapshot against the CURRENT live
// table, by primary key. Never writes anything. `toRestoreIds` is capped at
// `idCap` per table for a bounded response — `toRestoreCount` always
// reflects the true total even when the id list itself is truncated.
export async function computeRestoreDiff(supabase, snapshot, idCap = 50) {
  const perTable = {};
  await Promise.all(BACKUP_TABLES.map(async (t) => {
    const pkCols = BACKUP_TABLE_PK[t];
    const snapRows = snapshot?.tables?.[t] || [];
    const { data: liveRows, error } = await supabase.from(t).select('*');
    if (error) { perTable[t] = { error: error.message }; return; }
    const liveByKey = new Map((liveRows || []).map(r => [pkKey(r, pkCols), r]));
    const snapKeys = new Set();
    const toRestoreIds = [];
    let toRestoreCount = 0, unchanged = 0;
    snapRows.forEach(sRow => {
      const key = pkKey(sRow, pkCols);
      snapKeys.add(key);
      const live = liveByKey.get(key);
      const same = live && JSON.stringify(live) === JSON.stringify(sRow);
      if (same) { unchanged++; return; }
      toRestoreCount++;
      if (toRestoreIds.length < idCap) toRestoreIds.push(key.split(' ').join('/'));
    });
    const notInSnapshotCount = (liveRows || []).filter(r => !snapKeys.has(pkKey(r, pkCols))).length;
    perTable[t] = {
      toRestoreCount, unchanged, notInSnapshotCount,
      toRestoreIds, toRestoreIdsTruncated: toRestoreCount > toRestoreIds.length,
    };
  }));
  return perTable;
}

// Deterministic, server-side-only token binding a confirm request to the
// EXACT diff just reviewed — recomputing this at confirm time and comparing
// is what "checked server-side" (CLAUDE.md rule #6) actually means here: if
// live data changed since the dry run (so the id lists would differ), the
// recomputed token won't match and the restore is refused, forcing a fresh
// dry run instead of acting on a stale review.
export function computeReviewToken(backupId, perTableDiff) {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error('SESSION_SECRET is not configured on the server.');
  const canonical = JSON.stringify({
    backupId,
    perTable: Object.keys(perTableDiff).sort().reduce((acc, t) => {
      const d = perTableDiff[t] || {};
      acc[t] = { toRestoreIds: [...(d.toRestoreIds || [])].sort(), toRestoreCount: d.toRestoreCount || 0 };
      return acc;
    }, {}),
  });
  return crypto.createHmac('sha256', secret).update(canonical).digest('base64url');
}

// The actual write. Upserts every row from the snapshot back onto its table
// (bringing back deleted/changed rows to match the snapshot exactly) —
// deliberately NEVER deletes a row that exists now but wasn't in the
// snapshot (a narrower, safer "restore" than a true point-in-time rewind;
// see the PR description for why). Append-only tables only ever get an
// insert-missing-only pass (onConflict + ignoreDuplicates), since the DB
// trigger blocks UPDATE/DELETE there unconditionally.
export async function applyRestore(supabase, snapshot) {
  const results = {};
  for (const t of BACKUP_TABLES) {
    const pkCols = BACKUP_TABLE_PK[t];
    const rows = snapshot?.tables?.[t] || [];
    if (!rows.length) { results[t] = { restored: 0 }; continue; }
    const onConflict = pkCols.join(',');
    if (APPEND_ONLY_TABLES.has(t)) {
      const { error, count } = await supabase.from(t).upsert(rows, { onConflict, ignoreDuplicates: true, count: 'exact' });
      results[t] = error ? { restored: 0, error: error.message } : { restored: count ?? rows.length };
    } else {
      const { error, count } = await supabase.from(t).upsert(rows, { onConflict, count: 'exact' });
      results[t] = error ? { restored: 0, error: error.message } : { restored: count ?? rows.length };
    }
  }
  return results;
}
