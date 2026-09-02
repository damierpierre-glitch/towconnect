'use client';

import { useEffect, useState } from 'react';
import { useLanguage } from '@/lib/i18n/LanguageProvider';
import { useToast } from '@/components/ToastProvider';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input, Label, Textarea } from '@/components/ui/Field';
import { geocodeAddress, reverseGeocode, type GeocodeResult } from '@/lib/mapbox';
import { createVehicle } from '@/lib/actions/vehicles';
import { problemRequiresDestination } from '@/lib/constants';
import { track } from '@/lib/analytics';
import { errorMessageKey } from '@/lib/errors';
import type { Vehicle } from '@/lib/supabase/types';
import { FALLBACK_CENTER, PROBLEM_TYPES, type RequestFormData } from './types';

const CURRENT_YEAR = new Date().getFullYear();

function vehicleLabel(v: Pick<Vehicle, 'year' | 'make' | 'model'>) {
  return `${v.year} ${v.make} ${v.model}`;
}

export function StepForm({
  vehicles,
  initial,
  onSubmit,
}: {
  vehicles: Vehicle[];
  /** What was filled in last time, when the rider came back from the estimate. */
  initial?: RequestFormData | null;
  onSubmit: (data: RequestFormData) => void;
}) {
  const { t, lang } = useLanguage();
  const { showToast } = useToast();
  const [problemKey, setProblemKey] = useState(initial?.problemKey ?? '');
  const [locationText, setLocationText] = useState(initial?.locationText ?? '');
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(
    initial ? { lat: initial.lat, lng: initial.lng } : null
  );
  const [notes, setNotes] = useState(initial?.notes ?? '');
  const [suggestions, setSuggestions] = useState<GeocodeResult[]>([]);
  const [detecting, setDetecting] = useState(false);
  const [locationError, setLocationError] = useState(false);
  const [editingLocation, setEditingLocation] = useState(false);

  const [destinationText, setDestinationText] = useState(initial?.destinationAddress ?? '');
  const [destinationCoords, setDestinationCoords] = useState<{ lat: number; lng: number } | null>(
    initial?.destinationLat != null && initial?.destinationLng != null
      ? { lat: initial.destinationLat, lng: initial.destinationLng }
      : null
  );
  const [destinationSuggestions, setDestinationSuggestions] = useState<GeocodeResult[]>([]);
  const needsDestination = problemRequiresDestination(problemKey);

  const [myVehicles, setMyVehicles] = useState(vehicles);
  const primary = myVehicles.find((v) => v.is_primary) ?? myVehicles[0] ?? null;
  const [selectedVehicleId, setSelectedVehicleId] = useState<string | null>(
    initial?.vehicleId ?? primary?.id ?? null
  );
  const [addingVehicle, setAddingVehicle] = useState(myVehicles.length === 0);
  const [quickVehicle, setQuickVehicle] = useState({ make: '', model: '', year: CURRENT_YEAR });
  const [savingVehicle, setSavingVehicle] = useState(false);

  // Auto-detect location on mount — reuses the browser Geolocation permission
  // already granted elsewhere in the app. Never blocks the form: on denial or
  // absence of support, the user just falls back to typing an address.
  useEffect(() => {
    // Nothing to detect if the rider already gave us a place — including on
    // the way back from the estimate. Re-detecting here would overwrite a
    // correction the rider just came back to make.
    if (initial) return;
    if (!navigator.geolocation) {
      // Deferred, not called synchronously in the effect body: same pattern
      // as LanguageProvider's mount-time localStorage read.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setLocationError(true);
      track('location_denied', { reason: 'unsupported' });
      return;
    }
    setDetecting(true);
    const startedAt = Date.now();
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const { latitude, longitude } = pos.coords;
        const label =
          (await reverseGeocode(latitude, longitude)) ?? `${latitude.toFixed(4)}, ${longitude.toFixed(4)}`;
        setCoords({ lat: latitude, lng: longitude });
        setLocationText(label);
        setDetecting(false);
        // How long it took matters: a location that arrives after fifteen
        // seconds is, to somebody at the roadside, a location that failed.
        track('location_obtained', { duration_ms: Date.now() - startedAt });
      },
      (err) => {
        setDetecting(false);
        setLocationError(true);
        track('location_denied', {
          reason: err.code === err.PERMISSION_DENIED ? 'denied' : 'unavailable',
          duration_ms: Date.now() - startedAt,
        });
      },
      { timeout: 8000 }
    );
    // Mount only. `initial` is read once to decide whether detection should
    // run at all; re-running on a change to it would fight the rider for the
    // location field, which is the exact bug this guard exists to prevent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleLocationChange(value: string) {
    setLocationText(value);
    setCoords(null);
    if (value.trim().length > 3) {
      const results = await geocodeAddress(value);
      setSuggestions(results);
    } else {
      setSuggestions([]);
    }
  }

  function pickSuggestion(s: GeocodeResult) {
    setLocationText(s.label);
    setCoords({ lat: s.lat, lng: s.lng });
    setSuggestions([]);
    setEditingLocation(false);
  }

  function detectLocation() {
    if (!navigator.geolocation) {
      showToast('📍', t('err_location_unavailable'));
      return;
    }
    setDetecting(true);
    setLocationError(false);
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const { latitude, longitude } = pos.coords;
        const label = (await reverseGeocode(latitude, longitude)) ?? `${latitude.toFixed(4)}, ${longitude.toFixed(4)}`;
        setCoords({ lat: latitude, lng: longitude });
        setLocationText(label);
        setDetecting(false);
        setEditingLocation(false);
      },
      (err) => {
        setDetecting(false);
        setLocationError(true);
        // A refused permission and a satellite fix that never arrived need
        // different sentences: one is fixed in browser settings, the other by
        // typing an address. Telling somebody the wrong one wastes the minute
        // they have least of.
        showToast('📍', t(errorMessageKey(err)));
      }
    );
  }

  async function handleAddVehicle(e: React.FormEvent) {
    e.preventDefault();
    if (!quickVehicle.make.trim() || !quickVehicle.model.trim() || !quickVehicle.year) return;
    setSavingVehicle(true);
    try {
      const created = await createVehicle(quickVehicle);
      setMyVehicles((prev) => [created, ...(created.is_primary ? prev.map((v) => ({ ...v, is_primary: false })) : prev)]);
      setSelectedVehicleId(created.id);
      setAddingVehicle(false);
      setQuickVehicle({ make: '', model: '', year: CURRENT_YEAR });
    } catch {
      showToast('⚠️', t('error_generic'));
    } finally {
      setSavingVehicle(false);
    }
  }

  async function handleDestinationChange(value: string) {
    setDestinationText(value);
    setDestinationCoords(null);
    if (value.trim().length > 3) {
      setDestinationSuggestions(await geocodeAddress(value));
    } else {
      setDestinationSuggestions([]);
    }
  }

  function pickDestinationSuggestion(s: GeocodeResult) {
    setDestinationText(s.label);
    setDestinationCoords({ lat: s.lat, lng: s.lng });
    setDestinationSuggestions([]);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const problem = PROBLEM_TYPES.find((p) => p.key === problemKey);
    if (!problem || !locationText.trim()) return;
    if (needsDestination && (!destinationText.trim() || !destinationCoords)) return;

    const finalCoords = coords ?? FALLBACK_CENTER;
    const selectedVehicle = myVehicles.find((v) => v.id === selectedVehicleId) ?? null;

    // The kind of problem and whether a destination was needed. Never the
    // address, never the vehicle, never the note.
    track('situation_selected', { problem_type: problem.key, has_destination: needsDestination });
    track('vehicle_selected', { vehicle_type: selectedVehicle ? 'saved' : 'none' });

    onSubmit({
      problemType: problem.key,
      problemKey: problem.key,
      locationText,
      lat: finalCoords.lat,
      lng: finalCoords.lng,
      vehicleDesc: selectedVehicle ? vehicleLabel(selectedVehicle) : '',
      vehicleId: selectedVehicle?.id ?? null,
      notes,
      destinationAddress: needsDestination ? destinationText : null,
      destinationLat: needsDestination ? (destinationCoords?.lat ?? null) : null,
      destinationLng: needsDestination ? (destinationCoords?.lng ?? null) : null,
    });
  }

  const canSubmit =
    Boolean(problemKey) &&
    locationText.trim().length > 0 &&
    (!needsDestination || (destinationText.trim().length > 0 && destinationCoords != null));

  return (
    <Card>
      <h3 className="font-display text-xl font-bold mb-1">{t('form_title')}</h3>
      <p className="text-sm text-text-2 mb-6">{t('form_sub')}</p>

      <form onSubmit={handleSubmit} className="flex flex-col gap-5">
        {/* Problem type — large touch targets, not a select, for a stressed
            roadside user tapping with cold/wet fingers. */}
        <div>
          {/* A group rather than a label: this is eight buttons, not one
              field, so the heading has to be announced as the group's name.
              And each button carries aria-pressed, because until Phase 10 the
              only thing distinguishing the chosen option was its colour —
              which a screen reader cannot see and a colour-blind user may not
              either. */}
          <div role="group" aria-labelledby="problem-type-label">
            <Label id="problem-type-label">{t('lbl_type')}</Label>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {PROBLEM_TYPES.map((p) => (
              <button
                key={p.key}
                type="button"
                aria-pressed={problemKey === p.key}
                onClick={() => setProblemKey(p.key)}
                className={`flex flex-col items-center justify-center gap-1 py-3.5 px-2 rounded-xl border text-xs font-medium text-center transition-colors ${
                  problemKey === p.key
                    ? 'border-orange bg-orange/10 text-orange'
                    : 'border-steel text-text-2 hover:border-orange/50'
                }`}
              >
                <span className="text-xl" aria-hidden="true">
                  {p.icon}
                </span>
                {lang === 'fr' ? p.fr : p.en}
              </button>
            ))}
            </div>
          </div>
        </div>

        {/* Location — auto-detected on load; editable, never blocking. */}
        <div className="relative">
          <Label htmlFor="pickup-location">{t('lbl_loc')}</Label>
          {!editingLocation && locationText && !detecting ? (
            <div className="flex items-center justify-between gap-2 px-3.5 py-3 bg-night-3 border border-steel rounded-xl">
              <span className="text-sm flex items-center gap-2">📍 {locationText}</span>
              <button
                type="button"
                onClick={() => setEditingLocation(true)}
                className="text-xs text-orange font-medium shrink-0"
              >
                {t('loc_edit')}
              </button>
            </div>
          ) : (
            <div className="flex gap-2">
              <Input
                id="pickup-location"
                required
                autoFocus={editingLocation}
                className="flex-1"
                placeholder={
                  detecting
                    ? t('loc_detecting')
                    : lang === 'fr'
                      ? 'Ex: A-40 Est, sortie 122, Montréal'
                      : 'e.g. Hwy 40 East, exit 122, Montreal'
                }
                value={locationText}
                onChange={(e) => handleLocationChange(e.target.value)}
              />
              {/* An emoji is not a name. Without this the button announces as
                  "round pushpin", or as nothing at all. */}
              <Button
                type="button"
                variant="secondary"
                onClick={detectLocation}
                disabled={detecting}
                aria-label={lang === 'fr' ? 'Détecter ma position' : 'Detect my location'}
              >
                <span aria-hidden="true">📍</span>
              </Button>
            </div>
          )}
          {locationError && !locationText ? (
            <p className="text-xs text-muted mt-1.5">{t('loc_denied')}</p>
          ) : null}
          {suggestions.length > 0 ? (
            <div className="absolute z-10 mt-1 w-full bg-night-3 border border-steel rounded-xl overflow-hidden shadow-xl">
              {suggestions.map((s) => (
                <button
                  key={`${s.lat}-${s.lng}`}
                  type="button"
                  onClick={() => pickSuggestion(s)}
                  className="block w-full text-left px-3.5 py-2.5 text-sm hover:bg-night-4"
                >
                  {s.label}
                </button>
              ))}
            </div>
          ) : null}
        </div>

        {/* Destination — only for towing-style problem types
            (problemRequiresDestination). Hidden entirely for on-site
            services, never shown as a dead/irrelevant step. */}
        {needsDestination ? (
          <div className="relative">
            <Label htmlFor="destination">{t('lbl_destination')}</Label>
            <p className="text-xs text-muted mb-2">{t('destination_hint')}</p>
            <div className="flex items-center gap-2 mb-1 text-xs text-muted">
              <span className="truncate">📍 {locationText || '—'}</span>
              <span>→</span>
            </div>
            <Input
              id="destination"
              required
              placeholder={lang === 'fr' ? 'Ex: Garage ABC, 123 rue Principale' : 'e.g. ABC Garage, 123 Main St'}
              value={destinationText}
              onChange={(e) => handleDestinationChange(e.target.value)}
            />
            {destinationSuggestions.length > 0 ? (
              <div className="absolute z-10 mt-1 w-full bg-night-3 border border-steel rounded-xl overflow-hidden shadow-xl">
                {destinationSuggestions.map((s) => (
                  <button
                    key={`${s.lat}-${s.lng}`}
                    type="button"
                    onClick={() => pickDestinationSuggestion(s)}
                    className="block w-full text-left px-3.5 py-2.5 text-sm hover:bg-night-4"
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}

        {/* Vehicle — primary preselected, chips to switch, quick add inline. */}
        <div>
          <Label>{t('lbl_vehicle')}</Label>
          {myVehicles.length > 0 && !addingVehicle ? (
            <div className="flex flex-wrap gap-2">
              {myVehicles.map((v) => (
                <button
                  key={v.id}
                  type="button"
                  onClick={() => setSelectedVehicleId(v.id)}
                  className={`px-3.5 py-2.5 rounded-xl border text-sm font-medium transition-colors ${
                    selectedVehicleId === v.id
                      ? 'border-orange bg-orange/10 text-orange'
                      : 'border-steel text-text-2 hover:border-orange/50'
                  }`}
                >
                  🚗 {vehicleLabel(v)}
                </button>
              ))}
              <button
                type="button"
                onClick={() => setAddingVehicle(true)}
                className="px-3.5 py-2.5 rounded-xl border border-dashed border-steel text-sm text-muted hover:border-orange hover:text-orange"
              >
                {t('veh_add_quick')}
              </button>
            </div>
          ) : (
            <div className="bg-night-3 border border-steel rounded-xl p-4">
              <p className="text-xs text-muted mb-3">{t('veh_none_yet')}</p>
              <div className="grid grid-cols-2 gap-2 mb-2">
                <Input
                  placeholder={lang === 'fr' ? 'Marque' : 'Make'}
                  value={quickVehicle.make}
                  onChange={(e) => setQuickVehicle({ ...quickVehicle, make: e.target.value })}
                />
                <Input
                  placeholder={lang === 'fr' ? 'Modèle' : 'Model'}
                  value={quickVehicle.model}
                  onChange={(e) => setQuickVehicle({ ...quickVehicle, model: e.target.value })}
                />
              </div>
              <div className="flex gap-2">
                <Input
                  type="number"
                  className="w-28"
                  min={1950}
                  max={CURRENT_YEAR + 1}
                  value={quickVehicle.year}
                  onChange={(e) => setQuickVehicle({ ...quickVehicle, year: Number(e.target.value) })}
                />
                <Button type="button" className="flex-1" disabled={savingVehicle} onClick={handleAddVehicle}>
                  {savingVehicle ? '…' : lang === 'fr' ? 'Ajouter' : 'Add'}
                </Button>
                {myVehicles.length > 0 ? (
                  <Button type="button" variant="secondary" onClick={() => setAddingVehicle(false)}>
                    {lang === 'fr' ? 'Annuler' : 'Cancel'}
                  </Button>
                ) : null}
              </div>
            </div>
          )}
        </div>

        <div>
          <Label>{t('lbl_notes')}</Label>
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>

        <Button type="submit" full size="lg" className="mt-1" disabled={!canSubmit}>
          🔍 {t('btn_find')}
        </Button>
      </form>
    </Card>
  );
}
