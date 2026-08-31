'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import type { Vehicle } from '@/lib/supabase/types';

export interface VehicleInput {
  make: string;
  model: string;
  year: number;
  color?: string | null;
  plate?: string | null;
  province?: string | null;
}

export async function getVehicles(): Promise<Vehicle[]> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return [];

  const { data, error } = await supabase
    .from('vehicles')
    .select('*')
    .eq('user_id', user.id)
    .order('is_primary', { ascending: false })
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data ?? [];
}

export async function createVehicle(input: VehicleInput): Promise<Vehicle> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');

  // First vehicle for this account becomes the primary automatically — no
  // extra step for the common single-vehicle case.
  const { count } = await supabase
    .from('vehicles')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', user.id);

  const { data, error } = await supabase
    .from('vehicles')
    .insert({
      user_id: user.id,
      make: input.make,
      model: input.model,
      year: input.year,
      color: input.color || null,
      plate: input.plate || null,
      province: input.province || null,
      is_primary: (count ?? 0) === 0,
    })
    .select('*')
    .single();
  if (error) throw error;

  revalidatePath('/vehicles');
  revalidatePath('/request');
  return data;
}

export async function updateVehicle(id: string, input: VehicleInput): Promise<void> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');

  const { error } = await supabase
    .from('vehicles')
    .update({
      make: input.make,
      model: input.model,
      year: input.year,
      color: input.color || null,
      plate: input.plate || null,
      province: input.province || null,
    })
    .eq('id', id)
    .eq('user_id', user.id);
  if (error) throw error;

  revalidatePath('/vehicles');
  revalidatePath('/request');
}

export async function deleteVehicle(id: string): Promise<void> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');

  const { data: deleted, error } = await supabase
    .from('vehicles')
    .delete()
    .eq('id', id)
    .eq('user_id', user.id)
    .select('is_primary')
    .single();
  if (error) throw error;

  // If the deleted vehicle was the primary one and others remain, promote
  // the most recently added remaining vehicle so the account always has a
  // clear primary whenever it has at least one vehicle.
  if (deleted?.is_primary) {
    const { data: remaining } = await supabase
      .from('vehicles')
      .select('id')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (remaining) {
      await supabase.from('vehicles').update({ is_primary: true }).eq('id', remaining.id);
    }
  }

  revalidatePath('/vehicles');
  revalidatePath('/request');
}

// Two sequential updates, not one: a single UPDATE touching both the old and
// new primary rows can't safely guarantee the partial unique index
// (vehicles_one_primary_per_user) never transiently sees two `true` rows for
// the same user, depending on row processing order. Clearing first, then
// setting, is dumb-simple and hits the constraint at most once, correctly.
export async function setPrimaryVehicle(id: string): Promise<void> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');

  const { error: clearError } = await supabase
    .from('vehicles')
    .update({ is_primary: false })
    .eq('user_id', user.id)
    .eq('is_primary', true);
  if (clearError) throw clearError;

  const { error: setError } = await supabase
    .from('vehicles')
    .update({ is_primary: true })
    .eq('id', id)
    .eq('user_id', user.id);
  if (setError) throw setError;

  revalidatePath('/vehicles');
  revalidatePath('/request');
}
