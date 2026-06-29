// The original Blob store (BLOB_READ_WRITE_TOKEN) hit its storage quota, so a
// second store was added to keep the app writable. Set BLOB_READ_WRITE_TOKEN_V2
// to the new store's token (Vercel dashboard → Storage → Create Database →
// Blob → copy its read-write token into a project env var with this name).
//
// All new writes go to the new store, so the full old one never grows further.
// Reads check the new store first, falling back to the old one for paths that
// only exist there (the live record before its first write post-migration,
// and every backup made before this change — those are left in place, not
// copied over). Until BLOB_READ_WRITE_TOKEN_V2 is set, every call here behaves
// exactly like a plain @vercel/blob call against the old store, so this file
// is safe to deploy before the new store exists.

import { get as blobGet, put as blobPut, list as blobList, del as blobDel } from '@vercel/blob';

const NEW_TOKEN = process.env.BLOB_READ_WRITE_TOKEN_V2;
const OLD_TOKEN = process.env.BLOB_READ_WRITE_TOKEN;
const WRITE_TOKEN = NEW_TOKEN || OLD_TOKEN;

export const blobConfigured = !!WRITE_TOKEN;

export async function dualGet(path, opts = {}) {
  if (NEW_TOKEN) {
    try {
      const blob = await blobGet(path, { ...opts, token: NEW_TOKEN });
      if (blob) return blob;
    } catch (err) {
      // A broken/misconfigured second-store token must never block falling
      // back to the old store — that would turn a bad V2 token into a full
      // outage instead of the no-op this feature is supposed to be when V2
      // isn't working.
      console.error('[blob-dual] BLOB_READ_WRITE_TOKEN_V2 read failed, falling back to old store:', err.message || err);
    }
  }
  if (OLD_TOKEN) return await blobGet(path, { ...opts, token: OLD_TOKEN });
  return null;
}

export async function dualPut(path, body, opts = {}) {
  return await blobPut(path, body, { ...opts, token: WRITE_TOKEN });
}

export async function dualList(opts = {}) {
  return await blobList({ ...opts, token: WRITE_TOKEN });
}

export async function dualDel(urls, opts = {}) {
  return await blobDel(urls, { ...opts, token: WRITE_TOKEN });
}
