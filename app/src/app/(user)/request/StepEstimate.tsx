'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/client';
import { useLanguage } from '@/lib/i18n/LanguageProvider';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { MapView } from '@/components/LazyMapView';
import { distanceKm, estimateEtaMinutes, estimatePriceBreakdown } from '@/lib/pricing';
import { STRIPE_CONFIGURED } from '@/lib/stripe/client';
import { hasDefaultPaymentMethod } from '@/lib/actions/payments';
import { RegulatedZoneNotice, useRegulatedZone } from '@/components/RegulatedZoneNotice';
import { checkPilotGate } from '@/lib/actions/pilot';
import { track } from '@/lib/analytics';
import { ERROR_MESSAGE_KEYS } from '@/lib/errors';
import type { PilotGateAnswer } from '@/lib/supabase/types';
import type { RequestFormData } from './types';

// Same escalating tiers Smart Dispatch itself uses server-side
// (dispatch_next_candidate() in 0006_smart_dispatch.sql) — kept identical on
// purpose so the price/ETA shown here is a genuine preview of what dispatch
// is about to do, not a separate guess. This screen only ever looks at the
// single nearest match to price the request; it never lists drivers to pick
// from — Smart Dispatch does the actual picking after confirmation.
const SEARCH_TIERS: { radiusKm: number; labelKey: 'tier_local' | 'tier_wide' | 'tier_provincial' }[] = [
  { radiusKm: 15, labelKey: 'tier_local' },
  { radiusKm: 40, labelKey: 'tier_wide' },
  { radiusKm: 350, labelKey: 'tier_provincial' },
];

export function StepEstimate({
  form,
  onBack,
  onConfirm,
}: {
  form: RequestFormData;
  onBack: () => void;
  onConfirm: () => Promise<void>;
}) {
  const { t, lang } = useLanguage();
  const [loading, setLoading] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [estimate, setEstimate] = useState<{ price: number; etaMinutes: number; tier: string } | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [checkingPaymentMethod, setCheckingPaymentMethod] = useState(STRIPE_CONFIGURED);
  const [hasPaymentMethod, setHasPaymentMethod] = useState(!STRIPE_CONFIGURED);
  const [gate, setGate] = useState<PilotGateAnswer | null>(null);

  // The regulatory check happens BEFORE the customer commits, not after.
  // Confirming a request we are not allowed to serve would authorize a card
  // for a job no TowConnect truck can legally take, and then explain the
  // problem afterwards. The database is asked first.
  const { zone, checked: zoneChecked } = useRegulatedZone(form.lat, form.lng);

  // And the pilot gate, asked here for exactly the reason the regulatory
  // check is asked here: refusing after a card has been authorized is a worse
  // experience than refusing before, and a worse one to explain. The database
  // trigger still refuses on its own (0047) — this is so the person gets a
  // sentence instead of a failure.
  useEffect(() => {
    let cancelled = false;
    checkPilotGate(form.lat, form.lng).then((answer) => {
      if (!cancelled) setGate(answer);
    });
    return () => {
      cancelled = true;
    };
  }, [form.lat, form.lng]);

  const gateRefusalKey =
    gate && !gate.allowed
      ? gate.reason === 'paused'
        ? ERROR_MESSAGE_KEYS.pilot_paused
        : gate.reason === 'outside_territory'
          ? ERROR_MESSAGE_KEYS.pilot_outside_territory
          : gate.reason === 'outside_hours'
            ? ERROR_MESSAGE_KEYS.pilot_outside_hours
            : ERROR_MESSAGE_KEYS.pilot_not_on_allowlist
      : null;
  const zoneBlocksDispatch =
    zone !== null &&
    (zone.dispatch_mode === 'external_authority_required' ||
      zone.dispatch_mode === 'manual_instruction_only');

  async function search(cancelledRef?: { current: boolean }) {
    setLoading(true);
    setNotFound(false);
    setEstimate(null);
    const supabase = createClient();

    for (const tier of SEARCH_TIERS) {
      const { data, error } = await supabase.rpc('nearby_drivers', {
        p_lat: form.lat,
        p_lng: form.lng,
        p_radius_km: tier.radiusKm,
        p_limit: 1,
      });
      if (cancelledRef?.current) return;
      if (error) {
        setLoading(false);
        setNotFound(true);
        return;
      }
      const nearest = data?.[0];
      if (nearest) {
        const towDistanceKm =
          form.destinationLat != null && form.destinationLng != null
            ? distanceKm({ lat: form.lat, lng: form.lng }, { lat: form.destinationLat, lng: form.destinationLng })
            : undefined;
        const breakdown = estimatePriceBreakdown({
          driverDistanceKm: nearest.distance_km,
          towDistanceKm,
          problemType: form.problemType,
        });
        setEstimate({
          price: breakdown.total,
          etaMinutes: estimateEtaMinutes(nearest.distance_km),
          tier: tier.labelKey,
        });
        setLoading(false);
        // The step counts when the number is on screen, not when the search
        // started: a search that found nobody is not an estimate shown.
        track('estimate_shown', { problem_type: form.problemType, source: tier.labelKey });
        return;
      }
    }

    setNotFound(true);
    setLoading(false);
  }

  useEffect(() => {
    const cancelledRef = { current: false };
    // eslint-disable-next-line react-hooks/set-state-in-effect
    search(cancelledRef);
    return () => {
      cancelledRef.current = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form]);

  // A saved payment method is checked up front, before the client can even
  // try to confirm — the authoritative check happens again server-side at
  // authorization time regardless, this is purely to avoid a round trip to
  // a guaranteed failure.
  useEffect(() => {
    if (!STRIPE_CONFIGURED) return;
    let cancelled = false;
    hasDefaultPaymentMethod().then((has) => {
      if (!cancelled) {
        setHasPaymentMethod(has);
        setCheckingPaymentMethod(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleConfirm() {
    if (!estimate || !hasPaymentMethod) return;
    track('checkout_started', { problem_type: form.problemType });
    setConfirming(true);
    try {
      await onConfirm();
    } finally {
      setConfirming(false);
    }
  }

  return (
    <Card>
      <h3 className="font-display text-xl font-bold mb-1">{t('title_estimate')}</h3>
      <p className="text-sm text-text-2 mb-4">{t('sub_estimate')}</p>

      <MapView
        center={form}
        zoom={11}
        className="h-56 mb-5"
        markers={[{ id: 'me', lat: form.lat, lng: form.lng, color: '#ff5c1a' }]}
      />

      {loading ? (
        <div className="py-10 text-center">
          <div className="text-3xl mb-3 animate-pulse">🔍</div>
          <p className="text-sm text-muted">{t('searching_estimate')}</p>
        </div>
      ) : notFound ? (
        <div className="text-center py-8">
          <div className="text-3xl mb-3">😕</div>
          <p className="text-sm text-muted mb-1">{t('no_drivers')}</p>
          <p className="text-xs text-muted mb-5">
            {lang === 'fr'
              ? `Recherche élargie jusqu'à ${SEARCH_TIERS[SEARCH_TIERS.length - 1].radiusKm} km sans résultat.`
              : `Widened search up to ${SEARCH_TIERS[SEARCH_TIERS.length - 1].radiusKm} km found nothing.`}
          </p>
          <Button variant="secondary" onClick={() => search()}>
            🔄 {lang === 'fr' ? 'Réessayer' : 'Retry'}
          </Button>
        </div>
      ) : estimate ? (
        <div className="text-center py-4 mb-2">
          <p className="text-sm text-text-2 mb-4">{t('estimate_ready')}</p>
          <div className="flex justify-center gap-8 mb-2">
            <div>
              <div className="font-display text-3xl font-bold text-orange">${estimate.price.toFixed(0)}</div>
              <div className="text-xs text-muted">{t('price_est')}</div>
            </div>
            <div>
              <div className="font-display text-3xl font-bold text-orange">{estimate.etaMinutes}</div>
              <div className="text-xs text-muted">{t('eta_min')}</div>
            </div>
          </div>
          <p className="text-xs text-muted mt-3">{t('estimate_note')}</p>
        </div>
      ) : null}

      {zone ? (
        <div className="mb-4">
          <RegulatedZoneNotice zone={zone} />
        </div>
      ) : null}

      {/* The pilot refusal, stated plainly. It sits below the regulatory
          notice because a legal instruction outranks a commercial one: if
          both apply, the motorist needs the law first. */}
      {gateRefusalKey ? (
        <div
          role="status"
          className="bg-night-3 border border-orange rounded-xl p-4 mb-4"
        >
          <p className="text-sm text-text-2">{t(gateRefusalKey)}</p>
          {gate?.detail ? <p className="text-xs text-muted mt-2">{gate.detail}</p> : null}
        </div>
      ) : null}

      {estimate && !zoneBlocksDispatch && !checkingPaymentMethod && !hasPaymentMethod ? (
        <div className="bg-night-3 border border-orange rounded-xl p-4 mb-4 text-center">
          <p className="text-sm text-text-2 mb-3">{t('payment_method_required')}</p>
          <Link href="/payment-methods">
            <Button type="button" variant="secondary" full>
              💳 {t('payment_method_add')}
            </Button>
          </Link>
        </div>
      ) : null}

      <div className="flex gap-2 mt-5">
        <Button variant="secondary" onClick={onBack} className="flex-1">
          ← {t('btn_back')}
        </Button>
        {/* No confirm button at all inside a zone whose rule bars us from
            dispatching — the official instruction above is the action. A
            disabled button would still suggest this is something TowConnect
            could do for you if you tried again. */}
        {!zoneBlocksDispatch && !gateRefusalKey ? (
          <Button
            className="flex-[2]"
            disabled={
              !estimate ||
              confirming ||
              !zoneChecked ||
              gate === null ||
              checkingPaymentMethod ||
              !hasPaymentMethod
            }
            onClick={handleConfirm}
          >
            {confirming ? '…' : `🚨 ${t('btn_confirm_dispatch')}`}
          </Button>
        ) : null}
      </div>
    </Card>
  );
}
