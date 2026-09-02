'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import { useLanguage } from '@/lib/i18n/LanguageProvider';
import { MAPBOX_TOKEN } from '@/lib/mapbox';
import { Card } from '@/components/ui/Card';
import { getLiveMap } from '@/lib/actions/operations';
import { OperationsNav, type Capabilities } from '../OperationsNav';
import type { LiveMapEntity } from '@/lib/supabase/types';

// The live operations map.
//
// TWO THINGS IT REFUSES TO DO
//  * Show anything that is not in the database. An empty map means nothing is
//    happening in that rectangle, which is information — filling it with
//    plausible dots would destroy the only thing the screen is for.
//  * Ask for the whole planet. The query is bounded by what is on screen
//    (ops_live_map takes bounds, they are not optional), and points are
//    clustered by Mapbox itself, so a busy night does not become a browser
//    that stops responding.

const STATE_COLOR: Record<string, string> = {
  // Drivers
  available: '#22c55e',
  on_job: '#3b82f6',
  stale: '#f59e0b',
  // Requests
  pending: '#f97316',
  searching: '#eab308',
  matched: '#3b82f6',
  en_route: '#6366f1',
  arrived: '#8b5cf6',
  in_progress: '#a855f7',
  restricted_capacity_wait: '#ef4444',
  awaiting_external_authority: '#ef4444',
};

const STATE_LABEL: Record<string, { fr: string; en: string }> = {
  available: { fr: 'Chauffeur disponible', en: 'Driver available' },
  on_job: { fr: 'Chauffeur en mission', en: 'Driver on a job' },
  stale: { fr: 'Chauffeur silencieux', en: 'Driver gone quiet' },
  pending: { fr: 'En attente', en: 'Pending' },
  searching: { fr: 'Recherche en cours', en: 'Searching' },
  matched: { fr: 'Assignée', en: 'Matched' },
  en_route: { fr: 'En route', en: 'En route' },
  arrived: { fr: 'Sur place', en: 'Arrived' },
  in_progress: { fr: 'Intervention', en: 'In progress' },
  restricted_capacity_wait: { fr: 'Attente zone réglementée', en: 'Regulated capacity wait' },
  awaiting_external_authority: { fr: 'Autorité externe', en: 'External authority' },
};

const MONTREAL: [number, number] = [-73.5674, 45.5019];

export function LiveOperationsMap({ capabilities }: { capabilities: Capabilities }) {
  const { lang } = useLanguage();
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const [entities, setEntities] = useState<LiveMapEntity[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [lastLoaded, setLastLoaded] = useState<string | null>(null);

  const load = useCallback(async (map: mapboxgl.Map) => {
    const bounds = map.getBounds();
    if (!bounds) return;
    setLoading(true);
    try {
      const rows = await getLiveMap({
        minLat: bounds.getSouth(),
        minLng: bounds.getWest(),
        maxLat: bounds.getNorth(),
        maxLng: bounds.getEast(),
      });
      setEntities(rows);
      setLastLoaded(new Date().toISOString().slice(11, 19));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the map');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!MAPBOX_TOKEN || !containerRef.current || mapRef.current) return;
    mapboxgl.accessToken = MAPBOX_TOKEN;
    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: 'mapbox://styles/mapbox/dark-v11',
      center: MONTREAL,
      zoom: 10,
    });
    mapRef.current = map;
    map.addControl(new mapboxgl.NavigationControl(), 'top-right');

    // Reload on move rather than on a timer: a map nobody is looking at does
    // not need to keep asking, and a map being panned needs to answer.
    map.on('load', () => void load(map));
    map.on('moveend', () => void load(map));

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, [load]);

  // A modest refresh, not a socket. Positions matter to the minute here;
  // realtime is reserved for the screens where a second matters.
  useEffect(() => {
    const id = setInterval(() => {
      if (mapRef.current) void load(mapRef.current);
    }, 20_000);
    return () => clearInterval(id);
  }, [load]);

  const geojson = useMemo(
    () => ({
      type: 'FeatureCollection' as const,
      features: entities.map((e) => ({
        type: 'Feature' as const,
        properties: {
          entity: e.entity,
          state: e.state,
          label: e.label,
          color: STATE_COLOR[e.state] ?? '#94a3b8',
        },
        geometry: { type: 'Point' as const, coordinates: [e.lng, e.lat] },
      })),
    }),
    [entities]
  );

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;

    const source = map.getSource('ops') as mapboxgl.GeoJSONSource | undefined;
    if (source) {
      source.setData(geojson);
      return;
    }

    map.addSource('ops', {
      type: 'geojson',
      data: geojson,
      cluster: true,
      clusterRadius: 45,
      clusterMaxZoom: 13,
    });

    map.addLayer({
      id: 'ops-clusters',
      type: 'circle',
      source: 'ops',
      filter: ['has', 'point_count'],
      paint: {
        'circle-color': '#1f2937',
        'circle-stroke-color': '#f97316',
        'circle-stroke-width': 2,
        'circle-radius': ['step', ['get', 'point_count'], 16, 10, 22, 50, 30],
      },
    });
    map.addLayer({
      id: 'ops-cluster-count',
      type: 'symbol',
      source: 'ops',
      filter: ['has', 'point_count'],
      layout: { 'text-field': ['get', 'point_count_abbreviated'], 'text-size': 12 },
      paint: { 'text-color': '#ffffff' },
    });
    map.addLayer({
      id: 'ops-points',
      type: 'circle',
      source: 'ops',
      filter: ['!', ['has', 'point_count']],
      paint: {
        'circle-color': ['get', 'color'],
        'circle-radius': ['case', ['==', ['get', 'entity'], 'request'], 8, 6],
        'circle-stroke-color': '#0b1220',
        'circle-stroke-width': 2,
      },
    });

    map.on('click', 'ops-points', (event) => {
      const feature = event.features?.[0];
      if (!feature) return;
      const props = feature.properties as { label: string; state: string; entity: string };
      new mapboxgl.Popup()
        .setLngLat(event.lngLat)
        .setHTML(
          `<div style="font-family:system-ui;font-size:12px"><strong>${props.label}</strong><br/>${
            STATE_LABEL[props.state]?.[lang === 'fr' ? 'fr' : 'en'] ?? props.state
          }</div>`
        )
        .addTo(map);
    });
  }, [geojson, lang]);

  const drivers = entities.filter((e) => e.entity === 'driver');
  const requests = entities.filter((e) => e.entity === 'request');
  const statesPresent = Array.from(new Set(entities.map((e) => e.state)));

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8">
      <header className="mb-5">
        <h1 className="font-display text-2xl font-bold">
          {lang === 'fr' ? 'Carte opérationnelle' : 'Live operations map'}
        </h1>
        <p className="text-sm text-muted mt-1">
          {lang === 'fr'
            ? 'Chauffeurs en ligne et interventions réelles dans le cadre affiché. Une carte vide signifie qu’il ne se passe rien ici.'
            : 'Real online drivers and real jobs inside the visible frame. An empty map means nothing is happening here.'}
        </p>
      </header>

      <OperationsNav capabilities={capabilities} />

      {!MAPBOX_TOKEN ? (
        <Card>
          <p className="text-sm text-text-2">
            {lang === 'fr'
              ? "NEXT_PUBLIC_MAPBOX_TOKEN n'est pas configuré sur cet environnement — la carte ne peut pas s'afficher."
              : 'NEXT_PUBLIC_MAPBOX_TOKEN is not configured in this environment, so the map cannot render.'}
          </p>
        </Card>
      ) : (
        <>
          <Card className="mb-4 !p-0 overflow-hidden">
            <div ref={containerRef} className="w-full h-[460px] sm:h-[560px]" />
          </Card>

          <div className="flex items-center justify-between gap-3 flex-wrap mb-4">
            <div className="flex gap-2 flex-wrap">
              {statesPresent.map((state) => (
                <span key={state} className="inline-flex items-center gap-1.5 text-xs text-text-2">
                  <span
                    className="w-2.5 h-2.5 rounded-full"
                    style={{ backgroundColor: STATE_COLOR[state] ?? '#94a3b8' }}
                  />
                  {STATE_LABEL[state]?.[lang === 'fr' ? 'fr' : 'en'] ?? state}
                </span>
              ))}
              {statesPresent.length === 0 ? (
                <span className="text-xs text-muted">
                  {lang === 'fr' ? 'Aucun élément dans ce cadre.' : 'Nothing in this frame.'}
                </span>
              ) : null}
            </div>
            <span className="text-xs text-muted">
              {drivers.length} {lang === 'fr' ? 'chauffeur(s)' : 'driver(s)'} · {requests.length}{' '}
              {lang === 'fr' ? 'intervention(s)' : 'job(s)'}
              {lastLoaded ? ` · ${lastLoaded}` : ''}
              {loading ? ' · …' : ''}
            </span>
          </div>

          {error ? <p className="text-xs text-red">{error}</p> : null}
        </>
      )}
    </div>
  );
}
