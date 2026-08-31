export interface RequestFormData {
  problemType: string;
  problemKey: string;
  locationText: string;
  lat: number;
  lng: number;
  vehicleDesc: string;
  vehicleId: string | null;
  notes: string;
  // Only set (non-null) when problemRequiresDestination(problemType) is true.
  destinationAddress: string | null;
  destinationLat: number | null;
  destinationLng: number | null;
}

export { PROBLEM_TYPES, FALLBACK_CENTER } from '@/lib/constants';
