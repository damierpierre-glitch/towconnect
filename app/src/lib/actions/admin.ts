'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import type { DriverApprovalStatus, DriverDocument, DriverDocumentStatus } from '@/lib/supabase/types';

// No explicit "is this caller an admin?" check in any function below — same
// as the pre-Phase-5 version of this file. RLS is the actual enforcement
// ("driver_profiles: admins full access" / "driver_documents: admins full
// access", both gated on public.is_admin()); a non-admin session gets 0 rows
// updated, not a bypass. Checking here too would just be a second copy of
// the same rule to keep in sync.
async function setDriverApproval(profileId: string, status: DriverApprovalStatus, rejectionReason: string | null) {
  const supabase = await createClient();
  const { error } = await supabase
    .from('driver_profiles')
    .update({ approval_status: status, rejection_reason: rejectionReason })
    .eq('profile_id', profileId);
  if (error) throw error;
  revalidatePath('/dashboard/admin');
}

export async function approveDriver(profileId: string) {
  // Clears any earlier rejection reason — an approved driver shouldn't carry
  // a stale "why you were rejected" note into their own profile page.
  return setDriverApproval(profileId, 'approved', null);
}

export async function rejectDriver(profileId: string, reason: string) {
  return setDriverApproval(profileId, 'rejected', reason.trim() || null);
}

export interface PendingDriverDocument extends DriverDocument {
  driverName: string;
}

// Every document currently pending review, across every driver — the
// admin's one queue, not split per-driver. Documents belonging to an
// already-approved or already-rejected driver still show up here if that
// specific document hasn't been looked at yet (e.g. a re-upload after a
// rejection), which is deliberate: review is per-document, not a single
// gate the driver only passes through once.
export async function listPendingDriverDocuments(): Promise<PendingDriverDocument[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('driver_documents')
    .select('*, profiles!driver_documents_driver_id_fkey(full_name)')
    .eq('status', 'pending')
    .order('uploaded_at', { ascending: true });
  if (error) throw error;
  return (data ?? []).map((row) => {
    const profile = row.profiles as unknown as { full_name: string } | { full_name: string }[] | null;
    const resolved = Array.isArray(profile) ? profile[0] : profile;
    return { ...row, driverName: resolved?.full_name || '—' };
  });
}

export async function reviewDriverDocument(documentId: string, status: DriverDocumentStatus, reason?: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');

  const { error } = await supabase
    .from('driver_documents')
    .update({
      status,
      rejection_reason: status === 'rejected' ? reason?.trim() || null : null,
      reviewed_at: new Date().toISOString(),
      reviewed_by: user.id,
    })
    .eq('id', documentId);
  if (error) throw error;
  revalidatePath('/dashboard/admin');
}

// A time-limited link into the private driver-documents bucket. Works from
// the admin's own session — no service-role key involved — because the
// "driver-documents storage: admins read all" policy (0019) already grants
// this session read access to every path in the bucket.
export async function getDriverDocumentSignedUrl(storagePath: string): Promise<string> {
  const supabase = await createClient();
  const { data, error } = await supabase.storage.from('driver-documents').createSignedUrl(storagePath, 120);
  if (error || !data) throw error ?? new Error('Could not create a signed URL');
  return data.signedUrl;
}
