// Shared cloud-sync data store, backed by Vercel Blob.
// Requires BLOB_READ_WRITE_TOKEN (auto-set by Vercel when Blob storage is
// enabled for this project — Vercel dashboard → Storage → Create → Blob).

import { put, get } from '@vercel/blob';

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
      // get() returns null on a missing blob instead of throwing, and (unlike a
      // raw fetch of the blob URL) sends the auth token this store's private
      // access level requires.
      const blob = await get(BLOB_PATH, { access: 'private', useCache: false });
      if (!blob) return res.status(200).json({ record: {} });
      const text = await new Response(blob.stream).text();
      return res.status(200).json({ record: text ? JSON.parse(text) : {} });
    } catch (err) {
      return res.status(500).json({ error: err.message || 'Failed to read cloud data' });
    }
  }

  if (req.method === 'PUT') {
    try {
      const record = req.body || {};
      await put(BLOB_PATH, JSON.stringify(record), {
        access: 'private',
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
