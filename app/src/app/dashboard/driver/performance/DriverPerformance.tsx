'use client';

import Link from 'next/link';
import { useLanguage } from '@/lib/i18n/LanguageProvider';
import { Card, StatCard } from '@/components/ui/Card';
import type { DispatchOffer, TowRequest } from '@/lib/supabase/types';

export function DriverPerformance({
  rating,
  totalServices,
  offers,
  requests,
}: {
  rating: number;
  totalServices: number;
  offers: DispatchOffer[];
  requests: TowRequest[];
}) {
  const { lang } = useLanguage();

  const decided = offers.filter((o) => o.status === 'accepted' || o.status === 'declined' || o.status === 'timeout');
  const accepted = offers.filter((o) => o.status === 'accepted');
  const acceptanceRate = decided.length > 0 ? (accepted.length / decided.length) * 100 : null;

  const completed = requests.filter((r) => r.status === 'completed');
  const cancelled = requests.filter((r) => r.status === 'cancelled');
  const completionRate = completed.length + cancelled.length > 0 ? (completed.length / (completed.length + cancelled.length)) * 100 : null;

  // Only offers the driver actually acted on — a timeout's responded_at is
  // when the scheduler swept it up, not a response, and averaging that in
  // would report a fake "the driver answers in under 18 seconds" every time.
  const responded = offers.filter((o) => (o.status === 'accepted' || o.status === 'declined') && o.responded_at);
  const avgResponseSeconds =
    responded.length > 0
      ? responded.reduce((sum, o) => sum + (new Date(o.responded_at!).getTime() - new Date(o.offered_at).getTime()) / 1000, 0) / responded.length
      : null;

  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
      <div className="flex justify-between items-start mb-6 flex-wrap gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold">{lang === 'fr' ? 'Performance' : 'Performance'}</h1>
          <p className="text-text-2 text-sm mt-1">
            {lang === 'fr' ? 'Calculée uniquement à partir de vos courses et offres réelles.' : 'Computed only from your real jobs and offers.'}
          </p>
        </div>
        <Link href="/dashboard/driver" className="text-sm text-orange font-medium">
          {lang === 'fr' ? '← Retour' : '← Back'}
        </Link>
      </div>

      <div className="grid grid-cols-2 gap-3 mb-4">
        <StatCard
          label={lang === 'fr' ? 'Évaluation' : 'Rating'}
          value={totalServices > 0 ? `${rating.toFixed(1)} ⭐` : lang === 'fr' ? 'Nouveau' : 'New'}
        />
        <StatCard label={lang === 'fr' ? 'Services complétés' : 'Completed services'} value={String(totalServices)} />
        <StatCard
          label={lang === 'fr' ? "Taux d'acceptation" : 'Acceptance rate'}
          value={acceptanceRate != null ? `${acceptanceRate.toFixed(0)}%` : '—'}
          change={decided.length > 0 ? `${accepted.length}/${decided.length}` : (lang === 'fr' ? 'Aucune offre reçue' : 'No offers yet')}
        />
        <StatCard
          label={lang === 'fr' ? 'Taux de complétion' : 'Completion rate'}
          value={completionRate != null ? `${completionRate.toFixed(0)}%` : '—'}
          change={completed.length + cancelled.length > 0 ? `${completed.length}/${completed.length + cancelled.length}` : (lang === 'fr' ? 'Aucune course' : 'No jobs yet')}
        />
      </div>

      <Card>
        <h3 className="font-display text-base font-bold mb-3">{lang === 'fr' ? 'Temps de réponse moyen' : 'Average response time'}</h3>
        {avgResponseSeconds != null ? (
          <p className="text-3xl font-display font-bold text-orange">
            {avgResponseSeconds < 60 ? `${avgResponseSeconds.toFixed(0)}s` : `${(avgResponseSeconds / 60).toFixed(1)} min`}
          </p>
        ) : (
          <p className="text-sm text-muted">{lang === 'fr' ? "Pas encore assez de données — vous n'avez pas encore répondu à une offre." : "Not enough data yet — you haven't responded to an offer yet."}</p>
        )}
        <p className="text-xs text-muted mt-2">
          {lang === 'fr'
            ? "Basé sur le temps entre l'offre et votre réponse (accepter ou refuser) — les offres non répondues (expirées) ne sont pas comptées."
            : 'Based on the time between an offer and your response (accept or decline) — unanswered (expired) offers are not counted.'}
        </p>
      </Card>
    </div>
  );
}
