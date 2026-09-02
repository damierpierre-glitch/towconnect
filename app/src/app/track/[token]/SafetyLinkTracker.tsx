'use client';

import { useEffect, useMemo, useState } from 'react';
import { useLanguage } from '@/lib/i18n/LanguageProvider';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { MapView, type MapMarker } from '@/components/LazyMapView';
import { problemLabel } from '@/lib/constants';
import { distanceKm, estimateEtaMinutes } from '@/lib/pricing';
import type { SafetyLinkView } from '@/lib/supabase/types';

// What a worried person sees.
//
// TWO THINGS IT WILL NOT DO
//  * Invent an ETA. If the driver's position is unknown or stale, the page
//    says so instead of drawing a confident number over a guess. Somebody
//    deciding whether to keep waiting deserves to know which it is.
//  * Explain why a link failed. Wrong, revoked and expired all produce the
//    same page, because the difference is only useful to somebody guessing.

// How old a driver position may be before it stops being "now". Mirrors the
// dispatch engine's own heartbeat window (2 minutes), so this page and the
// command centre call the same driver stale at the same moment.
const FRESH_LOCATION_SECONDS = 120;

const STATE_LABEL: Record<string, { fr: string; en: string; tone: 'blue' | 'green' | 'yellow' | 'orange' | 'red' }> = {
  pending: { fr: 'Recherche d’un remorqueur', en: 'Looking for a tow operator', tone: 'orange' },
  searching: { fr: 'Un remorqueur est sollicité', en: 'A tow operator is being asked', tone: 'yellow' },
  matched: { fr: 'Remorqueur assigné', en: 'Tow operator assigned', tone: 'blue' },
  en_route: { fr: 'En route', en: 'On the way', tone: 'blue' },
  arrived: { fr: 'Sur place', en: 'Arrived', tone: 'green' },
  in_progress: { fr: 'Intervention en cours', en: 'Working on the vehicle', tone: 'green' },
  completed: { fr: 'Intervention terminée', en: 'Finished', tone: 'green' },
  cancelled: { fr: 'Annulée', en: 'Cancelled', tone: 'red' },
  expired: { fr: 'Expirée', en: 'Expired', tone: 'red' },
  restricted_capacity_wait: {
    fr: 'Zone réglementée — en attente d’un fournisseur autorisé',
    en: 'Regulated zone — waiting for an authorized provider',
    tone: 'red',
  },
  awaiting_external_authority: {
    fr: 'Zone réglementée — l’autorité publique prend en charge',
    en: 'Regulated zone — handled by the public authority',
    tone: 'red',
  },
};

export function SafetyLinkTracker({ view }: { view: SafetyLinkView | null }) {
  const { lang } = useLanguage();
  const [now, setNow] = useState(() => Date.now());

  // The age of the driver's position has to keep counting up on screen,
  // otherwise "2 minutes ago" stays true-looking for an hour.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(id);
  }, []);

  const markers = useMemo<MapMarker[]>(() => {
    if (!view) return [];
    const list: MapMarker[] = [
      { id: 'pickup', lat: view.pickup_lat, lng: view.pickup_lng, color: '#f97316', label: lang === 'fr' ? 'Véhicule' : 'Vehicle' },
    ];
    if (view.driver_lat != null && view.driver_lng != null) {
      list.push({
        id: 'driver',
        lat: view.driver_lat,
        lng: view.driver_lng,
        color: '#3b82f6',
        label: lang === 'fr' ? 'Remorqueur' : 'Tow operator',
      });
    }
    if (view.destination_lat != null && view.destination_lng != null) {
      list.push({
        id: 'destination',
        lat: view.destination_lat,
        lng: view.destination_lng,
        color: '#22c55e',
        label: lang === 'fr' ? 'Destination' : 'Destination',
      });
    }
    return list;
  }, [view, lang]);

  if (!view) {
    return (
      <div className="max-w-md mx-auto px-6 py-16">
        <Card className="text-center">
          <div className="text-3xl mb-3">🔗</div>
          <h1 className="font-display text-xl font-bold mb-2">
            {lang === 'fr' ? 'Ce lien n’est plus actif' : 'This link is no longer active'}
          </h1>
          <p className="text-sm text-text-2">
            {lang === 'fr'
              ? 'Il a peut-être expiré, ou la personne qui vous l’a envoyé l’a désactivé. Demandez-lui un nouveau lien.'
              : 'It may have expired, or the person who sent it turned it off. Ask them for a new one.'}
          </p>
        </Card>
      </div>
    );
  }

  const state = STATE_LABEL[view.operational_state] ?? {
    fr: view.operational_state,
    en: view.operational_state,
    tone: 'blue' as const,
  };

  // ETA is computed only when there is a real, fresh position to compute it
  // from. Everything else is a named absence rather than a number.
  const locationAge =
    view.driver_location_age_seconds == null ? null : view.driver_location_age_seconds;
  const locationIsFresh = locationAge != null && locationAge <= FRESH_LOCATION_SECONDS;
  const hasDriverPosition = view.driver_lat != null && view.driver_lng != null;
  const enRoute = ['matched', 'en_route'].includes(view.operational_state);

  const etaMinutes =
    enRoute && hasDriverPosition && locationIsFresh
      ? estimateEtaMinutes(
          distanceKm(
            { lat: view.driver_lat!, lng: view.driver_lng! },
            { lat: view.pickup_lat, lng: view.pickup_lng }
          )
        )
      : null;

  const etaLine = (() => {
    if (view.operational_state === 'arrived') {
      return lang === 'fr' ? 'Le remorqueur est sur place.' : 'The tow operator is there.';
    }
    if (['in_progress', 'completed', 'cancelled', 'expired'].includes(view.operational_state)) return null;
    if (view.regulated_state === 'awaiting_external_authority') {
      return lang === 'fr'
        ? 'Cette route est gérée par une autorité publique : elle organise le remorquage.'
        : 'This road is handled by a public authority, which arranges the tow.';
    }
    if (!enRoute) {
      return lang === 'fr'
        ? 'Aucun remorqueur n’est encore assigné, donc aucun délai ne peut être estimé.'
        : 'No tow operator is assigned yet, so there is no arrival time to estimate.';
    }
    if (!hasDriverPosition) {
      return lang === 'fr'
        ? 'Le remorqueur est assigné, mais sa position n’est pas disponible — aucun délai ne peut être estimé.'
        : 'The tow operator is assigned, but their position is unavailable, so no arrival time can be estimated.';
    }
    if (!locationIsFresh) {
      return lang === 'fr'
        ? `Dernière position reçue il y a ${describeAge(locationAge!, now, lang)} — le délai affiché ne serait pas fiable.`
        : `Last position received ${describeAge(locationAge!, now, lang)} ago — an arrival time would not be reliable.`;
    }
    return null;
  })();

  return (
    <div className="max-w-md mx-auto px-4 sm:px-6 py-8">
      <header className="mb-4 text-center">
        <p className="text-xs uppercase tracking-wide text-muted">TowConnect</p>
        <h1 className="font-display text-xl font-bold mt-1">
          {lang === 'fr' ? 'Suivi partagé' : 'Shared tracking'}
        </h1>
      </header>

      <Card className="mb-4">
        <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
          <Badge tone={state.tone}>{lang === 'fr' ? state.fr : state.en}</Badge>
          <span className="text-xs text-muted">{problemLabel(view.problem_type, lang)}</span>
        </div>

        {etaMinutes != null ? (
          <div className="text-center py-2">
            <div className="font-display text-3xl font-bold text-orange">~{etaMinutes} min</div>
            <div className="text-xs text-muted mt-1">
              {lang === 'fr' ? 'arrivée estimée' : 'estimated arrival'}
            </div>
          </div>
        ) : null}

        {etaLine ? <p className="text-sm text-text-2 text-center py-2">{etaLine}</p> : null}
      </Card>

      <Card className="mb-4 !p-0 overflow-hidden">
        <MapView
          center={{ lat: view.pickup_lat, lng: view.pickup_lng }}
          markers={markers}
          className="h-[280px]"
        />
      </Card>

      {view.driver_first_name ? (
        <Card className="mb-4">
          <h2 className="font-display text-sm font-bold mb-3">
            {lang === 'fr' ? 'Qui intervient' : 'Who is coming'}
          </h2>
          <dl className="flex flex-col gap-2 text-sm">
            <Row label={lang === 'fr' ? 'Remorqueur' : 'Operator'} value={view.driver_first_name} />
            {view.company_name ? (
              <Row label={lang === 'fr' ? 'Entreprise' : 'Company'} value={view.company_name} />
            ) : null}
            {view.vehicle_type ? (
              <Row label={lang === 'fr' ? 'Type de camion' : 'Truck type'} value={view.vehicle_type} />
            ) : null}
            {view.license_plate ? (
              <Row label={lang === 'fr' ? 'Plaque' : 'Plate'} value={view.license_plate} />
            ) : null}
            {locationAge != null ? (
              <Row
                label={lang === 'fr' ? 'Position reçue' : 'Position received'}
                value={
                  locationIsFresh
                    ? lang === 'fr'
                      ? 'à l’instant'
                      : 'just now'
                    : `${describeAge(locationAge, now, lang)} ${lang === 'fr' ? '' : 'ago'}`.trim()
                }
              />
            ) : null}
          </dl>
        </Card>
      ) : null}

      <p className="text-xs text-muted text-center">
        {lang === 'fr'
          ? 'Ce lien a été partagé volontairement et cesse de fonctionner automatiquement. Il ne montre ni prix, ni coordonnées personnelles, ni historique.'
          : 'This link was shared deliberately and stops working on its own. It shows no prices, no personal contact details and no history.'}
      </p>
    </div>
  );
}

function describeAge(seconds: number, now: number, lang: string): string {
  // `now` is threaded in so the component re-renders as time passes rather
  // than freezing at the value the server computed.
  void now;
  if (seconds < 90) return lang === 'fr' ? `${seconds} secondes` : `${seconds} seconds`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return lang === 'fr' ? `${minutes} minutes` : `${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  return lang === 'fr' ? `${hours} h` : `${hours}h`;
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-muted shrink-0">{label}</dt>
      <dd className="text-right">{value}</dd>
    </div>
  );
}
