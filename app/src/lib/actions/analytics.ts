'use server';

import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import type { ProductEventName, ProductEventProps } from '@/lib/supabase/types';

// Product analytics.
//
// TWO RULES, BOTH ENFORCED SOMEWHERE ELSE AS WELL
//
//  1. Analytics never carries a fact about a person. The event name is a
//     database enum and the properties are checked against a whitelist by a
//     trigger (0047), so an address, a phone number or a chat message cannot
//     be recorded here even by mistake.
//
//  2. Analytics never breaks a rescue. Every failure below is swallowed. A
//     person at the roadside must never see a request fail because a counter
//     could not be written, and there is no such thing as an analytics error
//     worth showing anybody.

export interface RecordEventInput {
  name: ProductEventName;
  /** A random per-browser id. Not an identity, and never resolved to one. */
  anonId?: string | null;
  requestId?: string | null;
  attributionCode?: string | null;
  props?: ProductEventProps;
}

export async function recordEvent(input: RecordEventInput): Promise<void> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    // A landing view happens before anybody signs in, and `anon` holds no
    // EXECUTE grant on record_product_event — deliberately, so the funnel is
    // not an open write endpoint on the database. The service-role client
    // makes that call instead, and auth.uid() is null inside it, which is
    // exactly what an anonymous view should record.
    const client = user ? supabase : createAdminClient();

    await client.rpc('record_product_event' as never, {
      p_name: input.name,
      p_anon_id: input.anonId ?? null,
      p_request_id: input.requestId ?? null,
      p_attribution_code: input.attributionCode ?? null,
      p_props: input.props ?? {},
    } as never);
  } catch (err) {
    // Logged, never surfaced. See rule 2.
    console.error('[analytics] event dropped:', err);
  }
}
