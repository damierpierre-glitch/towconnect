// Stands in for @/lib/supabase/server inside the E2E harness.
//
// Builds a real Supabase client with the ANON key and the current actor's
// access token — the same credentials the browser holds. RLS applies. The
// only thing that differs from the app is where the token came from.
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/supabase/types';
import { currentToken } from '../session';

export async function createClient() {
  const token = currentToken();
  return createSupabaseClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      auth: { autoRefreshToken: false, persistSession: false },
      global: token ? { headers: { Authorization: `Bearer ${token}` } } : {},
    }
  );
}
