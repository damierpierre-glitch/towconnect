export type UserRole = 'user' | 'driver' | 'admin';
export type DriverApprovalStatus = 'pending' | 'approved' | 'rejected';
export type RequestStatus =
  | 'pending'
  | 'matched'
  | 'en_route'
  | 'arrived'
  | 'in_progress'
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
  // Set only by ensureStripeCustomer() (lib/actions/payments.ts) via the
  // service-role client — guarded against direct writes from the user's own
  // session (0013_payments.sql). Never the user's email; a persistent,
  // TowConnect-controlled identity for their saved payment methods.
  stripe_customer_id: string | null;
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
  // Problem-type keys (PROBLEM_TYPES in constants.ts) this driver says they
  // handle. Display-only as of Phase 5 — dispatch does not read this yet,
  // see 0018_driver_service_types.sql.
  service_types: string[];
  // Set only alongside approval_status = 'rejected' by an admin — guarded
  // the same way approval_status itself is (0019_driver_documents.sql).
  rejection_reason: string | null;
  // Prep for the future Business/company role. No UI writes this yet — see
  // 0020_companies_prep.sql.
  company_id: string | null;
  updated_at: string;
};

export type DriverDocumentType = 'license' | 'insurance' | 'registration' | 'other';
export type DriverDocumentStatus = 'pending' | 'approved' | 'rejected' | 'expired';

// Never written from the browser except a fresh, unreviewed insert — see the
// trust-model note at the top of 0019_driver_documents.sql. Only an admin (or
// the service role) can change `status`.
export type DriverDocument = {
  id: string;
  driver_id: string;
  type: DriverDocumentType;
  storage_path: string;
  status: DriverDocumentStatus;
  rejection_reason: string | null;
  expires_at: string | null;
  uploaded_at: string;
  reviewed_at: string | null;
  reviewed_by: string | null;
};

// Prep-only (0020_companies_prep.sql) — no UI reads or writes this yet.
export type Company = {
  id: string;
  name: string;
  owner_id: string;
  created_at: string;
};

export type NearbyDriverRow = {
  profile_id: string;
  full_name: string;
  rating: number;
  total_services: number;
  vehicle_type: VehicleType;
  distance_km: number;
};

export type Vehicle = {
  id: string;
  user_id: string;
  make: string;
  model: string;
  year: number;
  color: string | null;
  plate: string | null;
  province: string | null;
  is_primary: boolean;
  created_at: string;
  updated_at: string;
};

// Statuses a request is considered "active" in — used to resume an
// in-progress intervention on load instead of losing it on refresh.
export const ACTIVE_REQUEST_STATUSES = ['pending', 'matched', 'en_route', 'arrived', 'in_progress'] as const;

export type TowRequest = {
  id: string;
  user_id: string;
  driver_id: string | null;
  problem_type: string;
  location_text: string;
  lat: number;
  lng: number;
  vehicle_desc: string | null;
  vehicle_id: string | null;
  notes: string | null;
  status: RequestStatus;
  // `numeric` in Postgres → PostgREST serializes it as a string. Always parse
  // with toMoney() before treating it as a number.
  price_estimate: number | string;
  // Destination — only present for problemRequiresDestination() service
  // types (constants.ts). tow_distance_km is computed server-side at
  // creation time, never trusted from the browser.
  destination_address: string | null;
  destination_lat: number | null;
  destination_lng: number | null;
  tow_distance_km: number | string | null;
  // Frozen price breakdown, same numeric-as-string caveat as price_estimate.
  // Always sums to price_estimate as of request creation.
  price_base: number | string | null;
  price_distance: number | string | null;
  price_surcharge: number | string | null;
  // NULL until a commission rate is decided by the business — see
  // 0012_destination_and_pricing_snapshot.sql.
  commission_amount: number | string | null;
  partner_amount: number | string | null;
  created_at: string;
  updated_at: string;
};

export type RequestEvent = {
  id: string;
  request_id: string;
  status: RequestStatus;
  created_at: string;
};

export type DispatchOfferStatus = 'offered' | 'declined' | 'accepted' | 'timeout';

// A driver only ever reads their own rows (RLS) and only ever to render a
// countdown on an offer already implied by their `requests` row — the
// client never lists/browses dispatch_offers the way the old StepDrivers
// browsed driver_profiles.
export type DispatchOffer = {
  id: string;
  request_id: string;
  driver_id: string;
  status: DispatchOfferStatus;
  score: number;
  rank: number;
  offered_at: string;
  expires_at: string;
  responded_at: string | null;
};

// A message is either free text (`body`) or a resolved-client-side quick
// message (`template_key` — see QUICK_MESSAGES in lib/constants.ts); never
// both null, enforced by a DB check constraint.
export type Message = {
  id: string;
  request_id: string;
  sender_id: string;
  body: string | null;
  template_key: string | null;
  created_at: string;
  read_at: string | null;
};

export type PaymentStatus =
  | 'requires_payment_method'
  | 'requires_action'
  | 'authorized'
  | 'captured'
  | 'failed'
  | 'canceled'
  | 'refunded';

// Never written from the browser — see the trust-model note at the top of
// 0013_payments.sql. The client only ever reads this (its own rows, via
// RLS) to render payment/receipt status.
export type Payment = {
  id: string;
  request_id: string;
  stripe_payment_intent_id: string | null;
  amount: number | string;
  currency: string;
  status: PaymentStatus;
  commission_amount: number | string | null;
  partner_amount: number | string | null;
  failure_reason: string | null;
  created_at: string;
  updated_at: string;
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
          {
            foreignKeyName: 'requests_vehicle_id_fkey';
            columns: ['vehicle_id'];
            isOneToOne: false;
            referencedRelation: 'vehicles';
            referencedColumns: ['id'];
          },
        ];
      };
      vehicles: {
        Row: Vehicle;
        Insert: Partial<Vehicle> & { user_id: string; make: string; model: string; year: number };
        Update: Partial<Vehicle>;
        Relationships: [
          {
            foreignKeyName: 'vehicles_user_id_fkey';
            columns: ['user_id'];
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
      messages: {
        Row: Message;
        Insert: Partial<Message> & { request_id: string; sender_id: string };
        Update: Partial<Message>;
        Relationships: [
          {
            foreignKeyName: 'messages_request_id_fkey';
            columns: ['request_id'];
            isOneToOne: false;
            referencedRelation: 'requests';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'messages_sender_id_fkey';
            columns: ['sender_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      payments: {
        Row: Payment;
        // Never inserted/updated from the browser — only from
        // lib/actions/payments.ts and the webhook route, both using the
        // service-role client (see 0013_payments.sql). Typed loosely here
        // (Partial + the couple of fields every insert actually provides)
        // rather than requiring every column, since most are optional/set
        // later.
        Insert: Partial<Payment> & { request_id: string; amount: number };
        Update: Partial<Payment>;
        Relationships: [
          {
            foreignKeyName: 'payments_request_id_fkey';
            columns: ['request_id'];
            isOneToOne: false;
            referencedRelation: 'requests';
            referencedColumns: ['id'];
          },
        ];
      };
      stripe_webhook_events: {
        Row: { id: string; stripe_event_id: string; type: string; processed_at: string };
        Insert: { stripe_event_id: string; type: string };
        Update: never;
        Relationships: [];
      };
      dispatch_offers: {
        Row: DispatchOffer;
        // Never inserted/updated from client code — every write goes through
        // dispatch_next_candidate() / respond_to_dispatch_offer() (RLS has no
        // insert/update policy for authenticated at all). Present here only
        // so `.from('dispatch_offers').select()` reads are typed.
        Insert: DispatchOffer;
        Update: Partial<DispatchOffer>;
        Relationships: [
          {
            foreignKeyName: 'dispatch_offers_request_id_fkey';
            columns: ['request_id'];
            isOneToOne: false;
            referencedRelation: 'requests';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'dispatch_offers_driver_id_fkey';
            columns: ['driver_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      driver_documents: {
        Row: DriverDocument;
        // A driver may only insert a fresh, unreviewed row — see the WITH
        // CHECK on "driver_documents: driver inserts own pending"
        // (0019_driver_documents.sql). There is no UPDATE policy for a
        // driver's own session at all.
        Insert: Partial<DriverDocument> & { driver_id: string; type: DriverDocumentType; storage_path: string };
        Update: Partial<DriverDocument>;
        Relationships: [
          {
            foreignKeyName: 'driver_documents_driver_id_fkey';
            columns: ['driver_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      companies: {
        Row: Company;
        // No insert/update/delete policy for authenticated at all — prep
        // only, see 0020_companies_prep.sql.
        Insert: Partial<Company> & { name: string; owner_id: string };
        Update: Partial<Company>;
        Relationships: [
          {
            foreignKeyName: 'companies_owner_id_fkey';
            columns: ['owner_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
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
      dispatch_next_candidate: {
        Args: { p_request_id: string };
        Returns: DispatchOffer | null;
      };
      respond_to_dispatch_offer: {
        Args: { p_request_id: string; p_accept: boolean };
        Returns: TowRequest;
      };
      nudge_dispatch: {
        Args: { p_request_id: string };
        Returns: DispatchOffer | null;
      };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}
