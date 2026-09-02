'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/client';
import { useLanguage } from '@/lib/i18n/LanguageProvider';
import { useToast } from '@/components/ToastProvider';
import { Card, StatCard } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Chat } from '@/components/Chat';
import { ProposeSupplement } from '@/components/ProposeSupplement';
import { SupplementsPanel } from '@/components/SupplementsPanel';
import { MapView } from '@/components/MapView';
import { StatusTracker } from '@/components/StatusTracker';
import { acceptRequest, advanceRequestStatus, declineRequest, toggleOnline, updateDriverInfo, updateDriverLocation } from '@/lib/actions/driver';
import { problemLabel, CANADIAN_PROVINCES, DRIVER_QUICK_MESSAGES, PROBLEM_TYPES } from '@/lib/constants';
import { distanceKm, estimateEtaMinutes, toMoney } from '@/lib/pricing';
import { Select, Input, Label } from '@/components/ui/Field';
import type { DriverProfile, RequestStatus, TowRequest, VehicleType } from '@/lib/supabase/types';

// Mirrors driver_heartbeat_max_age() in 0017_availability_consistency.sql.
// The database is the single source of truth for this threshold — this is a
// display-only echo of it, so the dashboard never claims "online" for a
// driver the backend would already treat as stale. If that function's
// interval ever changes, this must change with it.
const HEARTBEAT_STALE_MS = 2 * 60 * 1000;

interface ClientInfo {
  name: string;
  phone: string | null;
}

export function DriverDashboard({
  driverId,
  fullName,
  initialDriverProfile,
}: {
  driverId: string;
  fullName: string;
  initialDriverProfile: DriverProfile;
}) {
  const { t, lang } = useLanguage();
  const { showToast } = useToast();
  const [driverProfile, setDriverProfile] = useState(initialDriverProfile);
  const [myRequests, setMyRequests] = useState<TowRequest[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [offerExpiresAt, setOfferExpiresAt] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const [client, setClient] = useState<ClientInfo | null>(null);
  const [gpsStatus, setGpsStatus] = useState<'idle' | 'ok' | 'denied' | 'unavailable'>('idle');
  const [pingFailed, setPingFailed] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const isApproved = driverProfile.approval_status === 'approved';
  const needsOnboarding = !driverProfile.province;

  // Load this driver's request history + active jobs, then stay in sync via
  // realtime. Two channels, not one: a `requests` row whose driver_id just
  // got cleared (offer declined/timed out) no longer matches this driver's
  // `driver_id=eq.${driverId}` filter on the NEW row, so that transition
  // alone would never reach this subscription — dispatch_offers.driver_id
  // never changes, so its own channel reliably catches "my offer just ended".
  useEffect(() => {
    const supabase = createClient();

    async function load() {
      const { data } = await supabase
        .from('requests')
        .select('*')
        .eq('driver_id', driverId)
        .order('created_at', { ascending: false })
        .limit(50);
      setMyRequests(data ?? []);
      setLoadingHistory(false);
    }
    load();

    const requestsChannel = supabase
      .channel(`driver-requests-${driverId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'requests', filter: `driver_id=eq.${driverId}` },
        () => load()
      )
      .subscribe();

    const offersChannel = supabase
      .channel(`driver-offers-${driverId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'dispatch_offers', filter: `driver_id=eq.${driverId}` },
        () => load()
      )
      .subscribe();

    return () => {
      supabase.removeChannel(requestsChannel);
      supabase.removeChannel(offersChannel);
    };
  }, [driverId]);

  // A ticking clock, independent of any data refresh — heartbeat staleness
  // changes purely with time passing, not with a row changing, so it needs
  // its own timer rather than being recomputed only when driverProfile does.
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(interval);
  }, []);

  // Broadcast live location every 20s while online, so users can see the
  // driver moving on the map. Also the driver's own heartbeat: last_
  // heartbeat_at is what cleanup-stale and nearby_drivers() both key
  // freshness off of, so a permission denial or a failed write here has to
  // surface in the UI, not fail silently — an "online" driver whose position
  // never lands is exactly the gap Phase 4.5 found and fixed server-side;
  // this is the client-side half of the same guarantee.
  useEffect(() => {
    if (!driverProfile.is_online) return;
    if (!navigator.geolocation) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setGpsStatus('unavailable');
      return;
    }

    function ping() {
      navigator.geolocation.getCurrentPosition(
        async (pos) => {
          setGpsStatus('ok');
          const result = await updateDriverLocation(pos.coords.latitude, pos.coords.longitude);
          setPingFailed(!result.ok);
          if (result.ok) {
            const stamp = new Date().toISOString();
            setDriverProfile((p) => ({
              ...p,
              last_heartbeat_at: stamp,
              current_lat: pos.coords.latitude,
              current_lng: pos.coords.longitude,
            }));
          }
        },
        (err) => {
          setGpsStatus(err.code === err.PERMISSION_DENIED ? 'denied' : 'unavailable');
        },
        { enableHighAccuracy: false, timeout: 8000, maximumAge: 15000 }
      );
    }
    ping();
    const interval = setInterval(ping, 20000);
    return () => clearInterval(interval);
  }, [driverProfile.is_online]);

  async function handleToggleOnline() {
    const next = !driverProfile.is_online;
    if (next && gpsStatus === 'denied') {
      showToast('⚠️', lang === 'fr' ? 'Activez la localisation pour passer en ligne.' : 'Turn on location to go online.');
      return;
    }
    setDriverProfile((p) => ({ ...p, is_online: next }));
    try {
      await toggleOnline(next);
    } catch {
      setDriverProfile((p) => ({ ...p, is_online: !next }));
      showToast('⚠️', t('error_generic'));
    }
  }

  const pending = myRequests.find((r) => r.status === 'pending');
  const active = myRequests.find((r) => ['matched', 'en_route', 'arrived', 'in_progress'].includes(r.status));
  const completed = myRequests.filter((r) => r.status === 'completed');

  const today = new Date().toDateString();
  const todayCount = completed.filter((r) => new Date(r.created_at).toDateString() === today).length;
  const revenue = completed.reduce((sum, r) => sum + toMoney(r.price_estimate), 0);

  // Offer countdown — read-only (dispatch_offers has no client-writable
  // policy). expires_at is the server-side truth; this is purely a display
  // timer, never what actually cuts the offer off.
  useEffect(() => {
    if (!pending) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setOfferExpiresAt(null);
      return;
    }
    const supabase = createClient();
    let cancelled = false;
    supabase
      .from('dispatch_offers')
      .select('expires_at')
      .eq('request_id', pending.id)
      .eq('driver_id', driverId)
      .eq('status', 'offered')
      .order('offered_at', { ascending: false })
      .limit(1)
      .maybeSingle()
      .then(({ data }) => {
        if (!cancelled) setOfferExpiresAt(data?.expires_at ?? null);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending?.id, driverId]);

  useEffect(() => {
    if (!offerExpiresAt) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSecondsLeft(null);
      return;
    }
    function tick() {
      const remaining = Math.max(0, Math.round((new Date(offerExpiresAt!).getTime() - Date.now()) / 1000));
      setSecondsLeft(remaining);
    }
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [offerExpiresAt]);

  // Same nudge as the rider's tracking screen: while this driver holds an
  // outstanding offer, poll every few seconds so an abandoned offer (this
  // driver saw it, didn't respond) advances to the next candidate quickly
  // even if the rider's own tab happens to be closed. A no-op if nothing is
  // actually overdue yet.
  useEffect(() => {
    if (!pending) return;
    const supabase = createClient();
    const interval = setInterval(() => {
      supabase.rpc('nudge_dispatch', { p_request_id: pending.id });
    }, 5000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending?.id]);

  // Client identity — only ever fetched for an ACTIVE (matched-or-later)
  // job, never for a pending offer: the offer card must not surface a
  // rider's name or phone before this driver has even accepted.
  useEffect(() => {
    if (!active) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setClient(null);
      return;
    }
    const supabase = createClient();
    let cancelled = false;
    supabase
      .from('profiles')
      .select('full_name, phone')
      .eq('id', active.user_id)
      .maybeSingle()
      .then(({ data }) => {
        if (!cancelled && data) setClient({ name: data.full_name || '—', phone: data.phone });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id, active?.user_id]);

  async function handleAccept(id: string) {
    try {
      await acceptRequest(id);
      showToast('✅', lang === 'fr' ? 'Demande acceptée!' : 'Request accepted!');
    } catch {
      showToast('⚠️', t('error_generic'));
    }
  }

  async function handleDecline(id: string) {
    try {
      await declineRequest(id);
      showToast('❌', lang === 'fr' ? 'Demande refusée.' : 'Request declined.');
    } catch {
      showToast('⚠️', t('error_generic'));
    }
  }

  async function handleAdvance(id: string, next: Extract<RequestStatus, 'en_route' | 'arrived' | 'in_progress' | 'completed'>) {
    try {
      await advanceRequestStatus(id, next);
      if (next === 'completed') {
        setDriverProfile((p) => ({ ...p, total_services: p.total_services + 1 }));
      }
    } catch {
      showToast('⚠️', t('error_generic'));
    }
  }

  const heartbeatAgeMs = driverProfile.last_heartbeat_at ? now - new Date(driverProfile.last_heartbeat_at).getTime() : Infinity;
  const heartbeatStale = heartbeatAgeMs > HEARTBEAT_STALE_MS;
  const effectiveStatus: 'not_approved' | 'offline' | 'reconnecting' | 'online' = !isApproved
    ? 'not_approved'
    : !driverProfile.is_online
      ? 'offline'
      : heartbeatStale
        ? 'reconnecting'
        : 'online';

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
      <div className="flex justify-between items-center mb-4 flex-wrap gap-4">
        <div>
          <h2 className="font-display text-2xl font-bold">{t('driver_title')}</h2>
          <p className="text-text-2 text-sm mt-1">
            {fullName} · {driverProfile.vehicle_type} · {driverProfile.province}
          </p>
        </div>
        {isApproved ? (
          <div className="flex flex-col items-end gap-1.5">
            <div className="flex items-center gap-2.5">
              <label className="relative inline-block w-14 h-8">
                <input
                  type="checkbox"
                  checked={driverProfile.is_online}
                  onChange={handleToggleOnline}
                  className="peer sr-only"
                />
                <span className="absolute inset-0 bg-steel rounded-full peer-checked:bg-orange transition-colors cursor-pointer" />
                <span className="absolute left-1 top-1 w-6 h-6 bg-white rounded-full transition-transform peer-checked:translate-x-6" />
              </label>
              <Badge tone={effectiveStatus === 'online' ? 'green' : effectiveStatus === 'reconnecting' ? 'yellow' : 'red'}>
                {effectiveStatus === 'online'
                  ? t('online')
                  : effectiveStatus === 'reconnecting'
                    ? lang === 'fr'
                      ? 'Reconnexion…'
                      : 'Reconnecting…'
                    : t('offline')}
              </Badge>
            </div>
            {driverProfile.is_online && gpsStatus === 'denied' ? (
              <p className="text-xs text-red text-right max-w-[220px]">
                {lang === 'fr'
                  ? '📍 Localisation refusée — vous ne recevrez pas de demandes.'
                  : '📍 Location denied — you will not receive requests.'}
              </p>
            ) : null}
            {driverProfile.is_online && pingFailed && gpsStatus !== 'denied' ? (
              <p className="text-xs text-yellow text-right max-w-[220px]">
                {lang === 'fr' ? '📶 Connexion réseau instable.' : '📶 Unstable network connection.'}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>

      {needsOnboarding ? (
        <OnboardingForm onSaved={(update) => setDriverProfile((p) => ({ ...p, ...update }))} />
      ) : (
        <>
      {!isApproved ? (
        <Card orange className="mb-6">
          <p className="text-sm text-text-2">
            {driverProfile.approval_status === 'rejected'
              ? (lang === 'fr' ? "Votre inscription n'a pas été approuvée." : 'Your application was not approved.')
              : t('driver_pending_approval')}
          </p>
          {driverProfile.approval_status === 'rejected' && driverProfile.rejection_reason ? (
            <p className="text-sm text-text-2 mt-2 bg-night-3 border border-steel rounded-lg px-3 py-2">
              {lang === 'fr' ? 'Motif : ' : 'Reason: '}
              {driverProfile.rejection_reason}
            </p>
          ) : null}
          <Link href="/dashboard/driver/documents" className="inline-block mt-3 text-sm text-orange font-medium">
            {lang === 'fr' ? '📄 Gérer mes documents →' : '📄 Manage my documents →'}
          </Link>
        </Card>
      ) : null}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <StatCard label={t('stat_today')} value={String(todayCount)} />
        <StatCard label={t('stat_revenue')} value={`$${revenue.toFixed(0)}`} />
        {/* Same rule as the rider-facing card: the 5.0 default is a
            placeholder, not a score, until somebody has actually rated a job. */}
        <StatCard
          label={t('stat_rating')}
          value={driverProfile.total_services > 0 ? `${driverProfile.rating.toFixed(1)} ⭐` : t('driver_new')}
        />
        <StatCard label={t('stat_total')} value={String(driverProfile.total_services)} />
      </div>

      {pending ? (
        <Card orange className="mb-6">
          <div className="flex justify-between items-center mb-1">
            <h3 className="font-display text-base font-bold">{t('new_request')}</h3>
            {secondsLeft !== null ? (
              <span
                className={`font-display text-xl font-bold tabular-nums ${secondsLeft <= 5 ? 'text-red' : 'text-orange'}`}
              >
                {secondsLeft}s
              </span>
            ) : null}
          </div>
          <div className="w-full h-1.5 bg-night-3 rounded-full overflow-hidden mb-4">
            <div
              className={`h-full transition-all duration-1000 ${secondsLeft !== null && secondsLeft <= 5 ? 'bg-red' : 'bg-orange'}`}
              style={{ width: secondsLeft !== null ? `${Math.min(100, (secondsLeft / 18) * 100)}%` : '100%' }}
            />
          </div>

          <div className="text-center mb-4">
            <div className="text-4xl font-display font-bold text-orange">${toMoney(pending.price_estimate).toFixed(0)}</div>
            <div className="text-xs text-muted mt-0.5">{lang === 'fr' ? 'pour cette course' : 'for this job'}</div>
          </div>

          <div className="grid grid-cols-2 gap-3 mb-4 text-sm">
            <Field label={lang === 'fr' ? 'Type' : 'Type'} value={problemLabel(pending.problem_type, lang)} />
            <Field label={lang === 'fr' ? 'Véhicule' : 'Vehicle'} value={pending.vehicle_desc || '—'} />
            <Field label={lang === 'fr' ? 'Point de ramassage' : 'Pickup'} value={pending.location_text} />
            {driverProfile.current_lat != null && driverProfile.current_lng != null ? (
              (() => {
                const km = distanceKm({ lat: driverProfile.current_lat!, lng: driverProfile.current_lng! }, { lat: pending.lat, lng: pending.lng });
                return (
                  <Field
                    label={lang === 'fr' ? 'Distance jusqu’à vous' : 'Distance to pickup'}
                    value={`${km.toFixed(1)} km · ~${estimateEtaMinutes(km)} min`}
                  />
                );
              })()
            ) : null}
            {pending.destination_address ? (
              <Field
                wide
                label={lang === 'fr' ? 'Destination du remorquage' : 'Tow destination'}
                value={
                  pending.tow_distance_km != null
                    ? `${pending.destination_address} (${toMoney(pending.tow_distance_km).toFixed(1)} km)`
                    : pending.destination_address
                }
              />
            ) : null}
          </div>
          <div className="flex gap-2">
            <Button variant="red" size="lg" className="flex-1" onClick={() => handleDecline(pending.id)}>
              ❌ {t('btn_decline')}
            </Button>
            <Button variant="green" size="lg" className="flex-[2]" onClick={() => handleAccept(pending.id)}>
              ✅ {t('btn_accept')}
            </Button>
          </div>
        </Card>
      ) : isApproved ? (
        <Card className="mb-6">
          <p className="text-sm text-muted text-center py-2">{t('no_pending_requests')}</p>
        </Card>
      ) : null}

      {active ? <ActiveMission active={active} driverId={driverId} client={client} onAdvance={handleAdvance} /> : null}

      <Card>
        <div className="flex justify-between items-center mb-4">
          <h3 className="font-display text-lg font-bold">{t('recent_activity')}</h3>
          <Link href="/dashboard/driver/history" className="text-sm text-orange font-medium">
            {lang === 'fr' ? 'Voir tout →' : 'See all →'}
          </Link>
        </div>
        {loadingHistory ? (
          <p className="text-sm text-muted">…</p>
        ) : completed.length === 0 ? (
          <p className="text-sm text-muted">{t('no_pending_requests')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <tbody>
                {completed.slice(0, 5).map((r) => (
                  <tr key={r.id} className="border-b border-steel/50 last:border-none">
                    <td className="py-3 pr-3 text-muted">
                      {new Date(r.created_at).toLocaleDateString(lang === 'fr' ? 'fr-CA' : 'en-CA')}
                    </td>
                    <td className="py-3 pr-3">{problemLabel(r.problem_type, lang)}</td>
                    <td className="py-3 pr-3 text-text-2">{r.location_text}</td>
                    <td className="py-3 font-semibold text-green">${toMoney(r.price_estimate).toFixed(0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
        </>
      )}
    </div>
  );
}

// The mission that is currently "in flight" — matched through in_progress.
// Its own component so the client-identity fetch and map only run/render
// while there's an active job to show them for.
function ActiveMission({
  active,
  driverId,
  client,
  onAdvance,
}: {
  active: TowRequest;
  driverId: string;
  client: ClientInfo | null;
  onAdvance: (id: string, next: Extract<RequestStatus, 'en_route' | 'arrived' | 'in_progress' | 'completed'>) => void;
}) {
  const { t, lang } = useLanguage();

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

  const showingDestinationNav = active.status === 'in_progress' && active.destination_lat != null && active.destination_lng != null;
  const navTarget = showingDestinationNav
    ? { lat: active.destination_lat!, lng: active.destination_lng! }
    : { lat: active.lat, lng: active.lng };
  const googleMapsUrl = `https://www.google.com/maps/dir/?api=1&destination=${navTarget.lat},${navTarget.lng}&travelmode=driving`;
  const appleMapsUrl = `https://maps.apple.com/?daddr=${navTarget.lat},${navTarget.lng}&dirflg=d`;

  const markers = [
    { id: 'pickup', lat: active.lat, lng: active.lng, color: '#ff5c1a', label: lang === 'fr' ? 'Client' : 'Client' },
    ...(active.destination_lat != null && active.destination_lng != null
      ? [{ id: 'destination', lat: active.destination_lat, lng: active.destination_lng, color: '#3b82f6', label: lang === 'fr' ? 'Destination' : 'Destination' }]
      : []),
  ];

  return (
    <Card className="mb-6">
      <h3 className="font-display text-base font-bold mb-1">
        {problemLabel(active.problem_type, lang)} · {active.location_text}
      </h3>
      {active.destination_address ? (
        <p className="text-sm text-text-2 mb-3">
          ➜ {active.destination_address}
          {active.tow_distance_km != null ? ` (${toMoney(active.tow_distance_km).toFixed(1)} km)` : ''}
        </p>
      ) : (
        <div className="mb-3" />
      )}

      {client ? (
        <div className="bg-night-3 border border-steel rounded-xl p-3.5 flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-full bg-orange flex items-center justify-center font-display font-bold text-white text-sm shrink-0">
            {client.name.slice(0, 2).toUpperCase()}
          </div>
          <div className="flex-1 min-w-0">
            <div className="font-semibold text-sm truncate">{client.name}</div>
            <div className="text-xs text-muted">{active.vehicle_desc || '—'}</div>
          </div>
          {client.phone ? (
            <a
              href={`tel:${client.phone}`}
              className="w-10 h-10 rounded-full bg-green/15 text-green flex items-center justify-center text-lg shrink-0"
              aria-label={t('btn_call')}
            >
              📞
            </a>
          ) : null}
        </div>
      ) : null}

      <div className="mb-4 rounded-xl overflow-hidden border border-steel h-44">
        <MapView center={{ lat: active.lat, lng: active.lng }} markers={markers} zoom={12} className="w-full h-full" />
      </div>

      <div className="grid grid-cols-2 gap-2 mb-4">
        <a href={googleMapsUrl} target="_blank" rel="noopener noreferrer">
          <Button variant="secondary" full size="lg">
            🗺️ Google Maps
          </Button>
        </a>
        <a href={appleMapsUrl} target="_blank" rel="noopener noreferrer">
          <Button variant="secondary" full size="lg">
            🧭 Apple Maps
          </Button>
        </a>
      </div>

      <div className="mb-4">
        <StatusTracker current={active.status} labels={labels} />
      </div>

      <div className="flex gap-2 mb-4">
        {active.status === 'matched' ? (
          <Button full size="lg" onClick={() => onAdvance(active.id, 'en_route')}>
            🚛 {t('btn_start_route')}
          </Button>
        ) : null}
        {active.status === 'en_route' ? (
          <Button full size="lg" onClick={() => onAdvance(active.id, 'arrived')}>
            📍 {t('btn_arrived')}
          </Button>
        ) : null}
        {active.status === 'arrived' ? (
          <Button full size="lg" onClick={() => onAdvance(active.id, 'in_progress')}>
            🔧 {t('btn_start_intervention')}
          </Button>
        ) : null}
        {active.status === 'in_progress' ? (
          <Button full size="lg" variant="green" onClick={() => onAdvance(active.id, 'completed')}>
            🎉 {t('btn_finish')}
          </Button>
        ) : null}
      </div>

      <Chat requestId={active.id} currentUserId={driverId} quickMessages={DRIVER_QUICK_MESSAGES} />

      {/* Extras are proposed here and charged only once the customer has
          approved them in their own app. Nothing a driver does on this screen
          changes what the customer owes on its own. */}
      <SupplementsPanel requestId={active.id} role="driver" />
      <ProposeSupplement requestId={active.id} />
    </Card>
  );
}

function OnboardingForm({
  onSaved,
}: {
  onSaved: (update: { vehicle_type: VehicleType; province: string; license_plate: string; service_types: string[] }) => void;
}) {
  const { t, lang } = useLanguage();
  const { showToast } = useToast();
  const [vehicleType, setVehicleType] = useState<VehicleType>('standard');
  const [province, setProvince] = useState('');
  const [licensePlate, setLicensePlate] = useState('');
  const [phone, setPhone] = useState('');
  const [serviceTypes, setServiceTypes] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  function toggleServiceType(key: string) {
    setServiceTypes((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!province) return;
    setSaving(true);
    try {
      await updateDriverInfo({ vehicleType, province, licensePlate, phone, serviceTypes });
      onSaved({ vehicle_type: vehicleType, province, license_plate: licensePlate, service_types: serviceTypes });
    } catch {
      showToast('⚠️', t('error_generic'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <h3 className="font-display text-lg font-bold mb-1">
        {lang === 'fr' ? 'Complétez votre profil' : 'Complete your profile'}
      </h3>
      <p className="text-sm text-text-2 mb-5">
        {lang === 'fr'
          ? 'Ces informations sont requises avant de recevoir des demandes.'
          : 'This information is required before you can receive requests.'}
      </p>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <div>
          <Label>{lang === 'fr' ? 'Téléphone' : 'Phone'}</Label>
          <Input type="tel" required value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="514-555-0100" />
        </div>
        <div>
          <Label>{lang === 'fr' ? 'Type de véhicule' : 'Vehicle type'}</Label>
          <Select value={vehicleType} onChange={(e) => setVehicleType(e.target.value as VehicleType)}>
            <option value="standard">Standard</option>
            <option value="flatbed">Flatbed</option>
            <option value="heavy_duty">Heavy Duty</option>
          </Select>
        </div>
        <div>
          <Label>{lang === 'fr' ? 'Province' : 'Province'}</Label>
          <Select required value={province} onChange={(e) => setProvince(e.target.value)}>
            <option value="">-- {lang === 'fr' ? 'Choisir' : 'Select'} --</option>
            {CANADIAN_PROVINCES.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </Select>
          <p className="text-xs text-muted mt-1.5">
            {lang === 'fr'
              ? "Votre province est aussi votre secteur de service pour l'instant — TowConnect n'a pas encore de zones plus précises."
              : "Your province is also your service area for now — TowConnect does not yet have finer-grained zones."}
          </p>
        </div>
        <div>
          <Label>{lang === 'fr' ? 'Plaque' : 'License plate'}</Label>
          <Input value={licensePlate} onChange={(e) => setLicensePlate(e.target.value)} />
        </div>
        <div>
          <Label>{lang === 'fr' ? 'Services offerts' : 'Services offered'}</Label>
          <div className="grid grid-cols-2 gap-2">
            {PROBLEM_TYPES.map((p) => (
              <button
                key={p.key}
                type="button"
                onClick={() => toggleServiceType(p.key)}
                className={`px-3 py-2.5 rounded-xl border text-sm font-medium text-left transition-colors ${
                  serviceTypes.includes(p.key) ? 'border-orange bg-orange/10 text-orange' : 'border-steel text-text-2'
                }`}
              >
                {p.icon} {lang === 'fr' ? p.fr : p.en}
              </button>
            ))}
          </div>
          <p className="text-xs text-muted mt-1.5">
            {lang === 'fr'
              ? "Informatif pour l'instant — n'affecte pas encore les demandes que vous recevez."
              : 'Informational for now — does not yet affect which requests you receive.'}
          </p>
        </div>
        <Button type="submit" full size="lg" disabled={saving}>
          {lang === 'fr' ? 'Enregistrer' : 'Save'}
        </Button>
      </form>
    </Card>
  );
}

function Field({ label, value, wide }: { label: string; value: string; wide?: boolean }) {
  return (
    <div className={wide ? 'col-span-2' : undefined}>
      <div className="text-xs text-muted mb-1">{label}</div>
      <div className="font-semibold">{value}</div>
    </div>
  );
}
