'use client';

import Link from 'next/link';
import { useLanguage } from '@/lib/i18n/LanguageProvider';
import { problemLabel } from '@/lib/constants';
import { toMoney } from '@/lib/pricing';
import { Card } from '@/components/ui/Card';
import type { TowRequest } from '@/lib/supabase/types';

export function HistoryList({ completed }: { completed: TowRequest[] }) {
  const { t, lang } = useLanguage();

  return (
    <div className="max-w-2xl mx-auto px-6 py-8">
      <h1 className="font-display text-2xl font-bold mb-1">{t('history_title')}</h1>
      <p className="text-text-2 text-sm mb-6">
        {lang === 'fr' ? 'Ouvrez une intervention pour voir son reçu.' : 'Open an intervention to view its receipt.'}
      </p>

      {completed.length === 0 ? (
        <Card>
          <p className="text-sm text-muted text-center py-4">{t('history_empty')}</p>
        </Card>
      ) : (
        <div className="flex flex-col gap-2">
          {completed.map((r) => (
            <Link key={r.id} href={`/history/${r.id}`}>
              <Card className="hover:border-orange transition-colors">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="font-semibold text-sm">{problemLabel(r.problem_type, lang)}</div>
                    <div className="text-xs text-muted">
                      {new Date(r.created_at).toLocaleDateString(lang === 'fr' ? 'fr-CA' : 'en-CA')} · {r.location_text}
                    </div>
                  </div>
                  <div className="font-display font-bold text-orange">${toMoney(r.price_estimate).toFixed(0)}</div>
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
