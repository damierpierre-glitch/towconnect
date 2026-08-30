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

  await supabase
    .from('driver_profiles')
    .update({ current_lat: lat, current_lng: lng, updated_at: new Date().toISOString() })
    .eq('profile_id', user.id);
}

export async function acceptRequest(requestId: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');

  const { error } = await supabase
    .from('requests')
    .update({ status: 'matched' })
    .eq('id', requestId)
    .eq('driver_id', user.id)
    .eq('status', 'pending');
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

  const { data: request, error: updateError } = await supabase
    .from('requests')
    .update({ status: next })
    .eq('id', requestId)
    .eq('driver_id', user.id)
    .select('price_estimate')
    .single();
  if (updateError) throw updateError;

  if (next === 'completed') {
    const { data: driverProfile } = await supabase
      .from('driver_profiles')
      .select('total_services')
      .eq('profile_id', user.id)
      .single();

    await supabase
      .from('driver_profiles')
      .update({ total_services: (driverProfile?.total_services ?? 0) + 1 })
      .eq('profile_id', user.id);
  }

  revalidatePath('/dashboard/driver');
  return request;
}
