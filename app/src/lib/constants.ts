// `requiresDestination`: whether this service typically tows the vehicle
// somewhere (destination required) vs. is resolved on site (no destination
// step). Only 'mechanical' (can't be fixed roadside) and 'accident'
// (vehicle usually isn't driveable) actually need a destination — the rest
// are the on-site services named explicitly in the Phase 4 brief (battery,
// lockout, flat tire, out of gas) plus 'stuck_snow' (on-site extraction) and
// 'other' (kept minimal/ambiguous on purpose, no destination step forced).
export const PROBLEM_TYPES: { key: string; icon: string; fr: string; en: string; requiresDestination: boolean }[] = [
  { key: 'battery', icon: '🔋', fr: 'Batterie à plat', en: 'Dead battery', requiresDestination: false },
  { key: 'out_of_gas', icon: '⛽', fr: 'Panne sèche', en: 'Out of gas', requiresDestination: false },
  { key: 'mechanical', icon: '🔧', fr: 'Panne mécanique', en: 'Breakdown', requiresDestination: true },
  { key: 'accident', icon: '🚗', fr: 'Accident', en: 'Accident', requiresDestination: true },
  { key: 'lockout', icon: '🔑', fr: 'Clés enfermées', en: 'Keys locked in', requiresDestination: false },
  { key: 'flat_tire', icon: '🛞', fr: 'Crevaison', en: 'Flat tire', requiresDestination: false },
  { key: 'stuck_snow', icon: '❄️', fr: 'Pris dans la neige', en: 'Stuck in snow', requiresDestination: false },
  { key: 'other', icon: '❓', fr: 'Autre', en: 'Other', requiresDestination: false },
];

export function problemLabel(key: string, lang: 'fr' | 'en') {
  const p = PROBLEM_TYPES.find((p) => p.key === key);
  if (!p) return key;
  return `${p.icon} ${lang === 'fr' ? p.fr : p.en}`;
}

export function problemRequiresDestination(key: string): boolean {
  return PROBLEM_TYPES.find((p) => p.key === key)?.requiresDestination ?? false;
}

export const VEHICLE_TYPE_LABEL: Record<string, string> = {
  standard: 'Standard',
  flatbed: 'Flatbed',
  heavy_duty: 'Heavy Duty',
};

// Document types a driver's application can be verified against. Kept short
// on purpose — these are the ones a Canadian tow operator's paperwork
// actually breaks down into; 'other' covers anything province-specific
// without needing a new enum value for every province's quirk.
export const DRIVER_DOCUMENT_TYPES: { key: import('./supabase/types').DriverDocumentType; icon: string; fr: string; en: string }[] = [
  { key: 'license', icon: '🪪', fr: 'Permis de conduire', en: "Driver's license" },
  { key: 'insurance', icon: '🛡️', fr: 'Assurance', en: 'Insurance' },
  { key: 'registration', icon: '📋', fr: 'Immatriculation', en: 'Registration' },
  { key: 'other', icon: '📄', fr: 'Autre document', en: 'Other document' },
];

export function driverDocumentLabel(type: string, lang: 'fr' | 'en') {
  const d = DRIVER_DOCUMENT_TYPES.find((d) => d.key === type);
  if (!d) return type;
  return `${d.icon} ${lang === 'fr' ? d.fr : d.en}`;
}

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

export interface QuickMessage {
  key: string;
  fr: string;
  en: string;
}

// Kept short on purpose (5-8 per role) — a stressed roadside user should be
// able to scan every option at a glance, not hunt through a long list.
export const CLIENT_QUICK_MESSAGES: QuickMessage[] = [
  { key: 'near_vehicle', fr: 'Je suis près du véhicule', en: 'I am near the vehicle' },
  { key: 'hazards_on', fr: 'Feux de détresse allumés', en: 'Hazard lights on' },
  { key: 'in_parking', fr: 'Je suis dans le stationnement', en: 'I am in the parking lot' },
  { key: 'i_see_you', fr: 'Je vous vois', en: 'I can see you' },
  { key: 'coming_to_vehicle', fr: "J'arrive au véhicule", en: 'Heading to the vehicle' },
  { key: 'thanks', fr: 'Merci', en: 'Thank you' },
];

export const DRIVER_QUICK_MESSAGES: QuickMessage[] = [
  { key: 'on_my_way', fr: 'Je suis en route', en: 'On my way' },
  { key: 'few_minutes', fr: "J'arrive dans quelques minutes", en: 'Arriving in a few minutes' },
  { key: 'driver_arrived', fr: 'Je suis arrivé', en: 'I have arrived' },
  { key: 'confirm_position', fr: 'Pouvez-vous confirmer votre position?', en: 'Can you confirm your location?' },
  { key: 'cant_see_you', fr: 'Je ne vous vois pas', en: "I can't see you" },
  { key: 'service_started', fr: 'Intervention commencée', en: 'Service started' },
  { key: 'heading_to_destination', fr: 'Nous sommes en route vers la destination', en: 'We are on our way to the destination' },
];

// One merged, key-unique lookup so a message can be resolved to display text
// without needing to know whether its sender was the rider or the driver.
const ALL_QUICK_MESSAGES = [...CLIENT_QUICK_MESSAGES, ...DRIVER_QUICK_MESSAGES];

export function resolveMessageText(
  message: { body: string | null; template_key: string | null },
  lang: 'fr' | 'en'
): string {
  if (message.body) return message.body;
  const template = ALL_QUICK_MESSAGES.find((m) => m.key === message.template_key);
  if (!template) return message.template_key ?? '';
  return lang === 'fr' ? template.fr : template.en;
}
