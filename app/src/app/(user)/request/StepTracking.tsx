'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/client';
import { useLanguage } from '@/lib/i18n/LanguageProvider';
import { cancelRequest } from '@/lib/actions/requests';
import { distanceKm, estimateEtaMinutes, toMoney } from '@/lib/pricing';
import { CLIENT_QUICK_MESSAGES } from '@/lib/constants';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { MapView } from '@/components/MapView';
import { StatusTracker } from '@/components/StatusTracker';
import { Chat } from '@/components/Chat';
import type { RequestStatus } from '@/lib/supabase/types';

interface DriverInfo {
  name: string;
  phone: string | null;
  vehicleType: string;
  // null until at least one job is behind them. driver_profiles.rating
  // defaults to 5.0 for every new account (0001_init.sql), so rendering it
  // unconditionally showed a perfect score nobody had given - to a customer
  // deciding whether to hand a stranger their car. Never show a rating that
  // has not been earned.
  rating: number | null;
  totalServices: number;
  plate: string | null;
  lat: number | null;
  lng: number | null;
}

// This is the single screen for the entire life of a request after
// confirmation — searching, waiting on a driver's answer, matched, en route,
// arrived, in progress. It is driven purely by the `requests` row (status +
// driver_id) via Realtime, which is exactly what makes it safe to land on
// directly from a resumed session: there is no separate client-side
// "dispatch state" to reconstruct, only what the DB already says right now.
export function StepTracking({
  requestId,
  userId,
  userLocation,
  createdAt,
  onCancelled,
}: {
  requestId: string;
  userId: string;
  userLocation: { lat: number; lng: number };
  createdAt: string;
  onCancelled: () => void;
}) {
  const { t, lang } = useLanguage();
  const [status, setStatus] = useState<RequestStatus>('pending');
  const [price, setPrice] = useState(0);
  const [driverId, setDriverId] = useState<string | null>(null);
  const [driver, setDriver] = useState<DriverInfo | null>(null);
  const [takingLonger, setTakingLonger] = useState(false);

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

  // Closes the real latency gap on a silent timeout (driver never answers):
  // the rider's own tab is already open and watching this request, so it
  // nudges the backend every few seconds to check whether the current offer
  // (if any) has expired and, if so, advance to the next candidate right
  // away — instead of waiting on the dispatch-tick cron's cadence. A nudge
  // that finds nothing overdue is a cheap no-op; this is a latency
  // optimization, not the source of truth — respond_to_dispatch_offer()
  // already refuses an expired offer inline regardless, and dispatch-tick
  // remains the backstop if this tab (and the driver's) are both closed.
  useEffect(() => {
    if (status !== 'pending') return;
    const supabase = createClient();
    const interval = setInterval(() => {
      supabase.rpc('nudge_dispatch', { p_request_id: requestId });
    }, 5000);
    return () => clearInterval(interval);
  }, [requestId, status]);

  // "Searching is taking longer than usual" hint — purely a UI nicety layered
  // on real elapsed time, not a new backend state. Only relevant while still
  // searching (pending, no driver offered yet).
  useEffect(() => {
    if (status !== 'pending' || driverId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setTakingLonger(false);
      return;
    }
    function check() {
      setTakingLonger(Date.now() - new Date(createdAt).getTime() > 45_000);
    }
    check();
    const interval = setInterval(check, 5000);
    return () => clearInterval(interval);
  }, [status, driverId, createdAt]);

  useEffect(() => {
    // Full driver identity (name/phone/rating/plate) is only loaded — and
    // only readable under RLS in the first place — once the request is
    // actually matched or further along. While an offer is merely
    // outstanding (status still 'pending' even though driver_id is set), the
    // driver hasn't accepted yet, so nothing personal is shown:
    // driver_profiles' "rider with active job sees assigned driver" policy
    // only grants that once status is matched/en_route/arrived/in_progress —
    // this check just avoids the pointless round trip.
    if (!driverId || !['matched', 'en_route', 'arrived', 'in_progress'].includes(status)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setDriver(null);
      return;
    }

    const supabase = createClient();
    const currentDriverId = driverId;

    async function loadDriver() {
      const { data } = await supabase
        .from('driver_profiles')
        .select('vehicle_type, rating, total_services, license_plate, current_lat, current_lng, profiles(full_name, phone)')
        .eq('profile_id', currentDriverId)
        .single();
      if (data) {
        const profile = Array.isArray(data.profiles) ? data.profiles[0] : data.profiles;
        setDriver({
          name: profile?.full_name || 'Remorqueur',
          phone: profile?.phone ?? null,
          vehicleType: data.vehicle_type,
          rating: data.total_services > 0 ? data.rating : null,
          totalServices: data.total_services,
          plate: data.license_plate,
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
  }, [driverId, status]);

  const labels: Record<RequestStatus, string> = {
    pending: t('track_pending'),
    matched: t('track_matched'),
    en_route: t('track_en_route'),
    arrived: t('track_arrived'),
    in_progress: t('track_in_progress'),
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
          {lang === 'fr' ? 'Nouvelle demande' : 'New request'}
        </Button>
      </Card>
    );
  }

  // Smart Dispatch in progress: no driver has accepted yet. This is the only
  // screen state that replaces the old "pick a driver from a list" step —
  // the client only ever sees these two plain-language states, never
  // dispatch internals (offer ids, candidate rank, timeouts).
  if (status === 'pending') {
    return (
      <Card className="text-center py-10">
        {driverId ? (
          <>
            <div className="text-4xl mb-3 animate-pulse">📡</div>
            <p className="font-display text-lg font-bold mb-1">{t('dispatch_contacting')}</p>
            <p className="text-sm text-muted">{t('dispatch_contacting_sub')}</p>
          </>
        ) : (
          <>
            <div className="text-4xl mb-3 animate-pulse">🔍</div>
            <p className="font-display text-lg font-bold mb-1">{t('dispatch_searching')}</p>
            <p className="text-sm text-muted">{t('dispatch_searching_sub')}</p>
            {takingLonger ? <p className="text-xs text-muted mt-3">{t('dispatch_taking_longer')}</p> : null}
          </>
        )}
        <Button variant="secondary" full className="mt-7" onClick={handleCancel}>
          ❌ {t('btn_cancel')}
        </Button>
      </Card>
    );
  }

  const firstName = driver?.name.split(' ')[0] || (lang === 'fr' ? 'Votre remorqueur' : 'Your driver');
  const etaMinutes =
    status === 'en_route' && driver?.lat != null && driver?.lng != null
      ? estimateEtaMinutes(distanceKm({ lat: driver.lat, lng: driver.lng }, userLocation))
      : null;

  const headline =
    status === 'en_route' && etaMinutes != null
      ? `${firstName} ${t('eta_arriving')} ~${etaMinutes} ${t('eta_min_short')}`
      : status === 'matched'
        ? lang === 'fr'
          ? `${firstName} a confirmé votre demande`
          : `${firstName} confirmed your request`
        : status === 'arrived'
          ? lang === 'fr'
            ? `${firstName} est arrivé sur les lieux`
            : `${firstName} has arrived`
          : status === 'in_progress'
            ? t('track_in_progress')
            : status === 'completed'
              ? t('track_completed')
              : labels[status];

  return (
    <Card>
      <div className="text-center pb-5">
        <div className="text-4xl mb-2">
          {status === 'en_route' ? '🚛' : status === 'arrived' ? '📍' : status === 'in_progress' ? '🔧' : '✅'}
        </div>
        <h3 className="font-display text-xl font-bold leading-snug">{headline}</h3>
      </div>

      <MapView
        center={userLocation}
        zoom={12}
        className="h-52 mb-5"
        markers={[
          { id: 'me', lat: userLocation.lat, lng: userLocation.lng, color: '#ff5c1a' },
          ...(driver?.lat && driver?.lng
            ? [{ id: 'driver', lat: driver.lat, lng: driver.lng, color: '#3b82f6' }]
            : []),
        ]}
      />

      {driver ? (
        <div className="bg-night-3 border border-steel rounded-xl p-4 flex items-center gap-3 mb-4">
          <div className="w-12 h-12 rounded-full bg-orange flex items-center justify-center font-display font-bold text-white text-lg shrink-0">
            {driver.name.slice(0, 2).toUpperCase()}
          </div>
          <div className="flex-1 min-w-0">
            <div className="font-semibold text-sm truncate">{driver.name}</div>
            <div className="text-xs text-muted">
              {driver.rating != null ? `⭐ ${driver.rating.toFixed(1)}` : t('driver_new')} · 🚛 {driver.vehicleType}
              {driver.plate ? ` · ${t('driver_plate')} ${driver.plate}` : ''}
            </div>
          </div>
          {driver.phone ? (
            <a
              href={`tel:${driver.phone}`}
              className="px-4 py-2.5 rounded-lg bg-night-4 border border-steel text-sm shrink-0"
            >
              📞 {t('btn_call')}
            </a>
          ) : null}
        </div>
      ) : null}

      {driver ? (
        <div className="mb-4">
          <Chat requestId={requestId} currentUserId={userId} quickMessages={CLIENT_QUICK_MESSAGES} />
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-3 mb-5">
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

      {status === 'completed' ? (
        <Link href={`/history/${requestId}`}>
          <Button full>🧾 {t('receipt_title')}</Button>
        </Link>
      ) : (
        <Button variant="secondary" full onClick={handleCancel}>
          ❌ {t('btn_cancel')}
        </Button>
      )}
    </Card>
  );
}
