// Daily backup of the shared cloud-data blob, kept fully separate from the
// live blob the app reads/writes (api/cloud-data.js). Exists so a future bug
// or bad write to the live blob can be recovered from — see BACKUP_PATH below.
// Triggered by Vercel Cron (see vercel.json "crons") and gated by CRON_SECRET,
// the same fail-closed pattern api/migrate-schema.js uses for MIGRATION_SECRET.
// Vercel automatically sends `Authorization: Bearer <CRON_SECRET>` on
// cron-triggered invocations once CRON_SECRET is set as an env var.

import { put, get, list, del } from '@vercel/blob';

const LIVE_BLOB_PATH = 'wlm-ops-hub/cloud-data.json';
const BACKUP_PREFIX = 'wlm-ops-hub/backups/';
const KEEP_BACKUPS = 30; // ~30 days of daily snapshots

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!process.env.CRON_SECRET) {
    return res.status(500).json({ error: 'CRON_SECRET is not configured on the server.' });
  }
  const authHeader = req.headers.authorization || '';
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return res.status(500).json({ error: 'BLOB_READ_WRITE_TOKEN is not configured on the server.' });
  }

  try {
    const blob = await get(LIVE_BLOB_PATH, { access: 'private', useCache: false });
    if (!blob) {
      return res.status(200).json({ ok: true, skipped: 'no live blob to back up yet' });
    }
    const text = await new Response(blob.stream).text();

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = `${BACKUP_PREFIX}cloud-data-${stamp}.json`;
    await put(backupPath, text, {
      access: 'private',
      contentType: 'application/json',
      addRandomSuffix: false,
    });

    // Prune old backups beyond the retention window so blob storage doesn't
    // grow unbounded — never touches the live blob, only files under BACKUP_PREFIX.
    const { blobs } = await list({ prefix: BACKUP_PREFIX });
    const sorted = blobs.slice().sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
    const stale = sorted.slice(KEEP_BACKUPS);
    if (stale.length) {
      await del(stale.map(b => b.url));
    }

    return res.status(200).json({ ok: true, backupPath, pruned: stale.length });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Backup failed' });
  }
}
