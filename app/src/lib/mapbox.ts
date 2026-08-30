export const MAPBOX_TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN ?? '';

export interface GeocodeResult {
  label: string;
  lat: number;
  lng: number;
}

// Forward geocoding via Mapbox's Geocoding API, biased to Canada.
export async function geocodeAddress(query: string): Promise<GeocodeResult[]> {
  if (!MAPBOX_TOKEN || !query.trim()) return [];

  const url = new URL(
    `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json`
  );
  url.searchParams.set('access_token', MAPBOX_TOKEN);
  url.searchParams.set('country', 'ca');
  url.searchParams.set('limit', '5');

  const res = await fetch(url.toString());
  if (!res.ok) return [];
  const data = await res.json();

  return (data.features ?? []).map((f: { place_name: string; center: [number, number] }) => ({
    label: f.place_name,
    lat: f.center[1],
    lng: f.center[0],
  }));
}

export async function reverseGeocode(lat: number, lng: number): Promise<string | null> {
  if (!MAPBOX_TOKEN) return null;

  const url = new URL(`https://api.mapbox.com/geocoding/v5/mapbox.places/${lng},${lat}.json`);
  url.searchParams.set('access_token', MAPBOX_TOKEN);
  url.searchParams.set('limit', '1');

  const res = await fetch(url.toString());
  if (!res.ok) return null;
  const data = await res.json();
  return data.features?.[0]?.place_name ?? null;
}
