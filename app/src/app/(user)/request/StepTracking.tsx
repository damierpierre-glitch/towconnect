'use client';

import { useEffect, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useLanguage } from '@/lib/i18n/LanguageProvider';
import { cancelRequest } from '@/lib/actions/requests';
import { toMoney } from '@/lib/pricing';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { MapView } from '@/components/MapView';
import { StatusTracker } from '@/components/StatusTracker';
import type { RequestStatus } from '@/lib/supabase/types';

interface DriverInfo {
  name: string;
  phone: string | null;
  vehicleType: string;
  lat: number | null;
  lng: number | null;
}

export function StepTracking({
  requestId,
  userLocation,
  onDriverDeclined,
  onCancelled,
}: {
  requestId: string;
  userLocation: { lat: number; lng: number };
  onDriverDeclined: (previousDriverId?: string) => void;
  onCancelled: () => void;
}) {
  const { t, lang } = useLanguage();
  const [status, setStatus] = useState<RequestStatus>('pending');
  const [price, setPrice] = useState(0);
  const [driverId, setDriverId] = useState<string | null>(null);
  const [driver, setDriver] = useState<DriverInfo | null>(null);
  const [initialized, setInitialized] = useState(false);
  const lastDriverIdRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    const supabase = createClient();

    async function loadInitial() {
      const { data } = await supabase
        .from('requests')
        .select('status, price_estimate, driver_id')
        .eq('id', requestId)
        .single();
      if (data) {
        setStatus(data.status);
        setPrice(toMoney(data.price_estimate));
        setDriverId(data.driver_id);
      }
      setInitialized(true);
    }
    loadInitial();

    const channel = supabase
      .channel(`request-${requestId}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'requests', filter: `id=eq.${requestId}` },
        (payload) => {
          const row = payload.new as { status: RequestStatus; price_estimate: number | string; driver_id: string | null };
          setStatus(row.status);
          setPrice(toMoney(row.price_estimate));
          setDriverId(row.driver_id);
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [requestId]);

  useEffect(() => {
    if (driverId) {
      lastDriverIdRef.current = driverId;
    } else {
      // No setState here: onDriverDeclined makes the parent switch away from
      // this step entirely, unmounting it — nothing needs to be cleared.
      if (initialized && status === 'pending') onDriverDeclined(lastDriverIdRef.current);
      return;
    }

    const supabase = createClient();
    const currentDriverId = driverId;

    async function loadDriver() {
      const { data } = await supabase
        .from('driver_profiles')
        .select('vehicle_type, current_lat, current_lng, profiles(full_name, phone)')
        .eq('profile_id', currentDriverId)
        .single();
      if (data) {
        const profile = Array.isArray(data.profiles) ? data.profiles[0] : data.profiles;
        setDriver({
          name: profile?.full_name || 'Remorqueur',
          phone: profile?.phone ?? null,
          vehicleType: data.vehicle_type,
          lat: data.current_lat,
          lng: data.current_lng,
        });
      }
    }
    loadDriver();

    const channel = supabase
      .channel(`driver-${driverId}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'driver_profiles',
          filter: `profile_id=eq.${driverId}`,
        },
        (payload) => {
          const row = payload.new as { current_lat: number | null; current_lng: number | null };
          setDriver((prev) => (prev ? { ...prev, lat: row.current_lat, lng: row.current_lng } : prev));
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [driverId, status, initialized]);

  const labels: Record<RequestStatus, string> = {
    pending: t('track_pending'),
    matched: t('track_matched'),
    en_route: t('track_en_route'),
    arrived: t('track_arrived'),
    completed: t('track_completed'),
    cancelled: t('track_cancelled'),
    expired: t('track_expired'),
  };

  async function handleCancel() {
    await cancelRequest(requestId);
    onCancelled();
  }

  if (status === 'cancelled' || status === 'expired') {
    return (
      <Card className="text-center py-10">
        <div className="text-4xl mb-3">{status === 'expired' ? '⌛' : '❌'}</div>
        <p className="text-text-2">{status === 'expired' ? t('track_expired') : t('track_cancelled')}</p>
        <Button className="mt-6" onClick={onCancelled}>
          {lang === 'fr' ? "Nouvelle demande" : 'New request'}
        </Button>
      </Card>
    );
  }

  return (
    <Card>
      <div className="text-center pb-6">
        <div className="text-5xl mb-3">🚛</div>
        <h3 className="font-display text-xl font-bold mb-1">{t('title_onway')}</h3>
        {driver ? <p className="text-sm text-text-2">{driver.name}</p> : null}
      </div>

      <MapView
        center={userLocation}
        zoom={12}
        className="h-56 mb-5"
        markers={[
          { id: 'me', lat: userLocation.lat, lng: userLocation.lng, color: '#ff5c1a' },
          ...(driver?.lat && driver?.lng
            ? [{ id: 'driver', lat: driver.lat, lng: driver.lng, color: '#3b82f6' }]
            : []),
        ]}
      />

      <div className="grid grid-cols-2 gap-3 mb-6">
        <div className="text-center">
          <div className="font-display text-xl font-bold text-orange">${price.toFixed(0)}</div>
          <div className="text-xs text-muted">{t('price_est')}</div>
        </div>
        <div className="text-center">
          <div className="font-display text-xl font-bold text-orange">{driver?.vehicleType ?? '—'}</div>
          <div className="text-xs text-muted">{lang === 'fr' ? 'véhicule' : 'vehicle'}</div>
        </div>
      </div>

      <div className="mb-5">
        <StatusTracker current={status} labels={labels} />
      </div>

      {driver ? (
        <div className="bg-night-3 border border-steel rounded-xl p-4 flex items-center gap-3 mb-5">
          <div className="w-11 h-11 rounded-full bg-orange flex items-center justify-center font-display font-bold text-white">
            {driver.name.slice(0, 2).toUpperCase()}
          </div>
          <div className="flex-1">
            <div className="font-semibold text-sm">{driver.name}</div>
            <div className="text-xs text-muted">🚛 {driver.vehicleType}</div>
          </div>
          {driver.phone ? (
            <a
              href={`tel:${driver.phone}`}
              className="px-4 py-2.5 rounded-lg bg-night-4 border border-steel text-sm"
            >
              📞 {t('btn_call')}
            </a>
          ) : null}
        </div>
      ) : null}

      {status !== 'completed' ? (
        <Button variant="secondary" full onClick={handleCancel}>
          ❌ {t('btn_cancel')}
        </Button>
      ) : null}
    </Card>
  );
}
