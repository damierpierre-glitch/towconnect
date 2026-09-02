'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import type { DriverDocument, DriverDocumentType } from '@/lib/supabase/types';

const DOCUMENT_TYPES: DriverDocumentType[] = ['license', 'insurance', 'registration', 'tow_certificate', 'other'];
// Photos of paper documents (the realistic case for most drivers) plus PDF
// scans. No video, no arbitrary binary — the storage RLS policy scopes
// *where* a driver can write, not *what*; this is the content-level check.
const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
const MAX_BYTES = 8 * 1024 * 1024;

export async function listDriverDocuments(): Promise<DriverDocument[]> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return [];

  const { data, error } = await supabase
    .from('driver_documents')
    .select('*')
    .eq('driver_id', user.id)
    .order('uploaded_at', { ascending: false });
  if (error) throw error;
  return data ?? [];
}

// Uploads the file to the driver's own folder in the private
// `driver-documents` bucket, then records it — both writes run under the
// driver's own session (createClient() is the cookie-bound server client,
// not the service role), so storage RLS and the driver_documents "insert
// own pending" policy both apply exactly as they would from the browser.
export async function uploadDriverDocument(formData: FormData): Promise<DriverDocument> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');

  const file = formData.get('file');
  const type = formData.get('type');
  if (!(file instanceof File)) throw new Error('No file provided');
  if (typeof type !== 'string' || !DOCUMENT_TYPES.includes(type as DriverDocumentType)) {
    throw new Error('Invalid document type');
  }
  if (file.size === 0) throw new Error('Empty file');
  if (file.size > MAX_BYTES) throw new Error('File exceeds the 8 MB limit');
  if (!ALLOWED_MIME_TYPES.includes(file.type)) throw new Error('Unsupported file type');

  const ext = file.type === 'application/pdf' ? 'pdf' : (file.name.split('.').pop() ?? 'jpg').toLowerCase();
  // Path convention the storage policies key off (0019_driver_documents.sql):
  // the first segment must equal the caller's own auth.uid().
  const path = `${user.id}/${crypto.randomUUID()}.${ext}`;

  const { error: uploadError } = await supabase.storage
    .from('driver-documents')
    .upload(path, file, { contentType: file.type, upsert: false });
  if (uploadError) throw uploadError;

  const { data, error: insertError } = await supabase
    .from('driver_documents')
    .insert({ driver_id: user.id, type: type as DriverDocumentType, storage_path: path })
    .select('*')
    .single();
  if (insertError) {
    // The table insert is what makes the upload real; if it fails, don't
    // leave an orphaned file behind that the driver can't see or manage.
    await supabase.storage.from('driver-documents').remove([path]);
    throw insertError;
  }

  revalidatePath('/dashboard/driver/documents');
  return data;
}

// RLS already refuses this outright for an approved document (no DELETE
// policy matches), so the guard here is for a clean error message, not
// security — the database is the actual enforcement.
export async function deleteDriverDocument(id: string, storagePath: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');

  const { error } = await supabase.from('driver_documents').delete().eq('id', id).eq('driver_id', user.id);
  if (error) throw error;

  // Best-effort cleanup of the underlying file. The storage delete policy
  // requires the driver_documents row to already be gone (or never have
  // existed) for a non-approved document, so this always follows the table
  // delete above, never races it.
  await supabase.storage.from('driver-documents').remove([storagePath]);
  revalidatePath('/dashboard/driver/documents');
}
