// Hands the Supabase URL + anon key to the browser at runtime, so they live
// in Vercel env vars like every other config value in this app instead of
// being hardcoded into a static file. Safe to expose to the browser: the
// anon key only grants what the RLS policies in supabase/migrations/ allow.

import { logError } from '../lib/errorLog.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Vercel's native Supabase integration injects SUPABASE_URL / SUPABASE_ANON_KEY
  // (no NEXT_PUBLIC_ prefix); a manually-added var would use the NEXT_PUBLIC_
  // names instead. Accept either so this works regardless of which path was used.
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    const message = 'Supabase URL/anon key are not configured on the server. Set NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY (or SUPABASE_URL / SUPABASE_ANON_KEY) in Vercel env vars (Project Settings → Environment Variables) from your Supabase project\'s API settings page.';
    await logError({ endpoint: 'supabase-config', error: message });
    return res.status(500).json({ error: message });
  }

  return res.status(200).json({ url, anonKey });
}
