// Shared cloud-sync data store, backed by Vercel Blob.
// Requires BLOB_READ_WRITE_TOKEN (auto-set by Vercel when Blob storage is
// enabled for this project — Vercel dashboard → Storage → Create → Blob).

import { detectTaskChanges, enqueueTaskChanges, flushDueTaskNotifications } from './_task-notifications.js';
import { dualGet, dualPut, blobConfigured } from './_blob-dual.js';

const BLOB_PATH = 'wlm-ops-hub/cloud-data.json';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (!blobConfigured) {
    return res.status(500).json({ error: 'BLOB_READ_WRITE_TOKEN is not configured on the server. Enable Blob storage for this project in the Vercel dashboard (Storage → Create Database → Blob).' });
  }

  if (req.method === 'GET') {
    try {
      // dualGet() returns null on a missing blob instead of throwing, and
      // (unlike a raw fetch of the blob URL) sends the auth token this
      // store's private access level requires.
      const blob = await dualGet(BLOB_PATH, { access: 'private', useCache: false });
      const record = blob ? (JSON.parse((await new Response(blob.stream).text()) || '{}')) : {};
      try {
        // Opportunistic flush: this endpoint is polled every ~20-30s from open
        // tabs, so it doubles as the "cron" that sends batched task-edit emails
        // once their quiet window has elapsed. Never allowed to fail the GET.
        await flushDueTaskNotifications(record);
      } catch (err) {
        console.error('[cloud-data] task-change notification flush failed:', err.message || err);
      }
      return res.status(200).json({ record });
    } catch (err) {
      return res.status(500).json({ error: err.message || 'Failed to read cloud data' });
    }
  }

  if (req.method === 'PUT') {
    try {
      const record = req.body || {};

      let oldRecord = {};
      try {
        const blob = await dualGet(BLOB_PATH, { access: 'private', useCache: false });
        if (blob) {
          const text = await new Response(blob.stream).text();
          oldRecord = text ? JSON.parse(text) : {};
        }
      } catch (err) {
        console.error('[cloud-data] failed to read previous record for task-change diffing:', err.message || err);
      }

      try {
        // Diffing the about-to-be-overwritten blob against the incoming one is
        // what makes this idempotent for retries: a retried PUT with the same
        // payload diffs against state that's already been updated, so it
        // produces no further changes and no duplicate email.
        const changes = detectTaskChanges(oldRecord, record);
        if (changes.length) await enqueueTaskChanges(changes);
      } catch (err) {
        console.error('[cloud-data] task-change notification queueing failed:', err.message || err);
      }

      await dualPut(BLOB_PATH, JSON.stringify(record), {
        access: 'private',
        contentType: 'application/json',
        addRandomSuffix: false,
        allowOverwrite: true,
        cacheControlMaxAge: 60,
      });

      try {
        await flushDueTaskNotifications(record);
      } catch (err) {
        console.error('[cloud-data] task-change notification flush failed:', err.message || err);
      }

      return res.status(200).json({ ok: true });
    } catch (err) {
      return res.status(500).json({ error: err.message || 'Failed to write cloud data' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
