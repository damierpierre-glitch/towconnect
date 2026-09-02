'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { ACTIVE_REQUEST_STATUSES, type PaymentStatus, type TowRequest } from '@/lib/supabase/types';
import { distanceKm, estimatePriceBreakdown } from '@/lib/pricing';
import { problemRequiresDestination } from '@/lib/constants';
import { authorizeRequestPayment, cancelRequestPayment, finalizeAuthorization, isStripeConfigured } from '@/lib/actions/payments';
import { settleCancellationEconomics } from '@/lib/actions/finance';

export interface CreateRequestInput {
  problemType: string;
  locationText: string;
  lat: number;
  lng: number;
  vehicleDesc: string;
  vehicleId?: string | null;
  notes: string;
  destinationAddress?: string | null;
  destinationLat?: number | null;
  destinationLng?: number | null;
}

export interface CreateRequestResult {
  requestId: string;
  paymentStatus: PaymentStatus | 'skipped';
  paymentClientSecret: string | null;
  paymentMethodId: string | null;
}

// Same escalating tiers Smart Dispatch itself uses (dispatch_next_candidate)
// — used here purely to get a trustworthy, server-computed distance for
// pricing. The client's own earlier estimate (StepEstimate) is a preview
// only; this is the number that actually gets billed, recomputed
// server-side from nearby_drivers()'s PostGIS distance, never taken from
// whatever the browser sent.
const PRICE_SEARCH_TIERS = [15, 40, 350];

// Smart Dispatch owns picking the driver — the client never sends a
// driverId. Pricing, similarly, is never taken from the client: the price
// shown before confirmation (StepEstimate) is a preview, but the amount
// actually stored and charged is computed here, server-side, from the same
// trusted nearby_drivers() distance and (for towing services) the real
// pickup/destination coordinates. The request is created driverless
// (status='pending'), payment is authorized if a service type/amount
// requires it, and only then is dispatch_next_candidate() called — so a
// request with a payment problem never gets a driver sent to it.
export async function createRequest(input: CreateRequestInput): Promise<CreateRequestResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');

  let driverDistanceKm = 0;
  for (const radiusKm of PRICE_SEARCH_TIERS) {
    const { data: nearby, error: nearbyError } = await supabase.rpc('nearby_drivers', {
      p_lat: input.lat,
      p_lng: input.lng,
      p_radius_km: radiusKm,
      p_limit: 1,
    });
    if (nearbyError) throw nearbyError;
    if (nearby && nearby.length > 0) {
      driverDistanceKm = nearby[0].distance_km;
      break;
    }
  }

  const needsDestination = problemRequiresDestination(input.problemType);
  const towDistanceKm =
    needsDestination && input.destinationLat != null && input.destinationLng != null
      ? distanceKm({ lat: input.lat, lng: input.lng }, { lat: input.destinationLat, lng: input.destinationLng })
      : undefined;

  const breakdown = estimatePriceBreakdown({
    driverDistanceKm,
    towDistanceKm,
    problemType: input.problemType,
  });

  const { data, error } = await supabase
    .from('requests')
    .insert({
      user_id: user.id,
      problem_type: input.problemType,
      location_text: input.locationText,
      lat: input.lat,
      lng: input.lng,
      vehicle_desc: input.vehicleDesc,
      vehicle_id: input.vehicleId ?? null,
      notes: input.notes,
      status: 'pending',
      price_estimate: breakdown.total,
      price_base: breakdown.base,
      price_distance: breakdown.distance,
      price_surcharge: breakdown.surcharge,
      destination_address: needsDestination ? input.destinationAddress ?? null : null,
      destination_lat: needsDestination ? input.destinationLat ?? null : null,
      destination_lng: needsDestination ? input.destinationLng ?? null : null,
      tow_distance_km: towDistanceKm ?? null,
    })
    .select('id')
    .single();

  if (error) throw error;
  const requestId = data.id as string;

  if (!isStripeConfigured()) {
    // Stripe not set up in this environment — payment step is skipped
    // entirely and dispatch proceeds exactly as in Phases 1-3, same
    // optional-until-configured pattern as Mapbox.
    try {
      await supabase.rpc('dispatch_next_candidate', { p_request_id: requestId });
    } catch {
      // dispatch-tick will pick this request up on its next run regardless.
    }
    revalidatePath('/request');
    return { requestId, paymentStatus: 'skipped', paymentClientSecret: null, paymentMethodId: null };
  }

  try {
    const auth = await authorizeRequestPayment(requestId, breakdown.total);
    if (auth.status === 'authorized') {
      try {
        await supabase.rpc('dispatch_next_candidate', { p_request_id: requestId });
      } catch {
        // dispatch-tick will pick this request up on its next run regardless.
      }
    }
    // requires_action / failed: dispatch deliberately does NOT run yet — the
    // client must resolve payment first (see StepPayment.tsx).
    revalidatePath('/request');
    return {
      requestId,
      paymentStatus: auth.status,
      paymentClientSecret: auth.clientSecret,
      paymentMethodId: auth.paymentMethodId,
    };
  } catch {
    revalidatePath('/request');
    return { requestId, paymentStatus: 'failed', paymentClientSecret: null, paymentMethodId: null };
  }
}

// Called after the client completes a 3DS challenge client-side
// (stripe.confirmCardPayment) for a 'requires_action' authorization —
// re-checks the PaymentIntent with Stripe directly (not just trusting that
// the browser reached a "success" screen) and, only if it is now genuinely
// authorized, kicks off dispatch.
export async function resumeAfterPaymentAction(requestId: string): Promise<PaymentStatus> {
  const supabase = await createClient();
  const { data: request } = await supabase.from('requests').select('id, status').eq('id', requestId).single();
  if (!request) throw new Error('Request not found');

  const status = await finalizeAuthorization(requestId);

  if (status === 'authorized' && request.status === 'pending') {
    try {
      await supabase.rpc('dispatch_next_candidate', { p_request_id: requestId });
    } catch {
      // dispatch-tick will pick this request up on its next run regardless.
    }
  }
  revalidatePath('/request');
  return status;
}

// Source of truth for "does this user already have an in-progress
// intervention" — queried fresh on every /request load (server-side, RLS
// scoped to auth.uid() via "requests: user reads own") so a refresh or a
// closed tab never loses the request. Only ever the caller's own rows: RLS
// makes cross-user leakage structurally impossible here, not just unlikely.
export async function getActiveRequest(): Promise<TowRequest | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data, error } = await supabase
    .from('requests')
    .select('*')
    .eq('user_id', user.id)
    .in('status', ACTIVE_REQUEST_STATUSES)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function reassignDriver(requestId: string, driverId: string) {
  const supabase = await createClient();
  const { error } = await supabase
    .from('requests')
    .update({ driver_id: driverId, status: 'pending' })
    .eq('id', requestId);
  if (error) throw error;
  revalidatePath('/request');
}

export async function cancelRequest(requestId: string) {
  const supabase = await createClient();

  // Read the status BEFORE cancelling: whether a driver had already been
  // matched is what decides the economics, and once the row says 'cancelled'
  // that fact is gone.
  const { data: before } = await supabase
    .from('requests')
    .select('status, driver_id')
    .eq('id', requestId)
    .maybeSingle();
  const stage: 'before_match' | 'after_match' =
    before?.driver_id && before.status !== 'pending' ? 'after_match' : 'before_match';

  const { error } = await supabase
    .from('requests')
    .update({ status: 'cancelled' })
    .eq('id', requestId);
  if (error) throw error;

  // A cancellation after a driver was already on their way may carry a fee and
  // a compensation — but only if a cancellation policy has actually been
  // configured. When none has, nothing is charged and nothing is recorded.
  let feeCaptured = false;
  try {
    ({ feeCaptured } = await settleCancellationEconomics(requestId, stage));
  } catch {
    // Falls through to releasing the hold, which is the customer-favourable
    // outcome and the right way to fail.
  }

  // Release the authorization hold. Cancelling used to leave the
  // PaymentIntent at requires_capture, so the rider's card stayed encumbered
  // for days and the payments row never reconciled. Skipped when a
  // cancellation fee was captured from that same authorization — capturing and
  // cancelling one hold are mutually exclusive. Best-effort otherwise: a
  // payment problem must not stop the rider from cancelling.
  if (!feeCaptured) {
    try {
      await cancelRequestPayment(requestId);
    } catch {
      // Swallowed on purpose — see comment above. The webhook remains the
      // authority on the payment's real end state.
    }
  }

  revalidatePath('/request');
}
