// Transparent pricing formula — shown to the user before they confirm a
// request, unlike competitors who often only reveal the final price on the
// invoice. Tune these constants as real-world data comes in.

const BASE_FARE = 45;
const PER_KM = 2.25;
const PROBLEM_SURCHARGE: Record<string, number> = {
  accident: 30,
  heavy_duty: 25,
  stuck_snow: 15,
};

export function estimatePrice(distanceKm: number, problemType: string): number {
  const surcharge = PROBLEM_SURCHARGE[problemType] ?? 0;
  const price = BASE_FARE + distanceKm * PER_KM + surcharge;
  return Math.round(price * 100) / 100;
}

export interface PriceBreakdown {
  base: number;
  distance: number;
  surcharge: number;
  total: number;
}

// Same formula as estimatePrice(), split into the line items a transparent
// receipt needs (Phase 4). For a towing job, `towDistanceKm` (pickup ->
// destination — the actual service delivered) is billed at the same
// per-km rate as the driver's approach distance: one rate, added onto the
// total billable distance, rather than two different rates. Simpler and
// consistent with "no opaque pricing"; revisit only if the business decides
// towing distance should be priced differently from positioning distance.
export function estimatePriceBreakdown(input: {
  driverDistanceKm: number;
  towDistanceKm?: number;
  problemType: string;
}): PriceBreakdown {
  const surcharge = PROBLEM_SURCHARGE[input.problemType] ?? 0;
  const billableKm = input.driverDistanceKm + (input.towDistanceKm ?? 0);
  const distance = Math.round(billableKm * PER_KM * 100) / 100;
  const base = Math.round(BASE_FARE * 100) / 100;
  const total = Math.round((base + distance + surcharge) * 100) / 100;
  return { base, distance, surcharge, total };
}

// Postgres `numeric` columns (used for price_estimate — money is never stored
// as float) come back from PostgREST as JSON strings to avoid precision loss.
// Every display/arithmetic site must parse through this before using the
// value as a number.
export function toMoney(value: number | string | null | undefined): number {
  if (value == null) return 0;
  const n = typeof value === 'number' ? value : parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

// Haversine distance in kilometres between two lat/lng points.
export function distanceKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const R = 6371;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function toRad(deg: number) {
  return (deg * Math.PI) / 180;
}

// Very rough average tow-truck speed used to turn distance into an ETA.
export function estimateEtaMinutes(distanceKm: number) {
  const avgSpeedKmh = 45;
  return Math.max(3, Math.round((distanceKm / avgSpeedKmh) * 60));
}
