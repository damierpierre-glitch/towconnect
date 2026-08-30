'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import type { DriverApprovalStatus } from '@/lib/supabase/types';

async function setDriverApproval(profileId: string, status: DriverApprovalStatus) {
  const supabase = await createClient();
  const { error } = await supabase
    .from('driver_profiles')
    .update({ approval_status: status })
    .eq('profile_id', profileId);
  if (error) throw error;
  revalidatePath('/dashboard/admin');
}

export async function approveDriver(profileId: string) {
  return setDriverApproval(profileId, 'approved');
}

export async function rejectDriver(profileId: string) {
  return setDriverApproval(profileId, 'rejected');
}
