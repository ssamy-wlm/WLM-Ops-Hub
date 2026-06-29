// Vanilla-JS Supabase client init — this app has no bundler/build step, so
// the package is loaded straight from a CDN as an ES module instead of from
// node_modules, and the URL/anon key come from /api/supabase-config (which
// reads the actual values out of Vercel env vars) instead of being baked
// into this static file.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

let clientPromise = null;

export function getSupabaseClient() {
  if (!clientPromise) {
    clientPromise = fetch('/api/supabase-config')
      .then(res => res.json())
      .then(({ url, anonKey, error }) => {
        if (error) throw new Error(error);
        return createClient(url, anonKey);
      });
  }
  return clientPromise;
}
