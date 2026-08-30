import { Badge } from '@/components/ui/Badge';

// Deliberately no lat/lng here: the nearby-drivers search returns a
// server-computed distance only (see nearby_drivers() in
// supabase/migrations/0002_hardening.sql) — a driver's exact position is
// never sent to the browser before a rider has an active job with them.
export interface NearbyDriver {
  profileId: string;
  name: string;
  rating: number;
  totalServices: number;
  vehicleType: string;
  distanceKm: number;
  etaMinutes: number;
  price: number;
}

export function DriverCard({
  driver,
  selected,
  onSelect,
}: {
  driver: NearbyDriver;
  selected: boolean;
  onSelect: () => void;
}) {
  const initials = driver.name
    .split(' ')
    .map((p) => p[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full flex items-center justify-between gap-3 bg-night-3 border rounded-xl p-4 text-left transition-colors ${
        selected ? 'border-orange bg-orange/5' : 'border-steel hover:border-orange'
      }`}
    >
      <div className="flex items-center gap-3">
        <div className="w-11 h-11 rounded-full bg-orange flex items-center justify-center font-display font-bold text-white">
          {initials}
        </div>
        <div>
          <div className="font-semibold text-sm">{driver.name}</div>
          <div className="text-xs text-muted mt-0.5">
            ⭐ {driver.rating.toFixed(1)} · {driver.totalServices} services · {driver.vehicleType}
          </div>
          <div className="mt-1">
            <Badge tone="green">Disponible</Badge>
          </div>
        </div>
      </div>
      <div className="text-right shrink-0">
        <div className="font-display font-bold text-orange">{driver.etaMinutes} min</div>
        <div className="text-xs text-muted">{driver.distanceKm.toFixed(1)} km</div>
        <div className="text-xs text-muted mt-1">~${driver.price.toFixed(0)}</div>
      </div>
    </button>
  );
}
