'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { captureRequestPayment } from '@/lib/actions/payments';
import type { RequestStatus, VehicleType } from '@/lib/supabase/types';

export async function updateDriverInfo(input: {
  vehicleType: VehicleType;
  province: string;
  licensePlate: string;
  phone?: string;
  serviceTypes?: string[];
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');

  const { error } = await supabase
    .from('driver_profiles')
    .update({
      vehicle_type: input.vehicleType,
      province: input.province,
      license_plate: input.licensePlate,
      ...(input.serviceTypes ? { service_types: input.serviceTypes } : {}),
      updated_at: new Date().toISOString(),
    })
    .eq('profile_id', user.id);
  if (error) throw error;

  // profiles.phone lives on a different table (shared with the rider role) —
  // a separate write, same session, same "profiles: update own" policy
  // (0001_init.sql) every account already has.
  if (input.phone !== undefined) {
    const { error: phoneError } = await supabase.from('profiles').update({ phone: input.phone || null }).eq('id', user.id);
    if (phoneError) throw phoneError;
  }

  revalidatePath('/dashboard/driver');
  revalidatePath('/dashboard/driver/profile');
}

export async function toggleOnline(isOnline: boolean) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');

  const { error } = await supabase
    .from('driver_profiles')
    .update({ is_online: isOnline, updated_at: new Date().toISOString() })
    .eq('profile_id', user.id);
  if (error) throw error;
  revalidatePath('/dashboard/driver');
}

// Returns whether the write actually landed instead of swallowing the
// result, so the dashboard can distinguish "GPS worked, the network didn't"
// from silence — see the online/offline UX notes in
// TOWCONNECT_PHASE5_REPORT.md.
export async function updateDriverLocation(lat: number, lng: number): Promise<{ ok: boolean }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false };

  const now = new Date().toISOString();
  const { error } = await supabase
    .from('driver_profiles')
    .update({ current_lat: lat, current_lng: lng, last_heartbeat_at: now, updated_at: now })
    .eq('profile_id', user.id);
  return { ok: !error };
}

// Goes through respond_to_dispatch_offer() (SECURITY DEFINER), which itself
// calls the original accept_request() Postgres function for the actual
// pending->matched transition — same atomic UPDATE ... WHERE and
// one-active-job-per-driver guard as before, not reimplemented. The wrapper
// additionally rejects an expired offer outright and settles the
// dispatch_offers bookkeeping (marks it 'accepted') in the same call.
export async function acceptRequest(requestId: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');

  const { error } = await supabase.rpc('respond_to_dispatch_offer', {
    p_request_id: requestId,
    p_accept: true,
  });

  if (error) {
    // The offer lapsed while this driver was looking at it. The RPC refuses
    // it (that guarantee is absolute) but cannot itself record the timeout —
    // its own RAISE rolls the write back. Sweep it here instead, in a fresh
    // transaction, so the stale offer is settled and the request moves on to
    // the next candidate immediately rather than waiting for a poll or the
    // dispatch-tick cron. Best-effort: the accept has already failed and
    // that is what the caller must be told about.
    if (/expired/i.test(error.message)) {
      try {
        await supabase.rpc('nudge_dispatch', { p_request_id: requestId });
      } catch {
        // dispatch-tick remains the backstop.
      }
    }
    throw error;
  }

  revalidatePath('/dashboard/driver');
}

// Same wrapper, decline path: clears requests.driver_id (identical predicate
// to the old plain UPDATE) and marks the dispatch_offers row 'declined'.
// dispatch-tick then offers the request to the next-best candidate — the
// driver never sees a list to manually pass to someone else.
export async function declineRequest(requestId: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');

  const { error } = await supabase.rpc('respond_to_dispatch_offer', {
    p_request_id: requestId,
    p_accept: false,
  });
  if (error) throw error;
  revalidatePath('/dashboard/driver');
}

export async function advanceRequestStatus(
  requestId: string,
  next: Extract<RequestStatus, 'en_route' | 'arrived' | 'in_progress' | 'completed'>
) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');

  // Marking a job 'completed' also bumps driver_profiles.total_services, but
  // that increment happens server-side in a trigger (bump_driver_total_services
  // in 0003_lockdown_driver_fields.sql), not here — total_services is locked
  // down against direct writes from a driver's own session (same class of
  // bug as the approval_status self-approval fix in 0002).
  //
  // The UPDATE itself only names *this* driver's row (same predicate as
  // before), but Phase 3 adds a second, independent layer: the
  // requests_guard_status_transition trigger (0010_request_status_guard.sql)
  // rejects the write outright if `next` isn't the one valid next step from
  // the request's current status — skipping a state, or moving backwards,
  // fails server-side even if this function is bypassed and called directly.
  const { data: request, error: updateError } = await supabase
    .from('requests')
    .update({ status: next })
    .eq('id', requestId)
    .eq('driver_id', user.id)
    .select('price_estimate')
    .single();
  if (updateError) throw updateError;

  // Capture happens on completion, not before — see "authorize now, capture
  // on completion" in TOWCONNECT_PHASE4_REPORT.md. Never blocks the
  // driver's own workflow: a payment problem is a payment problem, not a
  // reason the job can't be marked done. Swallow any failure here; the
  // capture attempt itself already records 'failed' with a reason on the
  // payments row for support to follow up on.
  if (next === 'completed') {
    try {
      await captureRequestPayment(requestId);
    } catch {
      // Intentionally swallowed — see comment above.
    }
  }

  revalidatePath('/dashboard/driver');
  return request;
}
