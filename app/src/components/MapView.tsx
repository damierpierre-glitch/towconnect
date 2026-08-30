'use client';

import { useEffect, useRef } from 'react';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import { MAPBOX_TOKEN } from '@/lib/mapbox';

export interface MapMarker {
  id: string;
  lat: number;
  lng: number;
  color?: string;
  label?: string;
}

interface MapViewProps {
  center: { lat: number; lng: number };
  markers?: MapMarker[];
  zoom?: number;
  className?: string;
}

export function MapView({ center, markers = [], zoom = 12, className = '' }: MapViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const markersRef = useRef<Map<string, mapboxgl.Marker>>(new Map());

  useEffect(() => {
    if (!containerRef.current || mapRef.current || !MAPBOX_TOKEN) return;

    mapboxgl.accessToken = MAPBOX_TOKEN;
    mapRef.current = new mapboxgl.Map({
      container: containerRef.current,
      style: 'mapbox://styles/mapbox/dark-v11',
      center: [center.lng, center.lat],
      zoom,
    });
    mapRef.current.addControl(new mapboxgl.NavigationControl({ showCompass: false }), 'top-right');

    return () => {
      mapRef.current?.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    mapRef.current?.easeTo({ center: [center.lng, center.lat], duration: 600 });
  }, [center.lat, center.lng]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const seen = new Set<string>();
    for (const m of markers) {
      seen.add(m.id);
      let marker = markersRef.current.get(m.id);
      if (!marker) {
        const el = document.createElement('div');
        el.style.width = '16px';
        el.style.height = '16px';
        el.style.borderRadius = '50%';
        el.style.border = '2px solid white';
        el.style.boxShadow = '0 0 0 4px rgba(0,0,0,0.15)';
        marker = new mapboxgl.Marker({ element: el }).setLngLat([m.lng, m.lat]).addTo(map);
        markersRef.current.set(m.id, marker);
      } else {
        marker.setLngLat([m.lng, m.lat]);
      }
      (marker.getElement() as HTMLDivElement).style.background = m.color ?? '#ff5c1a';
    }

    for (const [id, marker] of markersRef.current) {
      if (!seen.has(id)) {
        marker.remove();
        markersRef.current.delete(id);
      }
    }
  }, [markers]);

  if (!MAPBOX_TOKEN) {
    return (
      <div
        className={`bg-night-3 border border-steel rounded-[20px] flex flex-col items-center justify-center gap-2 text-center px-6 ${className}`}
      >
        <span className="text-3xl">🗺️</span>
        <p className="text-sm text-muted">
          Configure NEXT_PUBLIC_MAPBOX_TOKEN to display the live map.
        </p>
      </div>
    );
  }

  return <div ref={containerRef} className={`rounded-[20px] overflow-hidden ${className}`} />;
}
