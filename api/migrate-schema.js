// One-time schema migration runner for the new Postgres PM data model.
// Requires POSTGRES_URL (auto-set by Vercel once Postgres storage is enabled
// for this project — Vercel dashboard → Storage → Create Database → Postgres)
// and MIGRATION_SECRET (set this yourself in Vercel env vars — pick any long
// random string; this endpoint refuses to run without it, unlike the optional
// key check on /api/process-transcript).
//
// This endpoint only ever runs CREATE/DROP statements against brand-new
// tables — it never touches the existing Vercel Blob data store.

import { readFileSync } from 'fs';
import path from 'path';
import { db } from '@vercel/postgres';
import { logError } from '../lib/errorLog.js';

const MIGRATIONS_DIR = path.join(process.cwd(), 'db', 'migrations');

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-migration-secret');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const expectedSecret = process.env.MIGRATION_SECRET;
  if (!expectedSecret) {
    return res.status(500).json({ error: 'MIGRATION_SECRET is not configured on the server. Set it in Vercel env vars before using this endpoint.' });
  }
  const providedSecret = req.headers['x-migration-secret'];
  if (!providedSecret || providedSecret !== expectedSecret) {
    return res.status(403).json({ error: 'Invalid or missing x-migration-secret header' });
  }

  if (!process.env.POSTGRES_URL) {
    return res.status(500).json({ error: 'POSTGRES_URL is not configured on the server. Enable Postgres storage for this project in the Vercel dashboard (Storage → Create Database → Postgres).' });
  }

  const { migration, direction } = req.body || {};
  if (!migration || !/^[a-zA-Z0-9_-]+$/.test(migration)) {
    return res.status(400).json({ error: 'A valid "migration" name is required (e.g. "0001_core_pm_schema")' });
  }
  if (direction !== 'up' && direction !== 'down') {
    return res.status(400).json({ error: '"direction" must be "up" or "down"' });
  }

  const filename = direction === 'up' ? `${migration}.sql` : `${migration}.rollback.sql`;
  const filePath = path.join(MIGRATIONS_DIR, filename);

  let sqlText;
  try {
    sqlText = readFileSync(filePath, 'utf8');
  } catch (err) {
    await logError({ endpoint: 'migrate-schema', error: err, extra: { filename } });
    return res.status(404).json({ error: `Migration file not found: ${filename}` });
  }

  const client = await db.connect();
  try {
    await client.query(sqlText);
    return res.status(200).json({ ok: true, ran: filename });
  } catch (err) {
    await logError({ endpoint: 'migrate-schema', error: err, extra: { filename } });
    return res.status(500).json({ error: err.message || 'Migration failed', ran: filename });
  } finally {
    client.release();
  }
}
