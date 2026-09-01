'use client';

import Link from 'next/link';
import { useLanguage } from '@/lib/i18n/LanguageProvider';
import { problemLabel } from '@/lib/constants';
import { toMoney } from '@/lib/pricing';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import type { TowRequest } from '@/lib/supabase/types';

export function DriverHistory({ requests }: { requests: TowRequest[] }) {
  const { lang } = useLanguage();

  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
      <div className="flex justify-between items-start mb-6 flex-wrap gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold">{lang === 'fr' ? 'Historique' : 'History'}</h1>
          <p className="text-text-2 text-sm mt-1">
            {lang === 'fr' ? 'Toutes vos courses, complétées ou annulées.' : 'All your jobs, completed or cancelled.'}
          </p>
        </div>
        <Link href="/dashboard/driver" className="text-sm text-orange font-medium">
          {lang === 'fr' ? '← Retour' : '← Back'}
        </Link>
      </div>

      {requests.length === 0 ? (
        <Card>
          <p className="text-sm text-muted text-center py-4">{lang === 'fr' ? 'Aucune course pour le moment.' : 'No jobs yet.'}</p>
        </Card>
      ) : (
        <div className="flex flex-col gap-2">
          {requests.map((r) => (
            <Link key={r.id} href={`/dashboard/driver/history/${r.id}`}>
              <Card className="hover:border-orange transition-colors">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-semibold text-sm">{problemLabel(r.problem_type, lang)}</div>
                    <div className="text-xs text-muted truncate">
                      {new Date(r.created_at).toLocaleDateString(lang === 'fr' ? 'fr-CA' : 'en-CA')} · {r.location_text}
                      {r.destination_address ? ` → ${r.destination_address}` : ''}
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-1 shrink-0">
                    <Badge tone={r.status === 'completed' ? 'green' : 'red'}>
                      {r.status === 'completed' ? (lang === 'fr' ? 'Complété' : 'Completed') : lang === 'fr' ? 'Annulé' : 'Cancelled'}
                    </Badge>
                    <div className="font-display font-bold text-orange">${toMoney(r.price_estimate).toFixed(0)}</div>
                  </div>
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
