'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';

export interface CreateRequestInput {
  problemType: string;
  locationText: string;
  lat: number;
  lng: number;
  vehicleDesc: string;
  notes: string;
  driverId: string;
  price: number;
}

export async function createRequest(input: CreateRequestInput) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');

  const { data, error } = await supabase
    .from('requests')
    .insert({
      user_id: user.id,
      driver_id: input.driverId,
      problem_type: input.problemType,
      location_text: input.locationText,
      lat: input.lat,
      lng: input.lng,
      vehicle_desc: input.vehicleDesc,
      notes: input.notes,
      status: 'pending',
      price_estimate: input.price,
    })
    .select('id')
    .single();

  if (error) throw error;
  revalidatePath('/request');
  return data.id as string;
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
  const { error } = await supabase
    .from('requests')
    .update({ status: 'cancelled' })
    .eq('id', requestId);
  if (error) throw error;
  revalidatePath('/request');
}
