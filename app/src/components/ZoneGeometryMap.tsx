'use client';

import { useEffect, useRef, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import { createClient } from '@/lib/supabase/client';
import { MAPBOX_TOKEN } from '@/lib/mapbox';
import { useLanguage } from '@/lib/i18n/LanguageProvider';

interface ZoneFeature {
  type: 'Feature';
  properties: { zone_code: string | null; active: boolean; geometry_confidence: string };
  geometry: GeoJSON.Geometry;
  bbox: [number, number, number, number];
}

// Draws one regulated zone's boundary so it can be checked against the
// official limits before anyone trusts it.
//
// A derived geometry is a claim about where the law applies, and a claim you
// cannot look at is a claim nobody checks. This is why the admin screen has a
// map at all: the numbers next to it (source, confidence, verification date)
// say where the boundary came from; only the picture says whether it followed
// the right stretch of highway.
export function ZoneGeometryMap({ zoneId, active }: { zoneId: string; active: boolean }) {
  const { lang } = useLanguage();
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const [feature, setFeature] = useState<ZoneFeature | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const supabase = createClient();
      const { data, error: rpcError } = await supabase.rpc('regulated_zone_geojson' as never, {
        p_zone_id: zoneId,
      } as never);
      if (cancelled) return;
      if (rpcError || !data) {
        setError(rpcError?.message ?? 'no geometry');
        return;
      }
      setFeature(data as unknown as ZoneFeature);
    })();
    return () => {
      cancelled = true;
    };
  }, [zoneId]);

  useEffect(() => {
    if (!containerRef.current || !feature || mapRef.current || !MAPBOX_TOKEN) return;

    const [minX, minY, maxX, maxY] = feature.bbox;
    mapboxgl.accessToken = MAPBOX_TOKEN;
    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: 'mapbox://styles/mapbox/dark-v11',
      bounds: [
        [minX, minY],
        [maxX, maxY],
      ],
      fitBoundsOptions: { padding: 24 },
    });
    mapRef.current = map;
    map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), 'top-right');

    map.on('load', () => {
      map.addSource('zone', { type: 'geojson', data: feature as unknown as GeoJSON.Feature });
      // Amber, not the brand orange: this is a legal restriction being
      // inspected, not a TowConnect surface.
      map.addLayer({
        id: 'zone-fill',
        type: 'fill',
        source: 'zone',
        paint: { 'fill-color': '#f59e0b', 'fill-opacity': active ? 0.35 : 0.18 },
      });
      map.addLayer({
        id: 'zone-line',
        type: 'line',
        source: 'zone',
        paint: { 'line-color': '#f59e0b', 'line-width': 1.5 },
      });
    });

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, [feature, active]);

  if (!MAPBOX_TOKEN) {
    return (
      <p className="text-xs text-muted">
        {lang === 'fr'
          ? 'Carte indisponible : aucun jeton Mapbox configuré.'
          : 'Map unavailable: no Mapbox token configured.'}
      </p>
    );
  }

  if (error) {
    return (
      <p className="text-xs text-muted">
        {lang === 'fr' ? 'Aucune géométrie à afficher.' : 'No geometry to display.'}
      </p>
    );
  }

  return (
    <div>
      <div ref={containerRef} className="h-64 rounded-xl overflow-hidden border border-night-4" />
      {feature ? (
        <p className="text-[11px] text-muted mt-1.5">
          {lang === 'fr'
            ? 'Limite dérivée, affichée pour inspection. Elle n’est pas une limite officielle publiée.'
            : 'Derived boundary, shown for inspection. It is not a published official boundary.'}
        </p>
      ) : null}
    </div>
  );
}
