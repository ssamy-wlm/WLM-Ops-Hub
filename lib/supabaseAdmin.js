// Server-side Supabase client for the new ops_* relational tables. Built with
// the service-role key, which bypasses RLS entirely — this is intentional
// (see the migration plan's Decision 0): the app's custom login is kept as
// the only auth system, and every ops_* table is reached exclusively through
// these server-side endpoints, never directly from the browser. Import this
// only from api/*.js files, never from anything shipped to the browser.

import { createClient } from '@supabase/supabase-js';

let client = null;

export function getSupabaseAdmin() {
  if (client) return client;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY (and NEXT_PUBLIC_SUPABASE_URL or SUPABASE_URL) are not configured on the server. Set them in Vercel env vars from your Supabase project\'s API settings page.');
  }

  client = createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return client;
}
