'use client';

import { useState } from 'react';
import { useLanguage } from '@/lib/i18n/LanguageProvider';
import { useToast } from '@/components/ToastProvider';
import { Card, StatCard } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input, Label } from '@/components/ui/Field';
import { Badge } from '@/components/ui/Badge';
import { problemLabel } from '@/lib/constants';
import { toMoney } from '@/lib/pricing';
import {
  assignDriverToVehicle,
  createFleetVehicle,
  createRadiusServiceArea,
  unassignVehicle,
  type CompanyMemberRow,
} from '@/lib/actions/company';
import { BusinessFinance } from './BusinessFinance';
import type { ConnectAvailability } from '@/lib/actions/connect';
import type {
  Company,
  CompanyMemberRole,
  CompanyServiceArea,
  DriverVehicleAssignment,
  FleetVehicle,
  ProviderBalances,
  ProviderLedgerEntry,
  ProviderPayout,
  ServiceCapability,
  TowRequest,
  VehicleType,
} from '@/lib/supabase/types';
import { errorMessageKey } from '@/lib/errors';

const CAPABILITIES: ServiceCapability[] = [
  'flatbed',
  'wheel_lift',
  'heavy_duty',
  'winch',
  'boost',
  'lockout',
  'tire_change',
  'fuel_delivery',
  'recovery',
];

const CAPABILITY_LABEL: Record<ServiceCapability, { fr: string; en: string }> = {
  flatbed: { fr: 'Plateforme', en: 'Flatbed' },
  wheel_lift: { fr: 'Élévateur de roues', en: 'Wheel lift' },
  heavy_duty: { fr: 'Lourd', en: 'Heavy duty' },
  winch: { fr: 'Treuil', en: 'Winch' },
  boost: { fr: 'Survoltage', en: 'Boost' },
  lockout: { fr: 'Déverrouillage', en: 'Lockout' },
  tire_change: { fr: 'Changement de pneu', en: 'Tire change' },
  fuel_delivery: { fr: 'Livraison de carburant', en: 'Fuel delivery' },
  recovery: { fr: 'Récupération', en: 'Recovery' },
};

interface ZoneAuthorization {
  id: string;
  official_operator_name: string;
  authorization_status: string;
  valid_from: string | null;
  valid_to: string | null;
  zone_id: string;
}

type Tab = 'drivers' | 'vehicles' | 'jobs' | 'areas' | 'zones' | 'finance';

export function BusinessDashboard({
  company,
  role,
  members,
  vehicles,
  assignments,
  areas,
  jobs,
  zoneAuthorizations,
  finance,
}: {
  company: Company;
  role: CompanyMemberRole;
  members: CompanyMemberRow[];
  vehicles: FleetVehicle[];
  assignments: DriverVehicleAssignment[];
  areas: CompanyServiceArea[];
  jobs: TowRequest[];
  // Present only for an owner or admin. Absent — not empty — for everybody
  // else, so there is nothing to render rather than zeros to misread.
  finance: {
    balances: ProviderBalances;
    entries: ProviderLedgerEntry[];
    payouts: ProviderPayout[];
    connect: ConnectAvailability;
  } | null;
  zoneAuthorizations: ZoneAuthorization[];
}) {
  const { t, lang } = useLanguage();
  const { showToast } = useToast();
  const [tab, setTab] = useState<Tab>('drivers');
  const [busy, setBusy] = useState(false);

  // Owner/admin/dispatcher can run the day; a member with role 'driver'
  // reaching this page sees it read-only. The server enforces the same thing
  // through RLS — this only stops the UI offering buttons that would fail.
  const isManager = role === 'owner' || role === 'admin' || role === 'dispatcher';

  const drivers = members.filter((m) => m.role === 'driver');
  const onlineCount = drivers.filter((d) => d.isOnline).length;
  const activeJobs = jobs.filter((j) =>
    ['matched', 'en_route', 'arrived', 'in_progress'].includes(j.status)
  );

  const assignmentByDriver = new Map(assignments.map((a) => [a.driver_id, a]));
  const assignmentByVehicle = new Map(assignments.map((a) => [a.fleet_vehicle_id, a]));

  const capLabel = (c: ServiceCapability) => CAPABILITY_LABEL[c][lang === 'fr' ? 'fr' : 'en'];

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      showToast('⚠️', t(errorMessageKey(e)));
    } finally {
      setBusy(false);
    }
  }

  const tabs: { key: Tab; label: string }[] = [
    { key: 'drivers', label: t('biz_drivers') },
    { key: 'vehicles', label: t('biz_vehicles') },
    { key: 'jobs', label: t('biz_jobs') },
    { key: 'areas', label: t('biz_areas') },
    { key: 'zones', label: t('biz_zones') },
    // A dispatcher runs the day but does not see the company's money. The tab
    // is absent for them because the data behind it was never fetched.
    ...(finance ? [{ key: 'finance' as Tab, label: t('biz_finance') }] : []),
  ];

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8">
      <header className="mb-6">
        <h1 className="font-display text-2xl font-bold">{company.display_name || company.name}</h1>
        <p className="text-sm text-muted mt-1">
          {t('biz_title')} · {role}
          {company.province ? ` · ${company.province}` : ''}
        </p>
      </header>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        <StatCard label={t('biz_drivers')} value={String(drivers.length)} />
        <StatCard
          label={t('online')}
          value={String(onlineCount)}
          changeTone={onlineCount > 0 ? 'up' : 'muted'}
        />
        <StatCard label={t('biz_vehicles')} value={String(vehicles.length)} />
        <StatCard label={t('biz_jobs')} value={String(activeJobs.length)} />
      </div>

      <div className="flex gap-1.5 overflow-x-auto pb-2 mb-4 -mx-1 px-1">
        {tabs.map((x) => (
          <button
            key={x.key}
            onClick={() => setTab(x.key)}
            className={`px-4 py-2 rounded-lg text-sm font-medium whitespace-nowrap transition-colors ${
              tab === x.key ? 'bg-orange-dark text-white' : 'bg-night-2 text-text-2 border border-night-4'
            }`}
          >
            {x.label}
          </button>
        ))}
      </div>

      {tab === 'drivers' ? (
        <Card>
          {drivers.length === 0 ? (
            <p className="text-sm text-muted">{t('biz_no_drivers')}</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {drivers.map((d) => {
                const assignment = assignmentByDriver.get(d.profile_id);
                const vehicle = assignment
                  ? vehicles.find((v) => v.id === assignment.fleet_vehicle_id)
                  : null;
                return (
                  <li
                    key={d.id}
                    className="bg-night-3 border border-night-4 rounded-xl p-3.5 flex flex-wrap items-center gap-x-3 gap-y-2"
                  >
                    <span className="font-semibold text-sm">{d.fullName}</span>
                    {d.isOnline ? (
                      <Badge tone="green">{t('online')}</Badge>
                    ) : (
                      <Badge tone="red" dot={false}>
                        {t('offline')}
                      </Badge>
                    )}
                    {d.approvalStatus && d.approvalStatus !== 'approved' ? (
                      <Badge tone="yellow">{d.approvalStatus}</Badge>
                    ) : null}
                    <span className="text-xs text-muted ml-auto">
                      {vehicle ? vehicle.label || vehicle.plate || vehicle.truck_type : t('biz_unassigned')}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      ) : null}

      {tab === 'vehicles' ? (
        <div className="flex flex-col gap-4">
          <Card>
            {vehicles.length === 0 ? (
              <p className="text-sm text-muted">{t('biz_no_vehicles')}</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {vehicles.map((v) => {
                  const assignment = assignmentByVehicle.get(v.id);
                  const driver = assignment
                    ? drivers.find((d) => d.profile_id === assignment.driver_id)
                    : null;
                  return (
                    <li key={v.id} className="bg-night-3 border border-night-4 rounded-xl p-3.5">
                      <div className="flex flex-wrap items-center gap-2 mb-2">
                        <span className="font-semibold text-sm">
                          {v.label || v.plate || v.truck_type}
                        </span>
                        <Badge tone={v.status === 'active' ? 'green' : 'yellow'}>{v.status}</Badge>
                        <span className="text-xs text-muted">{v.truck_type}</span>
                      </div>
                      <div className="flex flex-wrap gap-1.5 mb-2">
                        {v.capabilities.length === 0 ? (
                          <span className="text-xs text-muted">
                            {lang === 'fr' ? 'Équipement non déclaré' : 'Equipment not declared'}
                          </span>
                        ) : (
                          v.capabilities.map((c) => (
                            <span
                              key={c}
                              className="px-2 py-0.5 rounded-full bg-orange/12 text-orange text-[11px] font-semibold"
                            >
                              {capLabel(c)}
                            </span>
                          ))
                        )}
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs text-text-2">
                          {driver ? driver.fullName : t('biz_unassigned')}
                        </span>
                        {isManager ? (
                          assignment ? (
                            <Button
                              size="md"
                              variant="secondary"
                              disabled={busy}
                              onClick={() => run(() => unassignVehicle(assignment.id))}
                            >
                              {t('biz_unassign')}
                            </Button>
                          ) : (
                            <AssignDriver
                              drivers={drivers.filter((d) => !assignmentByDriver.has(d.profile_id))}
                              disabled={busy}
                              onAssign={(driverId) =>
                                run(() => assignDriverToVehicle(v.id, driverId))
                              }
                            />
                          )
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          {isManager ? (
            <AddVehicleForm companyId={company.id} busy={busy} onRun={run} capLabel={capLabel} />
          ) : null}
        </div>
      ) : null}

      {tab === 'jobs' ? (
        <Card>
          {jobs.length === 0 ? (
            <p className="text-sm text-muted">{t('biz_no_jobs')}</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {jobs.map((j) => (
                <li
                  key={j.id}
                  className="bg-night-3 border border-night-4 rounded-xl p-3.5 flex flex-wrap items-center gap-x-3 gap-y-1"
                >
                  <span className="text-sm">{problemLabel(j.problem_type, lang)}</span>
                  <Badge
                    tone={
                      j.status === 'completed' ? 'green' : j.status === 'cancelled' ? 'red' : 'orange'
                    }
                  >
                    {j.status}
                  </Badge>
                  <span className="text-xs text-muted truncate max-w-full sm:max-w-[45%]">
                    {j.location_text}
                  </span>
                  <span className="text-sm font-semibold text-orange ml-auto">
                    ${toMoney(j.price_estimate).toFixed(0)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      ) : null}

      {tab === 'areas' ? (
        <div className="flex flex-col gap-4">
          <Card>
            {areas.length === 0 ? (
              <p className="text-sm text-muted">{t('biz_no_areas')}</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {areas.map((a) => (
                  <li
                    key={a.id}
                    className="bg-night-3 border border-night-4 rounded-xl p-3.5 flex items-center gap-3"
                  >
                    <span className="text-sm font-semibold">{a.name}</span>
                    <span className="text-xs text-muted">
                      {a.kind === 'radius' ? `${a.radius_km} km` : 'polygon'}
                    </span>
                    <Badge tone={a.active ? 'green' : 'yellow'}>
                      {a.active ? t('adm_zone_active') : t('adm_zone_inactive')}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
            <p className="text-xs text-muted mt-3">
              {lang === 'fr'
                ? 'Une zone de service ne peut que restreindre où vous recevez des offres. Elle ne donne jamais accès à une zone réglementée.'
                : 'A service area can only narrow where you receive offers. It never grants access to a regulated zone.'}
            </p>
          </Card>
          {isManager ? <AddAreaForm companyId={company.id} busy={busy} onRun={run} /> : null}
        </div>
      ) : null}

      {tab === 'finance' && finance ? (
        <BusinessFinance
          company={company}
          balances={finance.balances}
          entries={finance.entries}
          payouts={finance.payouts}
          connect={finance.connect}
        />
      ) : null}

      {tab === 'zones' ? (
        <Card>
          {zoneAuthorizations.length === 0 ? (
            <>
              <p className="text-sm text-muted">{t('biz_no_zone_auth')}</p>
              <p className="text-xs text-muted mt-3">
                {lang === 'fr'
                  ? "Une autorisation en zone réglementée est accordée par un administrateur à partir d'une source officielle. Elle ne peut pas être demandée depuis cet écran."
                  : 'A regulated-zone authorization is granted by an administrator from an official source. It cannot be requested from this screen.'}
              </p>
            </>
          ) : (
            <ul className="flex flex-col gap-2">
              {zoneAuthorizations.map((z) => (
                <li
                  key={z.id}
                  className="bg-night-3 border border-night-4 rounded-xl p-3.5 flex flex-wrap items-center gap-2"
                >
                  <span className="text-sm font-semibold">{z.official_operator_name}</span>
                  <Badge tone={z.authorization_status === 'authorized' ? 'green' : 'yellow'}>
                    {z.authorization_status}
                  </Badge>
                  {z.valid_to ? (
                    <span className="text-xs text-muted ml-auto">→ {z.valid_to}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </Card>
      ) : null}
    </div>
  );
}

function AssignDriver({
  drivers,
  disabled,
  onAssign,
}: {
  drivers: CompanyMemberRow[];
  disabled: boolean;
  onAssign: (driverId: string) => void;
}) {
  const { t } = useLanguage();
  const [value, setValue] = useState('');
  if (drivers.length === 0) return null;
  return (
    <div className="flex items-center gap-2">
      <select
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className="bg-night-2 border border-night-4 rounded-lg px-3 py-2 text-sm text-text"
      >
        <option value="">—</option>
        {drivers.map((d) => (
          <option key={d.profile_id} value={d.profile_id}>
            {d.fullName}
          </option>
        ))}
      </select>
      <Button size="md" disabled={disabled || !value} onClick={() => onAssign(value)}>
        {t('biz_assign')}
      </Button>
    </div>
  );
}

function AddVehicleForm({
  companyId,
  busy,
  onRun,
  capLabel,
}: {
  companyId: string;
  busy: boolean;
  onRun: (fn: () => Promise<void>) => Promise<void>;
  capLabel: (c: ServiceCapability) => string;
}) {
  const { t } = useLanguage();
  const [label, setLabel] = useState('');
  const [plate, setPlate] = useState('');
  const [truckType, setTruckType] = useState<VehicleType>('standard');
  const [caps, setCaps] = useState<ServiceCapability[]>([]);

  return (
    <Card>
      <h3 className="font-display font-bold text-sm mb-4">{t('biz_add_vehicle')}</h3>
      <div className="grid sm:grid-cols-3 gap-3 mb-3">
        <div>
          <Label>{t('biz_label')}</Label>
          <Input value={label} onChange={(e) => setLabel(e.target.value)} />
        </div>
        <div>
          <Label>{t('biz_plate')}</Label>
          <Input value={plate} onChange={(e) => setPlate(e.target.value)} />
        </div>
        <div>
          <Label>{t('biz_truck_type')}</Label>
          <select
            value={truckType}
            onChange={(e) => setTruckType(e.target.value as VehicleType)}
            className="w-full bg-night-3 border border-steel rounded-xl px-4 py-3 text-text"
          >
            <option value="standard">standard</option>
            <option value="flatbed">flatbed</option>
            <option value="heavy_duty">heavy_duty</option>
          </select>
        </div>
      </div>

      <Label>{t('biz_capabilities')}</Label>
      <div className="flex flex-wrap gap-1.5 mb-4">
        {CAPABILITIES.map((c) => {
          const on = caps.includes(c);
          return (
            <button
              key={c}
              type="button"
              onClick={() => setCaps((prev) => (on ? prev.filter((x) => x !== c) : [...prev, c]))}
              className={`px-3 py-1.5 rounded-full text-xs font-semibold border transition-colors ${
                on ? 'bg-orange/15 text-orange border-orange/40' : 'bg-night-3 text-text-2 border-night-4'
              }`}
            >
              {capLabel(c)}
            </button>
          );
        })}
      </div>

      <Button
        disabled={busy}
        onClick={() =>
          onRun(async () => {
            await createFleetVehicle(companyId, {
              label,
              truckType,
              plate,
              province: '',
              capabilities: caps,
            });
            setLabel('');
            setPlate('');
            setCaps([]);
          })
        }
      >
        {t('biz_add_vehicle')}
      </Button>
    </Card>
  );
}

function AddAreaForm({
  companyId,
  busy,
  onRun,
}: {
  companyId: string;
  busy: boolean;
  onRun: (fn: () => Promise<void>) => Promise<void>;
}) {
  const { t, lang } = useLanguage();
  const [name, setName] = useState('');
  const [lat, setLat] = useState('');
  const [lng, setLng] = useState('');
  const [radius, setRadius] = useState('40');

  return (
    <Card>
      <h3 className="font-display font-bold text-sm mb-1">{t('biz_add_area')}</h3>
      <p className="text-xs text-muted mb-4">
        {lang === 'fr'
          ? 'Rayon seulement. Les polygones sont supportés par la base mais demandent un éditeur de carte — les saisir à la main produirait une limite fausse.'
          : 'Radius only. Polygons are supported by the database but need a map editor — entering one by hand would produce a wrong boundary.'}
      </p>
      <div className="grid sm:grid-cols-4 gap-3 mb-4">
        <div>
          <Label>{t('biz_area_name')}</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <Label>Lat</Label>
          <Input value={lat} onChange={(e) => setLat(e.target.value)} inputMode="decimal" />
        </div>
        <div>
          <Label>Lng</Label>
          <Input value={lng} onChange={(e) => setLng(e.target.value)} inputMode="decimal" />
        </div>
        <div>
          <Label>{t('biz_area_radius')}</Label>
          <Input value={radius} onChange={(e) => setRadius(e.target.value)} inputMode="decimal" />
        </div>
      </div>
      <Button
        disabled={busy || !name.trim() || !lat || !lng}
        onClick={() =>
          onRun(async () => {
            await createRadiusServiceArea(companyId, {
              name,
              lat: parseFloat(lat),
              lng: parseFloat(lng),
              radiusKm: parseFloat(radius),
            });
            setName('');
            setLat('');
            setLng('');
          })
        }
      >
        {t('biz_add_area')}
      </Button>
    </Card>
  );
}
