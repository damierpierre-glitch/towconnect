'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useLanguage } from '@/lib/i18n/LanguageProvider';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { MapView } from '@/components/MapView';
import { DriverCard, type NearbyDriver } from '@/components/DriverCard';
import { estimateEtaMinutes, estimatePrice } from '@/lib/pricing';
import { VEHICLE_TYPE_LABEL } from '@/lib/constants';
import type { RequestFormData } from './types';

// Escalating search radius (item 7 of the hardening review): remote/rural
// requests would otherwise hit an empty list at a fixed "city" radius. Each
// tier is tried in order until one returns a driver; the UI tells the rider
// which tier matched instead of silently searching wider.
// There's no real province-boundary data in the schema (driver_profiles.province
// is just a free-text code), so "provincial" here is approximated as a very
// large radius rather than an actual polygon match.
const SEARCH_TIERS: { radiusKm: number; labelKey: 'tier_local' | 'tier_wide' | 'tier_provincial' }[] = [
  { radiusKm: 15, labelKey: 'tier_local' },
  { radiusKm: 40, labelKey: 'tier_wide' },
  { radiusKm: 350, labelKey: 'tier_provincial' },
];

const TIER_LABEL: Record<string, { fr: string; en: string }> = {
  tier_local: { fr: 'À proximité', en: 'Nearby' },
  tier_wide: { fr: 'Recherche élargie (40 km)', en: 'Widened search (40 km)' },
  tier_provincial: { fr: 'Recherche provinciale', en: 'Province-wide search' },
};

export function StepDrivers({
  form,
  excludeDriverId,
  onBack,
  onConfirm,
}: {
  form: RequestFormData;
  excludeDriverId?: string;
  onBack: () => void;
  onConfirm: (driverId: string, price: number) => void;
}) {
  const { t, lang } = useLanguage();
  const [drivers, setDrivers] = useState<NearbyDriver[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [matchedTier, setMatchedTier] = useState<string | null>(null);
  const [searchedAllTiers, setSearchedAllTiers] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setMatchedTier(null);
      setSearchedAllTiers(false);
      const supabase = createClient();

      for (const tier of SEARCH_TIERS) {
        const { data, error } = await supabase.rpc('nearby_drivers', {
          p_lat: form.lat,
          p_lng: form.lng,
          p_radius_km: tier.radiusKm,
          p_limit: 8,
        });
        if (cancelled) return;
        if (error) {
          setLoading(false);
          return;
        }

        const filtered = (data ?? []).filter((d) => d.profile_id !== excludeDriverId);
        if (filtered.length > 0) {
          const nearby: NearbyDriver[] = filtered.map((d) => ({
            profileId: d.profile_id,
            name: d.full_name || 'Remorqueur',
            rating: d.rating,
            totalServices: d.total_services,
            vehicleType: VEHICLE_TYPE_LABEL[d.vehicle_type] ?? d.vehicle_type,
            distanceKm: d.distance_km,
            etaMinutes: estimateEtaMinutes(d.distance_km),
            price: estimatePrice(d.distance_km, form.problemType),
          }));
          setDrivers(nearby);
          setSelected(nearby[0]?.profileId ?? null);
          setMatchedTier(tier.labelKey);
          setLoading(false);
          return;
        }
      }

      // Exhausted every tier, including the province-wide one — explicit
      // fallback state rather than an unexplained empty screen.
      setDrivers([]);
      setSelected(null);
      setSearchedAllTiers(true);
      setLoading(false);
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [form, excludeDriverId]);

  const selectedDriver = drivers.find((d) => d.profileId === selected);

  return (
    <Card>
      <h3 className="font-display text-xl font-bold mb-1">{t('title_drivers')}</h3>
      <p className="text-sm text-text-2 mb-4">{t('sub_drivers')}</p>

      {/* Only the rider's own location is plotted here — driver positions are
          never sent to the browser before a request is matched (see
          nearby_drivers() and the driver_profiles RLS policy). */}
      <MapView
        center={form}
        zoom={11}
        className="h-64 mb-4"
        markers={[{ id: 'me', lat: form.lat, lng: form.lng, color: '#ff5c1a' }]}
      />

      {matchedTier && matchedTier !== 'tier_local' ? (
        <p className="text-xs text-orange mb-3 text-center">
          {lang === 'fr' ? TIER_LABEL[matchedTier].fr : TIER_LABEL[matchedTier].en}
        </p>
      ) : null}

      {loading ? (
        <p className="text-sm text-muted py-6 text-center">…</p>
      ) : searchedAllTiers ? (
        <div className="text-center py-6">
          <p className="text-sm text-muted mb-1">{t('no_drivers')}</p>
          <p className="text-xs text-muted">
            {lang === 'fr'
              ? `Recherche élargie jusqu'à ${SEARCH_TIERS[SEARCH_TIERS.length - 1].radiusKm} km sans résultat.`
              : `Widened search up to ${SEARCH_TIERS[SEARCH_TIERS.length - 1].radiusKm} km found nothing.`}
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-2.5">
          {drivers.map((d) => (
            <DriverCard
              key={d.profileId}
              driver={d}
              selected={d.profileId === selected}
              onSelect={() => setSelected(d.profileId)}
            />
          ))}
        </div>
      )}

      <div className="flex gap-2 mt-4">
        <Button variant="secondary" onClick={onBack} className="flex-1">
          ← {t('btn_back')}
        </Button>
        <Button
          className="flex-[2]"
          disabled={!selectedDriver}
          onClick={() => selectedDriver && onConfirm(selectedDriver.profileId, selectedDriver.price)}
        >
          ✅ {t('btn_confirm')} {selectedDriver ? `— ${selectedDriver.name}` : ''}
        </Button>
      </div>
    </Card>
  );
}
