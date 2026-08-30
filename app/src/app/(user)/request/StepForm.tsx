'use client';

import { useState } from 'react';
import { useLanguage } from '@/lib/i18n/LanguageProvider';
import { useToast } from '@/components/ToastProvider';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input, Label, Select, Textarea } from '@/components/ui/Field';
import { geocodeAddress, reverseGeocode, type GeocodeResult } from '@/lib/mapbox';
import { FALLBACK_CENTER, PROBLEM_TYPES, type RequestFormData } from './types';

export function StepForm({ onSubmit }: { onSubmit: (data: RequestFormData) => void }) {
  const { t, lang } = useLanguage();
  const { showToast } = useToast();
  const [problemKey, setProblemKey] = useState('');
  const [locationText, setLocationText] = useState('');
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [vehicleDesc, setVehicleDesc] = useState('');
  const [notes, setNotes] = useState('');
  const [suggestions, setSuggestions] = useState<GeocodeResult[]>([]);
  const [detecting, setDetecting] = useState(false);

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
  }

  function detectLocation() {
    if (!navigator.geolocation) {
      showToast('⚠️', t('error_generic'));
      return;
    }
    setDetecting(true);
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const { latitude, longitude } = pos.coords;
        const label = (await reverseGeocode(latitude, longitude)) ?? `${latitude.toFixed(4)}, ${longitude.toFixed(4)}`;
        setCoords({ lat: latitude, lng: longitude });
        setLocationText(label);
        setDetecting(false);
      },
      () => {
        setDetecting(false);
        showToast('⚠️', t('error_generic'));
      }
    );
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const problem = PROBLEM_TYPES.find((p) => p.key === problemKey);
    if (!problem || !locationText.trim()) return;

    const finalCoords = coords ?? FALLBACK_CENTER;
    onSubmit({
      problemType: problem.key,
      problemKey: problem.key,
      locationText,
      lat: finalCoords.lat,
      lng: finalCoords.lng,
      vehicleDesc,
      notes,
    });
  }

  return (
    <Card>
      <h3 className="font-display text-xl font-bold mb-1">{t('form_title')}</h3>
      <p className="text-sm text-text-2 mb-6">{t('form_sub')}</p>

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <div>
          <Label>{t('lbl_type')}</Label>
          <Select required value={problemKey} onChange={(e) => setProblemKey(e.target.value)}>
            <option value="">-- {lang === 'fr' ? 'Choisir' : 'Select'} --</option>
            {PROBLEM_TYPES.map((p) => (
              <option key={p.key} value={p.key}>
                {p.icon} {lang === 'fr' ? p.fr : p.en}
              </option>
            ))}
          </Select>
        </div>

        <div className="relative">
          <Label>{t('lbl_loc')}</Label>
          <div className="flex gap-2">
            <Input
              required
              className="flex-1"
              placeholder={lang === 'fr' ? 'Ex: A-40 Est, sortie 122, Montréal' : 'e.g. Hwy 40 East, exit 122, Montreal'}
              value={locationText}
              onChange={(e) => handleLocationChange(e.target.value)}
            />
            <Button type="button" variant="secondary" onClick={detectLocation} disabled={detecting}>
              📍
            </Button>
          </div>
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

        <div>
          <Label>{t('lbl_vehicle')}</Label>
          <Input
            placeholder={lang === 'fr' ? 'Ex: Honda Civic 2019 rouge' : 'e.g. 2019 red Honda Civic'}
            value={vehicleDesc}
            onChange={(e) => setVehicleDesc(e.target.value)}
          />
        </div>

        <div>
          <Label>{t('lbl_notes')}</Label>
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>

        <Button type="submit" full size="lg" className="mt-2">
          🔍 {t('btn_find')}
        </Button>
      </form>
    </Card>
  );
}
