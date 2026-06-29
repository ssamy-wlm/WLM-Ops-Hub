// Hands the Supabase URL + anon key to the browser at runtime, so they live
// in Vercel env vars like every other config value in this app instead of
// being hardcoded into a static file. Safe to expose to the browser: the
// anon key only grants what the RLS policies in supabase/migrations/ allow.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { SUPABASE_URL, SUPABASE_ANON_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return res.status(500).json({ error: 'SUPABASE_URL / SUPABASE_ANON_KEY are not configured on the server. Set them in Vercel env vars (Project Settings → Environment Variables) from your Supabase project\'s API settings page.' });
  }

  return res.status(200).json({ url: SUPABASE_URL, anonKey: SUPABASE_ANON_KEY });
}
