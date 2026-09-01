'use client';

import Link from 'next/link';
import { useLanguage } from '@/lib/i18n/LanguageProvider';
import { problemLabel } from '@/lib/constants';
import { toMoney } from '@/lib/pricing';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import type { TowRequest } from '@/lib/supabase/types';

export function JobDetail({ request, clientName }: { request: TowRequest; clientName: string | null }) {
  const { lang } = useLanguage();

  const base = toMoney(request.price_base);
  const distance = toMoney(request.price_distance);
  const surcharge = toMoney(request.price_surcharge);
  const total = toMoney(request.price_estimate);
  const towKm = request.tow_distance_km == null ? null : toMoney(request.tow_distance_km);

  return (
    <div className="max-w-md mx-auto px-4 sm:px-6 py-6 sm:py-8">
      <Link href="/dashboard/driver/history" className="text-sm text-orange font-medium">
        {lang === 'fr' ? '← Retour à l’historique' : '← Back to history'}
      </Link>

      <Card className="mt-4">
        <div className="text-center pb-5 border-b border-steel/60 mb-5">
          <div className="text-3xl mb-2">{request.status === 'completed' ? '🎉' : '❌'}</div>
          <h1 className="font-display text-xl font-bold">{problemLabel(request.problem_type, lang)}</h1>
          <p className="text-xs text-muted mt-1">#{request.id.slice(0, 8)}</p>
          <div className="mt-2">
            <Badge tone={request.status === 'completed' ? 'green' : 'red'}>
              {request.status === 'completed' ? (lang === 'fr' ? 'Complété' : 'Completed') : lang === 'fr' ? 'Annulé' : 'Cancelled'}
            </Badge>
          </div>
        </div>

        <dl className="flex flex-col gap-3 text-sm mb-5">
          <Row label={lang === 'fr' ? 'Date' : 'Date'} value={new Date(request.created_at).toLocaleString(lang === 'fr' ? 'fr-CA' : 'en-CA')} />
          {clientName ? <Row label={lang === 'fr' ? 'Client' : 'Client'} value={clientName} /> : null}
          <Row label={lang === 'fr' ? 'Point de ramassage' : 'Pickup'} value={request.location_text} />
          {request.destination_address ? <Row label={lang === 'fr' ? 'Destination' : 'Destination'} value={request.destination_address} /> : null}
          {request.vehicle_desc ? <Row label={lang === 'fr' ? 'Véhicule' : 'Vehicle'} value={request.vehicle_desc} /> : null}
        </dl>

        {request.status === 'completed' ? (
          <div className="border-t border-steel/60 pt-4">
            <PriceLine label={lang === 'fr' ? 'Frais de base' : 'Base fare'} value={base} />
            <PriceLine
              label={towKm != null ? `${lang === 'fr' ? 'Distance' : 'Distance'} · ${towKm.toFixed(1)} km` : lang === 'fr' ? 'Distance' : 'Distance'}
              value={distance}
            />
            {surcharge > 0 ? <PriceLine label={lang === 'fr' ? 'Supplément' : 'Surcharge'} value={surcharge} /> : null}
            <div className="flex justify-between items-center pt-2 mt-2 border-t border-steel/60">
              <span className="font-semibold">{lang === 'fr' ? 'Montant de la course' : 'Job total'}</span>
              <span className="font-display text-xl font-bold text-orange">${total.toFixed(2)}</span>
            </div>
            <p className="text-xs text-muted mt-2">
              {lang === 'fr'
                ? "Le taux de commission TowConnect n'est pas encore déterminé — ce montant est le prix total de la course."
                : "TowConnect's commission rate has not been set yet — this is the job's full price."}
            </p>
          </div>
        ) : null}
      </Card>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-muted shrink-0">{label}</dt>
      <dd className="text-right font-medium">{value}</dd>
    </div>
  );
}

function PriceLine({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex justify-between text-sm text-text-2 py-0.5">
      <span>{label}</span>
      <span>${value.toFixed(2)}</span>
    </div>
  );
}
