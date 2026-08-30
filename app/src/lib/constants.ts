export const PROBLEM_TYPES: { key: string; icon: string; fr: string; en: string }[] = [
  { key: 'battery', icon: '🔋', fr: 'Batterie à plat', en: 'Dead battery' },
  { key: 'out_of_gas', icon: '⛽', fr: 'Panne sèche', en: 'Out of gas' },
  { key: 'mechanical', icon: '🔧', fr: 'Panne mécanique', en: 'Breakdown' },
  { key: 'accident', icon: '🚗', fr: 'Accident', en: 'Accident' },
  { key: 'lockout', icon: '🔑', fr: 'Clés enfermées', en: 'Keys locked in' },
  { key: 'flat_tire', icon: '🛞', fr: 'Crevaison', en: 'Flat tire' },
  { key: 'stuck_snow', icon: '❄️', fr: 'Pris dans la neige', en: 'Stuck in snow' },
  { key: 'other', icon: '❓', fr: 'Autre', en: 'Other' },
];

export function problemLabel(key: string, lang: 'fr' | 'en') {
  const p = PROBLEM_TYPES.find((p) => p.key === key);
  if (!p) return key;
  return `${p.icon} ${lang === 'fr' ? p.fr : p.en}`;
}

export const VEHICLE_TYPE_LABEL: Record<string, string> = {
  standard: 'Standard',
  flatbed: 'Flatbed',
  heavy_duty: 'Heavy Duty',
};

// Fallback center (downtown Montreal) used when Mapbox geocoding isn't
// configured, so the demo still works end-to-end without an API key.
export const FALLBACK_CENTER = { lat: 45.5019, lng: -73.5674 };

export const CANADIAN_PROVINCES = [
  'QC',
  'ON',
  'BC',
  'AB',
  'MB',
  'SK',
  'NS',
  'NB',
  'NL',
  'PE',
  'YT',
  'NT',
  'NU',
];
