// Shared cloud-sync data store, backed by Vercel Blob.
// Requires BLOB_READ_WRITE_TOKEN (auto-set by Vercel when Blob storage is
// enabled for this project — Vercel dashboard → Storage → Create → Blob).

import { put, head, BlobNotFoundError } from '@vercel/blob';

const BLOB_PATH = 'wlm-ops-hub/cloud-data.json';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return res.status(500).json({ error: 'BLOB_READ_WRITE_TOKEN is not configured on the server. Enable Blob storage for this project in the Vercel dashboard (Storage → Create Database → Blob).' });
  }

  if (req.method === 'GET') {
    try {
      let info;
      try {
        info = await head(BLOB_PATH);
      } catch (e) {
        // @vercel/blob's error classes never set `.name`, so `e.name` is always
        // the generic "Error" — checking it here silently never matched and let
        // a missing blob (e.g. before the first-ever push) fall through to a 500.
        if (e instanceof BlobNotFoundError) {
          return res.status(200).json({ record: {} });
        }
        throw e;
      }
      const r = await fetch(`${info.url}?t=${Date.now()}`, { cache: 'no-store' });
      if (!r.ok) return res.status(200).json({ record: {} });
      const record = await r.json();
      return res.status(200).json({ record });
    } catch (err) {
      return res.status(500).json({ error: err.message || 'Failed to read cloud data' });
    }
  }

  if (req.method === 'PUT') {
    try {
      const record = req.body || {};
      await put(BLOB_PATH, JSON.stringify(record), {
        access: 'public',
        contentType: 'application/json',
        addRandomSuffix: false,
        allowOverwrite: true,
        cacheControlMaxAge: 60,
      });
      return res.status(200).json({ ok: true });
    } catch (err) {
      return res.status(500).json({ error: err.message || 'Failed to write cloud data' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
