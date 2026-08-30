'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useLanguage } from '@/lib/i18n/LanguageProvider';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { MapView } from '@/components/MapView';
import { DriverCard, type NearbyDriver } from '@/components/DriverCard';
import { distanceKm, estimateEtaMinutes, estimatePrice } from '@/lib/pricing';
import { VEHICLE_TYPE_LABEL } from '@/lib/constants';
import type { RequestFormData } from './types';

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
  const { t } = useLanguage();
  const [drivers, setDrivers] = useState<NearbyDriver[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      const supabase = createClient();
      const { data } = await supabase
        .from('driver_profiles')
        .select('profile_id, vehicle_type, rating, total_services, current_lat, current_lng, profiles(full_name)')
        .eq('approval_status', 'approved')
        .eq('is_online', true)
        .not('current_lat', 'is', null)
        .not('current_lng', 'is', null);

      if (cancelled) return;

      const nearby: NearbyDriver[] = (data ?? [])
        .filter((d) => d.profile_id !== excludeDriverId)
        .map((d) => {
          const dist = distanceKm(form, { lat: d.current_lat!, lng: d.current_lng! });
          const profile = Array.isArray(d.profiles) ? d.profiles[0] : d.profiles;
          return {
            profileId: d.profile_id,
            name: profile?.full_name || 'Remorqueur',
            rating: d.rating,
            totalServices: d.total_services,
            vehicleType: VEHICLE_TYPE_LABEL[d.vehicle_type] ?? d.vehicle_type,
            lat: d.current_lat!,
            lng: d.current_lng!,
            distanceKm: dist,
            etaMinutes: estimateEtaMinutes(dist),
            price: estimatePrice(dist, form.problemType),
          };
        })
        .sort((a, b) => a.distanceKm - b.distanceKm)
        .slice(0, 8);

      setDrivers(nearby);
      setSelected(nearby[0]?.profileId ?? null);
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

      <MapView
        center={form}
        zoom={11}
        className="h-64 mb-4"
        markers={[
          { id: 'me', lat: form.lat, lng: form.lng, color: '#ff5c1a' },
          ...drivers.map((d) => ({ id: d.profileId, lat: d.lat, lng: d.lng, color: '#3b82f6' })),
        ]}
      />

      {loading ? (
        <p className="text-sm text-muted py-6 text-center">…</p>
      ) : drivers.length === 0 ? (
        <p className="text-sm text-muted py-6 text-center">{t('no_drivers')}</p>
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
