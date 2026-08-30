'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import type { RequestStatus, VehicleType } from '@/lib/supabase/types';

export async function updateDriverInfo(input: {
  vehicleType: VehicleType;
  province: string;
  licensePlate: string;
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
      updated_at: new Date().toISOString(),
    })
    .eq('profile_id', user.id);
  if (error) throw error;
  revalidatePath('/dashboard/driver');
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

export async function updateDriverLocation(lat: number, lng: number) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');

  const now = new Date().toISOString();
  await supabase
    .from('driver_profiles')
    .update({ current_lat: lat, current_lng: lng, last_heartbeat_at: now, updated_at: now })
    .eq('profile_id', user.id);
}

// Goes through the accept_request() Postgres function (SECURITY DEFINER)
// instead of a plain UPDATE: two drivers racing to accept the same offer, or
// a driver double-clicking, must not both succeed. The function does the
// pending->matched transition and the driver_id check atomically in a single
// UPDATE ... WHERE, and raises a clean error if 0 rows matched (already
// taken/cancelled) or if it would violate the one-active-job-per-driver
// unique index.
export async function acceptRequest(requestId: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');

  const { error } = await supabase.rpc('accept_request', { p_request_id: requestId });
  if (error) throw error;
  revalidatePath('/dashboard/driver');
}

export async function declineRequest(requestId: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');

  const { error } = await supabase
    .from('requests')
    .update({ driver_id: null })
    .eq('id', requestId)
    .eq('driver_id', user.id)
    .eq('status', 'pending');
  if (error) throw error;
  revalidatePath('/dashboard/driver');
}

export async function advanceRequestStatus(
  requestId: string,
  next: Extract<RequestStatus, 'en_route' | 'arrived' | 'completed'>
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
  const { data: request, error: updateError } = await supabase
    .from('requests')
    .update({ status: next })
    .eq('id', requestId)
    .eq('driver_id', user.id)
    .select('price_estimate')
    .single();
  if (updateError) throw updateError;

  revalidatePath('/dashboard/driver');
  return request;
}
