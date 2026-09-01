'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useLanguage } from '@/lib/i18n/LanguageProvider';
import { useToast } from '@/components/ToastProvider';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Input, Label, Select } from '@/components/ui/Field';
import { CANADIAN_PROVINCES, PROBLEM_TYPES, VEHICLE_TYPE_LABEL } from '@/lib/constants';
import { updateDriverInfo } from '@/lib/actions/driver';
import type { DriverProfile as DriverProfileRow, VehicleType } from '@/lib/supabase/types';

export function DriverProfile({
  fullName,
  phone,
  driverProfile,
}: {
  fullName: string;
  phone: string | null;
  driverProfile: DriverProfileRow;
}) {
  const { lang } = useLanguage();
  const { showToast } = useToast();
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    phone: phone ?? '',
    vehicleType: driverProfile.vehicle_type,
    province: driverProfile.province,
    licensePlate: driverProfile.license_plate ?? '',
    serviceTypes: driverProfile.service_types,
  });
  const [saved, setSaved] = useState({ ...form });

  function toggleServiceType(key: string) {
    setForm((f) => ({
      ...f,
      serviceTypes: f.serviceTypes.includes(key) ? f.serviceTypes.filter((k) => k !== key) : [...f.serviceTypes, key],
    }));
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await updateDriverInfo({
        vehicleType: form.vehicleType,
        province: form.province,
        licensePlate: form.licensePlate,
        phone: form.phone,
        serviceTypes: form.serviceTypes,
      });
      setSaved({ ...form });
      setEditing(false);
      showToast('✅', lang === 'fr' ? 'Profil mis à jour.' : 'Profile updated.');
    } catch {
      showToast('⚠️', lang === 'fr' ? 'Une erreur est survenue.' : 'Something went wrong.');
    } finally {
      setSaving(false);
    }
  }

  const approvalTone =
    driverProfile.approval_status === 'approved' ? 'green' : driverProfile.approval_status === 'rejected' ? 'red' : 'yellow';
  const approvalLabel =
    driverProfile.approval_status === 'approved'
      ? lang === 'fr'
        ? 'Approuvé'
        : 'Approved'
      : driverProfile.approval_status === 'rejected'
        ? lang === 'fr'
          ? 'Rejeté'
          : 'Rejected'
        : lang === 'fr'
          ? 'En attente'
          : 'Pending review';

  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
      <div className="flex justify-between items-start mb-6 flex-wrap gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold">{lang === 'fr' ? 'Mon profil' : 'My profile'}</h1>
          <p className="text-text-2 text-sm mt-1">
            {lang === 'fr' ? 'Votre identité et vos informations de service.' : 'Your identity and service details.'}
          </p>
        </div>
        <Link href="/dashboard/driver" className="text-sm text-orange font-medium">
          {lang === 'fr' ? '← Retour' : '← Back'}
        </Link>
      </div>

      <Card className="mb-4">
        <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
          <div className="flex items-center gap-3">
            <div className="w-14 h-14 rounded-full bg-orange flex items-center justify-center font-display font-bold text-white text-xl shrink-0">
              {fullName.slice(0, 2).toUpperCase()}
            </div>
            <div>
              <div className="font-display font-bold text-lg">{fullName}</div>
              <div className="text-xs text-muted">
                {driverProfile.total_services > 0
                  ? `⭐ ${driverProfile.rating.toFixed(1)} · ${driverProfile.total_services} ${lang === 'fr' ? 'services' : 'services'}`
                  : lang === 'fr'
                    ? 'Nouveau · 0 service'
                    : 'New · 0 services'}
              </div>
            </div>
          </div>
          <Badge tone={approvalTone}>{approvalLabel}</Badge>
        </div>
        {driverProfile.approval_status === 'rejected' && driverProfile.rejection_reason ? (
          <div className="text-sm text-text-2 bg-night-3 border border-steel rounded-lg px-3 py-2">
            {lang === 'fr' ? 'Motif du rejet : ' : 'Rejection reason: '}
            {driverProfile.rejection_reason}
          </div>
        ) : null}
      </Card>

      <Card>
        <div className="flex justify-between items-center mb-4">
          <h3 className="font-display text-base font-bold">{lang === 'fr' ? 'Informations' : 'Details'}</h3>
          {!editing ? (
            <Button variant="secondary" className="!px-3 !py-1.5 text-xs" onClick={() => setEditing(true)}>
              {lang === 'fr' ? 'Modifier' : 'Edit'}
            </Button>
          ) : null}
        </div>

        {!editing ? (
          <div className="grid grid-cols-2 gap-4 text-sm">
            <Info label={lang === 'fr' ? 'Téléphone' : 'Phone'} value={saved.phone || '—'} />
            <Info label={lang === 'fr' ? 'Véhicule' : 'Vehicle'} value={VEHICLE_TYPE_LABEL[saved.vehicleType] ?? saved.vehicleType} />
            <Info label={lang === 'fr' ? 'Province' : 'Province'} value={saved.province || '—'} />
            <Info label={lang === 'fr' ? 'Plaque' : 'Plate'} value={saved.licensePlate || '—'} />
            <div className="col-span-2">
              <div className="text-xs text-muted mb-1.5">{lang === 'fr' ? 'Services offerts' : 'Services offered'}</div>
              {saved.serviceTypes.length === 0 ? (
                <span className="text-text-2">—</span>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {saved.serviceTypes.map((key) => {
                    const p = PROBLEM_TYPES.find((p) => p.key === key);
                    return (
                      <span key={key} className="px-2.5 py-1 rounded-full bg-night-3 border border-steel text-xs">
                        {p ? `${p.icon} ${lang === 'fr' ? p.fr : p.en}` : key}
                      </span>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        ) : (
          <form onSubmit={handleSave} className="flex flex-col gap-4">
            <div>
              <Label>{lang === 'fr' ? 'Téléphone' : 'Phone'}</Label>
              <Input type="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
            </div>
            <div>
              <Label>{lang === 'fr' ? 'Type de véhicule' : 'Vehicle type'}</Label>
              <Select value={form.vehicleType} onChange={(e) => setForm({ ...form, vehicleType: e.target.value as VehicleType })}>
                <option value="standard">Standard</option>
                <option value="flatbed">Flatbed</option>
                <option value="heavy_duty">Heavy Duty</option>
              </Select>
            </div>
            <div>
              <Label>{lang === 'fr' ? 'Province' : 'Province'}</Label>
              <Select required value={form.province} onChange={(e) => setForm({ ...form, province: e.target.value })}>
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
              <Input value={form.licensePlate} onChange={(e) => setForm({ ...form, licensePlate: e.target.value })} />
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
                      form.serviceTypes.includes(p.key) ? 'border-orange bg-orange/10 text-orange' : 'border-steel text-text-2'
                    }`}
                  >
                    {p.icon} {lang === 'fr' ? p.fr : p.en}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex gap-2 mt-1">
              <Button
                type="button"
                variant="secondary"
                className="flex-1"
                onClick={() => {
                  setForm({ ...saved });
                  setEditing(false);
                }}
              >
                {lang === 'fr' ? 'Annuler' : 'Cancel'}
              </Button>
              <Button type="submit" className="flex-[2]" disabled={saving}>
                {lang === 'fr' ? 'Enregistrer' : 'Save'}
              </Button>
            </div>
          </form>
        )}
      </Card>
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-muted mb-1">{label}</div>
      <div className="font-semibold">{value}</div>
    </div>
  );
}
