'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useLanguage } from '@/lib/i18n/LanguageProvider';
import { useToast } from '@/components/ToastProvider';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Input, Label, Select } from '@/components/ui/Field';
import { CANADIAN_PROVINCES } from '@/lib/constants';
import {
  createVehicle,
  deleteVehicle,
  setPrimaryVehicle,
  updateVehicle,
  type VehicleInput,
} from '@/lib/actions/vehicles';
import type { Vehicle } from '@/lib/supabase/types';

const CURRENT_YEAR = new Date().getFullYear();

const emptyForm: VehicleInput = { make: '', model: '', year: CURRENT_YEAR, color: '', plate: '', province: '' };

export function VehiclesManager({ initialVehicles }: { initialVehicles: Vehicle[] }) {
  const { lang } = useLanguage();
  const { showToast } = useToast();
  const [vehicles, setVehicles] = useState(initialVehicles);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(initialVehicles.length === 0);
  const [form, setForm] = useState<VehicleInput>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const t = {
    title: lang === 'fr' ? 'Mes véhicules' : 'My vehicles',
    sub:
      lang === 'fr'
        ? 'Le véhicule principal est présélectionné à chaque demande.'
        : 'Your primary vehicle is preselected on every request.',
    add: lang === 'fr' ? '+ Ajouter un véhicule' : '+ Add a vehicle',
    empty: lang === 'fr' ? "Aucun véhicule enregistré pour l'instant." : 'No vehicle saved yet.',
    make: lang === 'fr' ? 'Marque' : 'Make',
    model: lang === 'fr' ? 'Modèle' : 'Model',
    year: lang === 'fr' ? 'Année' : 'Year',
    color: lang === 'fr' ? 'Couleur (optionnel)' : 'Color (optional)',
    plate: lang === 'fr' ? 'Plaque (optionnel)' : 'Plate (optional)',
    province: lang === 'fr' ? 'Province (optionnel)' : 'Province (optional)',
    save: lang === 'fr' ? 'Enregistrer' : 'Save',
    cancel: lang === 'fr' ? 'Annuler' : 'Cancel',
    edit: lang === 'fr' ? 'Modifier' : 'Edit',
    remove: lang === 'fr' ? 'Supprimer' : 'Delete',
    makeMain: lang === 'fr' ? 'Définir principal' : 'Set as primary',
    primary: lang === 'fr' ? 'Principal' : 'Primary',
    back: lang === 'fr' ? '← Retour à la demande' : '← Back to request',
    error: lang === 'fr' ? 'Une erreur est survenue. Réessayez.' : 'Something went wrong. Please try again.',
    confirmDelete: lang === 'fr' ? 'Supprimer ce véhicule?' : 'Delete this vehicle?',
  };

  function startAdd() {
    setForm(emptyForm);
    setEditingId(null);
    setAdding(true);
  }

  function startEdit(v: Vehicle) {
    setForm({
      make: v.make,
      model: v.model,
      year: v.year,
      color: v.color ?? '',
      plate: v.plate ?? '',
      province: v.province ?? '',
    });
    setEditingId(v.id);
    setAdding(false);
  }

  function cancelForm() {
    setAdding(false);
    setEditingId(null);
    setForm(emptyForm);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.make.trim() || !form.model.trim() || !form.year) return;
    setSaving(true);
    try {
      if (editingId) {
        await updateVehicle(editingId, form);
        setVehicles((prev) => prev.map((v) => (v.id === editingId ? { ...v, ...form, color: form.color || null, plate: form.plate || null, province: form.province || null } : v)));
      } else {
        const created = await createVehicle(form);
        setVehicles((prev) => [created, ...(created.is_primary ? prev.map((v) => ({ ...v, is_primary: false })) : prev)]);
      }
      cancelForm();
    } catch {
      showToast('⚠️', t.error);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    if (!window.confirm(t.confirmDelete)) return;
    setBusyId(id);
    try {
      await deleteVehicle(id);
      setVehicles((prev) => {
        const wasPrimary = prev.find((v) => v.id === id)?.is_primary;
        const rest = prev.filter((v) => v.id !== id);
        if (wasPrimary && rest.length > 0) {
          rest[0] = { ...rest[0], is_primary: true };
        }
        return rest;
      });
    } catch {
      showToast('⚠️', t.error);
    } finally {
      setBusyId(null);
    }
  }

  async function handleSetPrimary(id: string) {
    setBusyId(id);
    try {
      await setPrimaryVehicle(id);
      setVehicles((prev) => prev.map((v) => ({ ...v, is_primary: v.id === id })));
    } catch {
      showToast('⚠️', t.error);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="max-w-2xl mx-auto px-6 py-8">
      <div className="flex justify-between items-start mb-6 flex-wrap gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold">{t.title}</h1>
          <p className="text-text-2 text-sm mt-1">{t.sub}</p>
        </div>
        <Link href="/request" className="text-sm text-orange font-medium">
          {t.back}
        </Link>
      </div>

      <div className="flex flex-col gap-3 mb-4">
        {vehicles.map((v) => (
          <Card key={v.id} className={v.is_primary ? 'border-orange' : ''}>
            {editingId === v.id ? (
              <VehicleForm form={form} setForm={setForm} onSubmit={handleSubmit} onCancel={cancelForm} saving={saving} t={t} />
            ) : (
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-display font-bold">
                      {v.year} {v.make} {v.model}
                    </span>
                    {v.is_primary ? <Badge tone="orange">⭐ {t.primary}</Badge> : null}
                  </div>
                  <p className="text-xs text-muted">
                    {[v.color, v.plate, v.province].filter(Boolean).join(' · ') || '—'}
                  </p>
                </div>
                <div className="flex gap-2 flex-wrap">
                  {!v.is_primary ? (
                    <Button
                      variant="secondary"
                      className="!px-3 !py-1.5 text-xs"
                      disabled={busyId === v.id}
                      onClick={() => handleSetPrimary(v.id)}
                    >
                      {t.makeMain}
                    </Button>
                  ) : null}
                  <Button variant="secondary" className="!px-3 !py-1.5 text-xs" onClick={() => startEdit(v)}>
                    {t.edit}
                  </Button>
                  <Button
                    variant="red"
                    className="!px-3 !py-1.5 text-xs"
                    disabled={busyId === v.id}
                    onClick={() => handleDelete(v.id)}
                  >
                    {t.remove}
                  </Button>
                </div>
              </div>
            )}
          </Card>
        ))}

        {vehicles.length === 0 && !adding ? (
          <Card>
            <p className="text-sm text-muted text-center py-2">{t.empty}</p>
          </Card>
        ) : null}
      </div>

      {adding ? (
        <Card orange>
          <VehicleForm form={form} setForm={setForm} onSubmit={handleSubmit} onCancel={cancelForm} saving={saving} t={t} showCancel={vehicles.length > 0} />
        </Card>
      ) : (
        <Button variant="secondary" full onClick={startAdd}>
          {t.add}
        </Button>
      )}
    </div>
  );
}

function VehicleForm({
  form,
  setForm,
  onSubmit,
  onCancel,
  saving,
  t,
  showCancel = true,
}: {
  form: VehicleInput;
  setForm: (f: VehicleInput) => void;
  onSubmit: (e: React.FormEvent) => void;
  onCancel: () => void;
  saving: boolean;
  t: Record<string, string>;
  showCancel?: boolean;
}) {
  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label>{t.make}</Label>
          <Input required value={form.make} onChange={(e) => setForm({ ...form, make: e.target.value })} />
        </div>
        <div>
          <Label>{t.model}</Label>
          <Input required value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} />
        </div>
      </div>
      <div>
        <Label>{t.year}</Label>
        <Input
          type="number"
          required
          min={1950}
          max={CURRENT_YEAR + 1}
          value={form.year}
          onChange={(e) => setForm({ ...form, year: Number(e.target.value) })}
        />
      </div>
      <div>
        <Label>{t.color}</Label>
        <Input value={form.color ?? ''} onChange={(e) => setForm({ ...form, color: e.target.value })} />
      </div>
      <div>
        <Label>{t.plate}</Label>
        <Input value={form.plate ?? ''} onChange={(e) => setForm({ ...form, plate: e.target.value })} />
      </div>
      <div>
        <Label>{t.province}</Label>
        <Select value={form.province ?? ''} onChange={(e) => setForm({ ...form, province: e.target.value })}>
          <option value="">—</option>
          {CANADIAN_PROVINCES.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </Select>
      </div>
      <div className="flex gap-2 mt-1">
        {showCancel ? (
          <Button type="button" variant="secondary" className="flex-1" onClick={onCancel}>
            {t.cancel}
          </Button>
        ) : null}
        <Button type="submit" className="flex-[2]" disabled={saving}>
          {t.save}
        </Button>
      </div>
    </form>
  );
}
