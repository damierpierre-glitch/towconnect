'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useLanguage } from '@/lib/i18n/LanguageProvider';
import { problemLabel } from '@/lib/constants';
import { toMoney } from '@/lib/pricing';
import { Card, StatCard } from '@/components/ui/Card';
import type { TowRequest } from '@/lib/supabase/types';

const DAY_MS = 24 * 60 * 60 * 1000;

export function DriverEarnings({ completed }: { completed: TowRequest[] }) {
  const { lang } = useLanguage();

  // Lazy initializer, not a render-time call — a snapshot taken once when
  // this component mounts is all "last 7/30 days" needs; it doesn't have to
  // tick live like the dashboard's heartbeat clock does.
  const [now] = useState(() => Date.now());
  const sumSince = (ms: number) => completed.filter((r) => now - new Date(r.created_at).getTime() < ms).reduce((s, r) => s + toMoney(r.price_estimate), 0);
  const countSince = (ms: number) => completed.filter((r) => now - new Date(r.created_at).getTime() < ms).length;

  const todaySet = completed.filter((r) => new Date(r.created_at).toDateString() === new Date().toDateString());
  const todaySum = todaySet.reduce((s, r) => s + toMoney(r.price_estimate), 0);
  const last7Sum = sumSince(7 * DAY_MS);
  const last30Sum = sumSince(30 * DAY_MS);
  const allTimeSum = completed.reduce((s, r) => s + toMoney(r.price_estimate), 0);

  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
      <div className="flex justify-between items-start mb-6 flex-wrap gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold">{lang === 'fr' ? 'Mes revenus' : 'My earnings'}</h1>
          <p className="text-text-2 text-sm mt-1">
            {lang === 'fr' ? 'Basé uniquement sur vos courses complétées.' : 'Based only on your completed jobs.'}
          </p>
        </div>
        <Link href="/dashboard/driver" className="text-sm text-orange font-medium">
          {lang === 'fr' ? '← Retour' : '← Back'}
        </Link>
      </div>

      <Card className="mb-6 !bg-night-3">
        <p className="text-xs text-text-2">
          {lang === 'fr'
            ? "Le taux de commission TowConnect n'est pas encore déterminé — ces montants affichent le prix total de chaque course, pas encore une part partenaire séparée. Ils changeront une fois la commission activée."
            : "TowConnect's commission rate has not been set yet — these amounts show each job's full price, not a separate partner share. They will change once commission is turned on."}
        </p>
      </Card>

      <div className="grid grid-cols-2 gap-3 mb-4">
        <StatCard label={lang === 'fr' ? "Aujourd'hui" : 'Today'} value={`$${todaySum.toFixed(0)}`} change={`${todaySet.length} ${lang === 'fr' ? 'course(s)' : 'job(s)'}`} />
        <StatCard label={lang === 'fr' ? '7 derniers jours' : 'Last 7 days'} value={`$${last7Sum.toFixed(0)}`} change={`${countSince(7 * DAY_MS)} ${lang === 'fr' ? 'course(s)' : 'job(s)'}`} />
        <StatCard label={lang === 'fr' ? '30 derniers jours' : 'Last 30 days'} value={`$${last30Sum.toFixed(0)}`} change={`${countSince(30 * DAY_MS)} ${lang === 'fr' ? 'course(s)' : 'job(s)'}`} />
        <StatCard label={lang === 'fr' ? 'Total (historique)' : 'All-time'} value={`$${allTimeSum.toFixed(0)}`} change={`${completed.length} ${lang === 'fr' ? 'course(s)' : 'job(s)'}`} />
      </div>

      <Card>
        <div className="flex justify-between items-center mb-4">
          <h3 className="font-display text-base font-bold">{lang === 'fr' ? 'Courses récentes' : 'Recent jobs'}</h3>
          <Link href="/dashboard/driver/history" className="text-sm text-orange font-medium">
            {lang === 'fr' ? 'Historique complet →' : 'Full history →'}
          </Link>
        </div>
        {completed.length === 0 ? (
          <p className="text-sm text-muted text-center py-2">{lang === 'fr' ? 'Aucune course complétée pour le moment.' : 'No completed jobs yet.'}</p>
        ) : (
          <div className="flex flex-col gap-2">
            {completed.slice(0, 8).map((r) => (
              <div key={r.id} className="flex items-center justify-between gap-3 py-1.5 border-b border-steel/50 last:border-none">
                <div>
                  <div className="text-sm font-medium">{problemLabel(r.problem_type, lang)}</div>
                  <div className="text-xs text-muted">{new Date(r.created_at).toLocaleDateString(lang === 'fr' ? 'fr-CA' : 'en-CA')}</div>
                </div>
                <div className="font-display font-bold text-green">${toMoney(r.price_estimate).toFixed(0)}</div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
