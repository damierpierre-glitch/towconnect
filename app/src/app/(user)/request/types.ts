export interface RequestFormData {
  problemType: string;
  problemKey: string;
  locationText: string;
  lat: number;
  lng: number;
  vehicleDesc: string;
  notes: string;
}

export { PROBLEM_TYPES, FALLBACK_CENTER } from '@/lib/constants';
