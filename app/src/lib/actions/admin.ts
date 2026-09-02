'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { requireCapability } from '@/lib/auth/capabilities';
import type { DriverApprovalStatus, DriverDocument, DriverDocumentStatus } from '@/lib/supabase/types';

// RLS is the actual enforcement in every function below: a caller without the
// right grant gets zero rows updated, not a bypass. The checks that DO appear
// exist for a different reason — so somebody gets a sentence instead of a
// silent no-op, and so the failure names the capability they are missing.
//
// PHASE 10 SECURITY REVIEW
// Driver documents are identity documents. Until 0048 their policies were
// keyed on is_admin(), which after 0044 meant an administrator granted only
// `finance` could read every driver's licence and insurance — both the row
// and the image behind a signed URL. They are now scoped to `operations`, in
// the database and here.
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
// "driver-documents storage: operations read all" policy (0048) grants that
// session read access to the bucket.
//
// The capability check below is not the protection; the storage policy is. It
// is here so an administrator without `operations` is told which capability
// they are missing, rather than receiving a signed URL that 404s.
export async function getDriverDocumentSignedUrl(storagePath: string): Promise<string> {
  await requireCapability('operations');
  const supabase = await createClient();
  const { data, error } = await supabase.storage.from('driver-documents').createSignedUrl(storagePath, 120);
  if (error || !data) throw error ?? new Error('Could not create a signed URL');
  return data.signedUrl;
}
