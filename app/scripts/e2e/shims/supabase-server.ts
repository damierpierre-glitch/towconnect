// Stands in for @/lib/supabase/server inside the E2E harness.
//
// Builds a real Supabase client with the ANON key and the current actor's
// access token — the same credentials the browser holds. RLS applies. The
// only thing that differs from the app is where the token came from.
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/supabase/types';
import { currentToken, currentRefreshToken } from '../session';

export async function createClient() {
  const token = currentToken();
  const client = createSupabaseClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      auth: { autoRefreshToken: false, persistSession: false },
      global: token ? { headers: { Authorization: `Bearer ${token}` } } : {},
    }
  );

  // A bearer header is enough for anything that reads, because PostgREST and
  // the auth API both take the token off the wire. It is NOT enough for
  // auth.updateUser(), which reads the client's own session state and answers
  // "Auth session missing" to a client that has none. When the actor supplied
  // a refresh token as well, give the client a real session so those actions
  // behave here exactly as they do in the app.
  const refresh = currentRefreshToken();
  if (token && refresh) {
    await client.auth.setSession({ access_token: token, refresh_token: refresh });
  }

  return client;
}
