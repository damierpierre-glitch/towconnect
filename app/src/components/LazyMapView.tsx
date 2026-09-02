'use client';

import dynamic from 'next/dynamic';
import type { MapMarker } from './MapView';

// The map, loaded when a map is actually shown.
//
// MEASURED, NOT GUESSED
// mapbox-gl is a 490 kB gzipped chunk — by far the largest thing this
// application ships, bigger than everything else put together. Imported
// statically by StepEstimate, it was part of the FIRST screen of /request:
// somebody stranded at the roadside downloaded half a megabyte of mapping
// engine while filling in "flat battery", on the phone signal they happen to
// have, before any map existed on screen.
//
// Splitting it out does not make the map faster. It makes the two screens
// that do not need it — the situation form, and a driver dashboard with no
// active job — stop paying for it.
//
// ssr: false because mapbox-gl touches `window` on import.
export const MapView = dynamic(() => import('./MapView').then((m) => m.MapView), {
  ssr: false,
  // A sized placeholder, so the page does not reflow when the map arrives.
  // Height comes from the caller's className, exactly as the real map's does.
  loading: () => <div className="bg-night-3 border border-night-4 rounded-xl animate-pulse h-full w-full" />,
});

export type { MapMarker };
