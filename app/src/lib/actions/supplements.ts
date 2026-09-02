'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { settleApprovedSupplement } from '@/lib/actions/finance';
import type { RequestSupplement, ServiceSupplementType } from '@/lib/supabase/types';

// The product rule is "no surprise supplement". The database rule that makes
// it true lives in 0027: only the assigned driver can propose, only the
// customer can approve, and an approved row is frozen. Nothing here re-states
// those checks — it would be a second copy of them — these functions just
// give the two screens a way to ask.

export async function listSupplementTypes(): Promise<ServiceSupplementType[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('service_supplement_types')
    .select('*')
    .eq('active', true)
    .order('key');
  if (error) throw error;
  return data ?? [];
}

export async function listRequestSupplements(requestId: string): Promise<RequestSupplement[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('request_supplements')
    .select('*')
    .eq('request_id', requestId)
    .order('created_at');
  if (error) throw error;
  return data ?? [];
}

export async function proposeSupplement(requestId: string, typeKey: string, amount: number, note: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');

  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('A supplement needs a real amount.');
  }

  const { error } = await supabase.from('request_supplements').insert({
    request_id: requestId,
    type_key: typeKey,
    amount: Math.round(amount * 100) / 100,
    note: note.trim() || null,
    status: 'proposed',
    proposed_by: user.id,
  });
  if (error) throw error;
  revalidatePath('/dashboard/driver');
}

// Only ever called from the customer's own screen. If anyone else calls it,
// the guard trigger raises — the policy alone cannot express "the payer
// decides", so the trigger does.
export async function respondToSupplement(supplementId: string, approve: boolean) {
  const supabase = await createClient();
  const { error } = await supabase
    .from('request_supplements')
    .update({ status: approve ? 'approved' : 'declined' })
    .eq('id', supplementId);
  if (error) throw error;

  // Approving is the customer agreeing to pay more, so the money has to be
  // secured now rather than assumed at capture time. Best-effort: the
  // approval itself has committed, and settleApprovedSupplement() records
  // 'uncollected' with a reason when the hold cannot be increased — it never
  // pretends the money is there.
  if (approve) {
    try {
      await settleApprovedSupplement(supplementId);
    } catch {
      // The supplement stays 'pending' and uncredited, which is the safe end.
    }
  }

  revalidatePath('/request');
}

export async function withdrawSupplement(supplementId: string) {
  const supabase = await createClient();
  const { error } = await supabase
    .from('request_supplements')
    .update({ status: 'cancelled' })
    .eq('id', supplementId);
  if (error) throw error;
  revalidatePath('/dashboard/driver');
}

// What the driver will actually be paid for this job — or null, which is the
// honest answer while no commission rate is configured. The caller must
// render nothing for null; never a zero, never an estimate.
export async function getProviderCompensation(requestId: string): Promise<number | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('request_provider_compensation', { p_request_id: requestId });
  if (error) return null;
  if (data == null) return null;
  const n = typeof data === 'number' ? data : parseFloat(String(data));
  return Number.isFinite(n) ? n : null;
}
