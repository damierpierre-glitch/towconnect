import 'server-only';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import type { Database } from './types';

// Service-role client — bypasses RLS entirely. Used ONLY by trusted
// server-side payment code (lib/actions/payments.ts, the Stripe webhook
// route) that writes `payments` rows and profiles.stripe_customer_id — both
// of which have no INSERT/UPDATE policy for `authenticated` on purpose (see
// 0013_payments.sql). Never import this from a Client Component; `server-only`
// makes that a build error rather than a runtime leak.
export function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error(
      'SUPABASE_SERVICE_ROLE_KEY is not configured — required for payment processing. See .env.local.example.'
    );
  }
  return createSupabaseClient<Database>(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
