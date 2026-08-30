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
