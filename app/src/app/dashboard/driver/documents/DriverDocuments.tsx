'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';
import { useLanguage } from '@/lib/i18n/LanguageProvider';
import { useToast } from '@/components/ToastProvider';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Label, Select } from '@/components/ui/Field';
import { DRIVER_DOCUMENT_TYPES, driverDocumentLabel } from '@/lib/constants';
import { deleteDriverDocument, uploadDriverDocument } from '@/lib/actions/driverDocuments';
import type { DriverDocument, DriverDocumentType } from '@/lib/supabase/types';

// Same shape a server error thrown by uploadDriverDocument()/Storage takes —
// good enough to show the driver something more useful than "error_generic"
// for the cases they can actually act on (file too big, wrong type).
function errorMessage(err: unknown, lang: 'fr' | 'en'): string {
  const msg = err instanceof Error ? err.message : '';
  if (/8 MB/i.test(msg)) return lang === 'fr' ? 'Le fichier dépasse 8 Mo.' : 'File exceeds 8 MB.';
  if (/Unsupported file type/i.test(msg))
    return lang === 'fr' ? 'Format non supporté (photo ou PDF seulement).' : 'Unsupported format (photo or PDF only).';
  return lang === 'fr' ? 'Une erreur est survenue.' : 'Something went wrong.';
}

// expires_at is driver-supplied and nothing server-side acts on it yet
// (0019_driver_documents.sql) — this is purely a display computation so an
// obviously-expired document doesn't read as "Approved" forever.
function isPastExpiry(expiresAt: string | null): boolean {
  if (!expiresAt) return false;
  return new Date(expiresAt) < new Date(new Date().toDateString());
}

export function DriverDocuments({ initialDocuments }: { initialDocuments: DriverDocument[] }) {
  const { lang } = useLanguage();
  const { showToast } = useToast();
  const [documents, setDocuments] = useState(initialDocuments);
  const [type, setType] = useState<DriverDocumentType>('license');
  const [uploading, setUploading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function handleUpload(e: React.FormEvent) {
    e.preventDefault();
    const file = fileInputRef.current?.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const formData = new FormData();
      formData.set('file', file);
      formData.set('type', type);
      const created = await uploadDriverDocument(formData);
      setDocuments((prev) => [created, ...prev]);
      if (fileInputRef.current) fileInputRef.current.value = '';
      showToast('✅', lang === 'fr' ? 'Document envoyé.' : 'Document uploaded.');
    } catch (err) {
      showToast('⚠️', errorMessage(err, lang));
    } finally {
      setUploading(false);
    }
  }

  async function handleDelete(doc: DriverDocument) {
    if (!window.confirm(lang === 'fr' ? 'Supprimer ce document?' : 'Delete this document?')) return;
    setBusyId(doc.id);
    try {
      await deleteDriverDocument(doc.id, doc.storage_path);
      setDocuments((prev) => prev.filter((d) => d.id !== doc.id));
    } catch {
      showToast('⚠️', lang === 'fr' ? 'Une erreur est survenue.' : 'Something went wrong.');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
      <div className="flex justify-between items-start mb-6 flex-wrap gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold">{lang === 'fr' ? 'Mes documents' : 'My documents'}</h1>
          <p className="text-text-2 text-sm mt-1">
            {lang === 'fr'
              ? "Requis pour l'approbation de votre compte."
              : 'Required for your account to be approved.'}
          </p>
        </div>
        <Link href="/dashboard/driver" className="text-sm text-orange font-medium">
          {lang === 'fr' ? '← Retour' : '← Back'}
        </Link>
      </div>

      <Card orange className="mb-4">
        <h3 className="font-display text-base font-bold mb-4">{lang === 'fr' ? 'Ajouter un document' : 'Add a document'}</h3>
        <form onSubmit={handleUpload} className="flex flex-col gap-3">
          <div>
            <Label>{lang === 'fr' ? 'Type de document' : 'Document type'}</Label>
            <Select value={type} onChange={(e) => setType(e.target.value as DriverDocumentType)}>
              {DRIVER_DOCUMENT_TYPES.map((d) => (
                <option key={d.key} value={d.key}>
                  {d.icon} {lang === 'fr' ? d.fr : d.en}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label>{lang === 'fr' ? 'Photo ou PDF' : 'Photo or PDF'}</Label>
            <input
              ref={fileInputRef}
              type="file"
              required
              accept="image/jpeg,image/png,image/webp,application/pdf"
              className="w-full text-sm text-text-2 file:mr-3 file:px-4 file:py-2.5 file:rounded-xl file:border-0 file:bg-orange file:text-white file:font-semibold file:text-sm"
            />
          </div>
          <Button type="submit" full size="lg" disabled={uploading}>
            {uploading ? '…' : lang === 'fr' ? '📤 Envoyer' : '📤 Upload'}
          </Button>
        </form>
      </Card>

      {documents.length === 0 ? (
        <Card>
          <p className="text-sm text-muted text-center py-4">
            {lang === 'fr' ? 'Aucun document envoyé pour le moment.' : 'No document uploaded yet.'}
          </p>
        </Card>
      ) : (
        <div className="flex flex-col gap-2">
          {documents.map((doc) => {
            const expired = doc.status === 'approved' && isPastExpiry(doc.expires_at);
            const tone = expired ? 'red' : doc.status === 'approved' ? 'green' : doc.status === 'rejected' ? 'red' : doc.status === 'expired' ? 'red' : 'yellow';
            const label = expired
              ? lang === 'fr'
                ? 'Expiré'
                : 'Expired'
              : doc.status === 'approved'
                ? lang === 'fr'
                  ? 'Approuvé'
                  : 'Approved'
                : doc.status === 'rejected'
                  ? lang === 'fr'
                    ? 'Rejeté'
                    : 'Rejected'
                  : doc.status === 'expired'
                    ? lang === 'fr'
                      ? 'Expiré'
                      : 'Expired'
                    : lang === 'fr'
                      ? 'En révision'
                      : 'Under review';
            return (
              <Card key={doc.id}>
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div>
                    <div className="font-semibold text-sm">{driverDocumentLabel(doc.type, lang)}</div>
                    <div className="text-xs text-muted mt-0.5">
                      {new Date(doc.uploaded_at).toLocaleDateString(lang === 'fr' ? 'fr-CA' : 'en-CA')}
                      {doc.expires_at
                        ? ` · ${lang === 'fr' ? 'expire le' : 'expires'} ${new Date(doc.expires_at).toLocaleDateString(lang === 'fr' ? 'fr-CA' : 'en-CA')}`
                        : ''}
                    </div>
                    {doc.status === 'rejected' && doc.rejection_reason ? (
                      <div className="text-xs text-red mt-1">
                        {lang === 'fr' ? 'Motif : ' : 'Reason: '}
                        {doc.rejection_reason}
                      </div>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge tone={tone}>{label}</Badge>
                    {doc.status !== 'approved' ? (
                      <Button
                        variant="red"
                        className="!px-3 !py-1.5 text-xs"
                        disabled={busyId === doc.id}
                        onClick={() => handleDelete(doc)}
                      >
                        {lang === 'fr' ? 'Supprimer' : 'Delete'}
                      </Button>
                    ) : null}
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
