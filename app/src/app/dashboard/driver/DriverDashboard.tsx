'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useLanguage } from '@/lib/i18n/LanguageProvider';
import { useToast } from '@/components/ToastProvider';
import { Card, StatCard } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { acceptRequest, advanceRequestStatus, declineRequest, toggleOnline, updateDriverInfo, updateDriverLocation } from '@/lib/actions/driver';
import { problemLabel, CANADIAN_PROVINCES } from '@/lib/constants';
import { toMoney } from '@/lib/pricing';
import { Select, Input, Label } from '@/components/ui/Field';
import type { DriverProfile, RequestStatus, TowRequest, VehicleType } from '@/lib/supabase/types';

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

  const isApproved = driverProfile.approval_status === 'approved';
  const needsOnboarding = !driverProfile.province;

  // Load this driver's request history + active jobs, then stay in sync via realtime.
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

    const channel = supabase
      .channel(`driver-requests-${driverId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'requests', filter: `driver_id=eq.${driverId}` },
        () => load()
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [driverId]);

  // Broadcast live location every 20s while online, so users can see the
  // driver moving on the map.
  useEffect(() => {
    if (!driverProfile.is_online || !navigator.geolocation) return;

    function ping() {
      navigator.geolocation.getCurrentPosition((pos) => {
        updateDriverLocation(pos.coords.latitude, pos.coords.longitude);
      });
    }
    ping();
    const interval = setInterval(ping, 20000);
    return () => clearInterval(interval);
  }, [driverProfile.is_online]);

  async function handleToggleOnline() {
    const next = !driverProfile.is_online;
    setDriverProfile((p) => ({ ...p, is_online: next }));
    try {
      await toggleOnline(next);
    } catch {
      setDriverProfile((p) => ({ ...p, is_online: !next }));
      showToast('⚠️', t('error_generic'));
    }
  }

  const pending = myRequests.find((r) => r.status === 'pending');
  const active = myRequests.find((r) => ['matched', 'en_route', 'arrived'].includes(r.status));
  const completed = myRequests.filter((r) => r.status === 'completed');

  const today = new Date().toDateString();
  const todayCount = completed.filter((r) => new Date(r.created_at).toDateString() === today).length;
  const revenue = completed.reduce((sum, r) => sum + toMoney(r.price_estimate), 0);

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

  async function handleAdvance(id: string, next: Extract<RequestStatus, 'en_route' | 'arrived' | 'completed'>) {
    try {
      await advanceRequestStatus(id, next);
      if (next === 'completed') {
        setDriverProfile((p) => ({ ...p, total_services: p.total_services + 1 }));
      }
    } catch {
      showToast('⚠️', t('error_generic'));
    }
  }

  return (
    <div className="max-w-4xl mx-auto px-6 py-8">
      <div className="flex justify-between items-center mb-6 flex-wrap gap-4">
        <div>
          <h2 className="font-display text-2xl font-bold">{t('driver_title')}</h2>
          <p className="text-text-2 text-sm mt-1">
            {fullName} · {driverProfile.vehicle_type} · {driverProfile.province}
          </p>
        </div>
        {isApproved ? (
          <div className="flex items-center gap-2.5">
            <label className="relative inline-block w-11 h-6">
              <input
                type="checkbox"
                checked={driverProfile.is_online}
                onChange={handleToggleOnline}
                className="peer sr-only"
              />
              <span className="absolute inset-0 bg-steel rounded-full peer-checked:bg-orange transition-colors cursor-pointer" />
              <span className="absolute left-0.5 top-0.5 w-5 h-5 bg-white rounded-full transition-transform peer-checked:translate-x-5" />
            </label>
            <Badge tone={driverProfile.is_online ? 'green' : 'red'}>
              {driverProfile.is_online ? t('online') : t('offline')}
            </Badge>
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
        </Card>
      ) : null}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <StatCard label={t('stat_today')} value={String(todayCount)} />
        <StatCard label={t('stat_revenue')} value={`$${revenue.toFixed(0)}`} />
        <StatCard label={t('stat_rating')} value={`${driverProfile.rating.toFixed(1)} ⭐`} />
        <StatCard label={t('stat_total')} value={String(driverProfile.total_services)} />
      </div>

      {pending ? (
        <Card orange className="mb-6">
          <div className="flex justify-between items-center mb-4">
            <h3 className="font-display text-base font-bold">{t('new_request')}</h3>
          </div>
          <div className="grid grid-cols-2 gap-3 mb-4 text-sm">
            <Field label={lang === 'fr' ? 'Type' : 'Type'} value={problemLabel(pending.problem_type, lang)} />
            <Field label={lang === 'fr' ? 'Localisation' : 'Location'} value={pending.location_text} />
            <Field label={lang === 'fr' ? 'Véhicule' : 'Vehicle'} value={pending.vehicle_desc || '—'} />
            <Field label={lang === 'fr' ? 'Prix' : 'Price'} value={`$${toMoney(pending.price_estimate).toFixed(0)}`} />
          </div>
          <div className="flex gap-2">
            <Button variant="red" className="flex-1" onClick={() => handleDecline(pending.id)}>
              ❌ {t('btn_decline')}
            </Button>
            <Button variant="green" className="flex-[2]" onClick={() => handleAccept(pending.id)}>
              ✅ {t('btn_accept')} — ${toMoney(pending.price_estimate).toFixed(0)}
            </Button>
          </div>
        </Card>
      ) : isApproved ? (
        <Card className="mb-6">
          <p className="text-sm text-muted text-center py-2">{t('no_pending_requests')}</p>
        </Card>
      ) : null}

      {active ? (
        <Card className="mb-6">
          <h3 className="font-display text-base font-bold mb-4">
            {problemLabel(active.problem_type, lang)} · {active.location_text}
          </h3>
          <div className="flex gap-2">
            {active.status === 'matched' ? (
              <Button full onClick={() => handleAdvance(active.id, 'en_route')}>
                🚛 {t('btn_start_route')}
              </Button>
            ) : null}
            {active.status === 'en_route' ? (
              <Button full onClick={() => handleAdvance(active.id, 'arrived')}>
                📍 {t('btn_arrived')}
              </Button>
            ) : null}
            {active.status === 'arrived' ? (
              <Button full variant="green" onClick={() => handleAdvance(active.id, 'completed')}>
                🎉 {t('btn_complete')}
              </Button>
            ) : null}
          </div>
        </Card>
      ) : null}

      <Card>
        <h3 className="font-display text-lg font-bold mb-4">{t('recent_activity')}</h3>
        {loadingHistory ? (
          <p className="text-sm text-muted">…</p>
        ) : completed.length === 0 ? (
          <p className="text-sm text-muted">{t('no_pending_requests')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <tbody>
                {completed.slice(0, 8).map((r) => (
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

function OnboardingForm({
  onSaved,
}: {
  onSaved: (update: { vehicle_type: VehicleType; province: string; license_plate: string }) => void;
}) {
  const { t, lang } = useLanguage();
  const { showToast } = useToast();
  const [vehicleType, setVehicleType] = useState<VehicleType>('standard');
  const [province, setProvince] = useState('');
  const [licensePlate, setLicensePlate] = useState('');
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!province) return;
    setSaving(true);
    try {
      await updateDriverInfo({ vehicleType, province, licensePlate });
      onSaved({ vehicle_type: vehicleType, province, license_plate: licensePlate });
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
        </div>
        <div>
          <Label>{lang === 'fr' ? 'Plaque' : 'License plate'}</Label>
          <Input value={licensePlate} onChange={(e) => setLicensePlate(e.target.value)} />
        </div>
        <Button type="submit" full disabled={saving}>
          {lang === 'fr' ? 'Enregistrer' : 'Save'}
        </Button>
      </form>
    </Card>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-muted mb-1">{label}</div>
      <div className="font-semibold">{value}</div>
    </div>
  );
}
