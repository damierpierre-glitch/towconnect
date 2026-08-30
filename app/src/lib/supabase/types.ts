export type UserRole = 'user' | 'driver' | 'admin';
export type DriverApprovalStatus = 'pending' | 'approved' | 'rejected';
export type RequestStatus =
  | 'pending'
  | 'matched'
  | 'en_route'
  | 'arrived'
  | 'completed'
  | 'cancelled'
  | 'expired';
export type VehicleType = 'standard' | 'flatbed' | 'heavy_duty';

// These must be `type` aliases, not `interface` declarations: TypeScript's
// structural check for `X extends Record<string, unknown>` (which Supabase's
// generated types rely on internally) evaluates to `false` for interfaces,
// silently collapsing every query result to `never`.
export type Profile = {
  id: string;
  role: UserRole;
  full_name: string;
  phone: string | null;
  created_at: string;
};

export type DriverProfile = {
  profile_id: string;
  vehicle_type: VehicleType;
  license_plate: string | null;
  province: string;
  rating: number;
  total_services: number;
  is_online: boolean;
  approval_status: DriverApprovalStatus;
  current_lat: number | null;
  current_lng: number | null;
  last_heartbeat_at: string | null;
  updated_at: string;
};

export type NearbyDriverRow = {
  profile_id: string;
  full_name: string;
  rating: number;
  total_services: number;
  vehicle_type: VehicleType;
  distance_km: number;
};

export type TowRequest = {
  id: string;
  user_id: string;
  driver_id: string | null;
  problem_type: string;
  location_text: string;
  lat: number;
  lng: number;
  vehicle_desc: string | null;
  notes: string | null;
  status: RequestStatus;
  // `numeric` in Postgres → PostgREST serializes it as a string. Always parse
  // with toMoney() before treating it as a number.
  price_estimate: number | string;
  created_at: string;
  updated_at: string;
};

export type RequestEvent = {
  id: string;
  request_id: string;
  status: RequestStatus;
  created_at: string;
};

export interface Database {
  public: {
    Tables: {
      profiles: {
        Row: Profile;
        Insert: Partial<Profile> & { id: string };
        Update: Partial<Profile>;
        Relationships: [];
      };
      driver_profiles: {
        Row: DriverProfile;
        Insert: Partial<DriverProfile> & { profile_id: string };
        Update: Partial<DriverProfile>;
        Relationships: [
          {
            foreignKeyName: 'driver_profiles_profile_id_fkey';
            columns: ['profile_id'];
            isOneToOne: true;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      requests: {
        Row: TowRequest;
        Insert: Partial<TowRequest> & {
          user_id: string;
          problem_type: string;
          location_text: string;
          lat: number;
          lng: number;
        };
        Update: Partial<TowRequest>;
        Relationships: [
          {
            foreignKeyName: 'requests_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'requests_driver_id_fkey';
            columns: ['driver_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      request_events: {
        Row: RequestEvent;
        Insert: Partial<RequestEvent> & { request_id: string; status: RequestStatus };
        Update: Partial<RequestEvent>;
        Relationships: [
          {
            foreignKeyName: 'request_events_request_id_fkey';
            columns: ['request_id'];
            isOneToOne: false;
            referencedRelation: 'requests';
            referencedColumns: ['id'];
          },
        ];
      };
    };
    Views: Record<string, never>;
    Functions: {
      accept_request: {
        Args: { p_request_id: string };
        Returns: TowRequest;
      };
      nearby_drivers: {
        Args: {
          p_lat: number;
          p_lng: number;
          p_radius_km: number;
          p_limit?: number;
        };
        Returns: NearbyDriverRow[];
      };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}
