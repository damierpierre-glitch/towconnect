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

// 'tow_certificate' added in Phase 6.1: Ontario's Towing and Storage Safety
// and Enforcement Act, 2021 requires a tow driver certificate carried while
// operating, and filing that under 'other' would show a driver "Other
// document" where the law names a specific one.
export type DriverDocumentType =
  | 'license'
  | 'insurance'
  | 'registration'
  | 'tow_certificate'
  | 'other';
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

export type CompanyStatus = 'pending' | 'active' | 'suspended' | 'rejected';

export type Company = {
  id: string;
  // Legal / registered name.
  name: string;
  // What customers see. Falls back to `name` when null.
  display_name: string | null;
  owner_id: string;
  status: CompanyStatus;
  phone: string | null;
  email: string | null;
  province: string | null;
  address: string | null;
  // Phase 7. Stripe's own answers about the account, never written from a
  // browser — a trigger (0034) refuses it. No bank, card or KYC data is
  // stored: onboarding happens on Stripe's hosted flow.
  stripe_account_id: string | null;
  connect_status: ConnectOnboardingStatus;
  connect_charges_enabled: boolean;
  connect_payouts_enabled: boolean;
  connect_requirements_due: string[];
  connect_disabled_reason: string | null;
  connect_updated_at: string | null;
  created_at: string;
  updated_at: string;
};

export type CompanyMemberRole = 'owner' | 'admin' | 'dispatcher' | 'driver';
export type CompanyMemberStatus = 'invited' | 'active' | 'removed';

// Source of truth for who belongs to a company (0024). driver_profiles.
// company_id is a derived mirror of the role='driver' rows.
export type CompanyMember = {
  id: string;
  company_id: string;
  profile_id: string;
  role: CompanyMemberRole;
  status: CompanyMemberStatus;
  invited_by: string | null;
  created_at: string;
  updated_at: string;
};

// Physical equipment, not marketing. Dispatch maps a problem type onto these
// through service_type_requirements rather than hard-coding the link.
export type ServiceCapability =
  | 'flatbed'
  | 'wheel_lift'
  | 'heavy_duty'
  | 'winch'
  | 'boost'
  | 'lockout'
  | 'tire_change'
  | 'fuel_delivery'
  | 'recovery';

export type FleetVehicleStatus = 'active' | 'inactive' | 'maintenance';

export type FleetVehicle = {
  id: string;
  company_id: string;
  label: string | null;
  truck_type: VehicleType;
  plate: string | null;
  province: string | null;
  status: FleetVehicleStatus;
  // Empty means "not declared", which dispatch treats as unknown - never as
  // incapable. See 0026.
  capabilities: ServiceCapability[];
  notes: string | null;
  created_at: string;
  updated_at: string;
};

// Only a company manager can create these - there is no self-assignment path
// at all, and a trigger additionally refuses any cross-company pairing.
export type DriverVehicleAssignment = {
  id: string;
  fleet_vehicle_id: string;
  driver_id: string;
  assigned_by: string | null;
  active: boolean;
  created_at: string;
  ended_at: string | null;
};

export type ServiceAreaKind = 'radius' | 'polygon';

export type CompanyServiceArea = {
  id: string;
  company_id: string;
  name: string;
  kind: ServiceAreaKind;
  center_lat: number | null;
  center_lng: number | null;
  radius_km: number | null;
  active: boolean;
  created_at: string;
  updated_at: string;
};

export type ServiceTypeRequirement = {
  problem_type: string;
  any_of_capabilities: ServiceCapability[];
  all_of_capabilities: ServiceCapability[];
  active: boolean;
  notes: string | null;
  updated_at: string;
};

// ------------------------------------------------------ Phase 6: regulated
// zones. A zone is published law with a source and a verification date, not
// a TowConnect setting.
export type ZoneRestrictionType =
  | 'exclusive_operator'
  | 'authorized_list'
  | 'permit_required'
  | 'municipal_restriction'
  | 'other';

export type ZoneDispatchMode =
  | 'authorized_provider_only'
  | 'external_authority_required'
  | 'manual_instruction_only'
  | 'restricted_network';

// How much the polygon can be trusted. 'none' means there is no boundary at
// all, and a CHECK constraint refuses to activate such a zone.
export type ZoneGeometryConfidence =
  | 'official_geospatial'
  | 'derived_from_official_text'
  | 'approximate_pending_validation'
  | 'none';

export type ZoneAuthorizationStatus =
  | 'authorized'
  | 'suspended'
  | 'revoked'
  | 'pending_verification';

export type RegulatedDispatchState =
  | 'not_applicable'
  | 'awaiting_external_authority'
  | 'authorized_provider_search'
  | 'restricted_capacity_wait'
  | 'manual_instruction';

export type RegulatedTowingZone = {
  id: string;
  country: string;
  province: string;
  jurisdiction: string;
  official_name: string;
  zone_code: string | null;
  restriction_type: ZoneRestrictionType;
  dispatch_mode: ZoneDispatchMode;
  geometry_confidence: ZoneGeometryConfidence;
  geometry_note: string | null;
  source_url: string;
  source_title: string;
  effective_from: string;
  effective_to: string | null;
  last_verified_at: string;
  active: boolean;
  user_instruction_fr: string;
  user_instruction_en: string;
  authority_phone: string | null;
  precedence: number;
  created_at: string;
  updated_at: string;
};

// An officially authorized operator for a zone. company_id is null when the
// official source names an operator that is not a TowConnect company - the
// fact is recorded without inventing an account for it.
export type RegulatedZoneProvider = {
  id: string;
  zone_id: string;
  company_id: string | null;
  official_operator_name: string;
  authorization_status: ZoneAuthorizationStatus;
  valid_from: string | null;
  valid_to: string | null;
  priority: number;
  source_url: string | null;
  source_title: string | null;
  last_verified_at: string | null;
  created_at: string;
  updated_at: string;
};

export type DocumentRequirement = {
  id: string;
  province: string | null;
  document_type: DriverDocumentType;
  required: boolean;
  blocks_online: boolean;
  blocks_dispatch: boolean;
  requires_expiry: boolean;
  grace_days: number;
  source_url: string | null;
  source_title: string | null;
  last_verified_at: string | null;
  active: boolean;
  notes: string | null;
};

export type SupplementStatus = 'proposed' | 'approved' | 'declined' | 'cancelled';

export type ServiceSupplementType = {
  key: string;
  label_fr: string;
  label_en: string;
  active: boolean;
};

// Proposed by the assigned driver, approved only by the customer. An
// approved supplement is frozen (0027).
export type RequestSupplement = {
  id: string;
  request_id: string;
  type_key: string;
  amount: number | string;
  note: string | null;
  status: SupplementStatus;
  proposed_by: string;
  responded_at: string | null;
  // Phase 7. Approval is a promise; this is whether the money was secured.
  // Written only by the platform (0037 trigger) — a driver who could set this
  // to 'settled' would be crediting their own ledger.
  payment_state: 'pending' | 'authorized' | 'uncollected' | 'settled';
  payment_note: string | null;
  payment_settled_at: string | null;
  created_at: string;
  updated_at: string;
};

// Every value is NULL until the business decides a commission rate. Nothing
// in the app may substitute a number for these.
export type PlatformPricingConfig = {
  id: boolean;
  commission_percent: number | string | null;
  commission_fixed: number | string | null;
  provider_minimum: number | string | null;
  payment_processing_percent: number | string | null;
  payment_processing_fixed: number | string | null;
  updated_at: string;
  updated_by: string | null;
};

// One row per candidate considered, with the first rule it failed. Produced
// by the same query dispatch itself uses, so the audit view cannot disagree
// with what dispatch actually did.
export type DispatchCandidateExplanation = {
  driver_id: string;
  full_name: string;
  distance_km: number;
  company_id: string | null;
  eligible: boolean;
  exclusion_reason: string | null;
  zone_authorized: boolean;
  service_compatibility: 'compatible' | 'incompatible' | 'unknown' | 'not_required';
  compliance_blocked: boolean;
  service_area_ok: boolean;
  preferred_partner: boolean;
  effective_rating: number;
  score: number;
};


// ---------------------------------------------------------------- Phase 7:
// monetization. Every money field is nullable and ships NULL: no commission
// rate has been decided, and a zero would read as one.
export type PricingConfigStatus = 'draft' | 'active' | 'archived';

export type PricingConfig = {
  id: string;
  version: number;
  label: string;
  status: PricingConfigStatus;
  commission_percent: number | string | null;
  commission_fixed: number | string | null;
  commission_min: number | string | null;
  commission_max: number | string | null;
  provider_minimum: number | string | null;
  payment_processing_percent: number | string | null;
  payment_processing_fixed: number | string | null;
  cancellation_fee_customer: number | string | null;
  cancellation_compensation_provider: number | string | null;
  currency: string;
  notes: string | null;
  created_at: string;
  created_by: string | null;
  activated_at: string | null;
  activated_by: string | null;
  archived_at: string | null;
};

export type ConnectOnboardingStatus =
  | 'not_started'
  | 'pending'
  | 'restricted'
  | 'enabled'
  | 'disabled';

// Signed movements. Positive credits the provider, negative pays out or takes
// back. Corrections are new entries: the table refuses UPDATE outright.
export type LedgerEntryType =
  | 'earning'
  | 'supplement'
  | 'adjustment'
  | 'refund_reversal'
  | 'payout'
  | 'payout_reversal';

export type PayoutState = 'pending' | 'eligible' | 'held' | 'paid' | 'reversed';

export type ProviderLedgerEntry = {
  id: number;
  company_id: string;
  driver_id: string | null;
  request_id: string | null;
  payout_id: string | null;
  entry_type: LedgerEntryType;
  amount: number | string;
  currency: string;
  // NULL means not yet payable. There is no boolean to flip by accident.
  available_at: string | null;
  description: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  created_by: string | null;
};

export type ProviderPayout = {
  id: string;
  company_id: string;
  amount: number | string;
  currency: string;
  state: PayoutState;
  stripe_transfer_id: string | null;
  failure_reason: string | null;
  requested_by: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  paid_at: string | null;
  reversed_at: string | null;
};

export type ProviderBalances = {
  pending: number | string;
  available: number | string;
  paid_total: number | string;
  lifetime_earned: number | string;
};

export type RefundStatus = 'pending' | 'succeeded' | 'failed' | 'canceled';

export type Refund = {
  id: string;
  request_id: string;
  payment_id: string | null;
  amount: number | string;
  currency: string;
  reason: string;
  status: RefundStatus;
  stripe_refund_id: string | null;
  failure_reason: string | null;
  created_by: string;
  created_at: string;
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
  payment_processing_cost: number | string | null;
  // Phase 7: which economic configuration produced the money on this row, and
  // when it stopped being able to change. A later configuration change must
  // never reprice a job that was already accepted under an older one.
  pricing_config_id: string | null;
  pricing_config_version: number | null;
  pricing_rule_ids: string[];
  economics_frozen_at: string | null;
  // Phase 7: what the cancellation actually cost and paid. NULL means no
  // cancellation policy was configured — not that the fee was zero.
  cancellation_fee_charged: number | string | null;
  cancellation_compensation: number | string | null;
  cancellation_settled_at: string | null;
  // Phase 6: the regulated zone covering the pickup point, stamped by a
  // BEFORE INSERT trigger (0023) so it can never be client-supplied. Null
  // when no active zone covers the point.
  regulated_zone_id: string | null;
  regulated_zone_mode: ZoneDispatchMode | null;
  regulated_dispatch_state: RegulatedDispatchState;
  regulated_zone_checked_at: string | null;
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
      pricing_configs: {
        Row: PricingConfig;
        Insert: Partial<PricingConfig> & { version: number; label: string };
        Update: Partial<PricingConfig>;
        Relationships: [];
      };
      provider_ledger_entries: {
        Row: ProviderLedgerEntry;
        // Written only by trusted server code through the service role; the
        // table refuses UPDATE and DELETE outright (0035).
        Insert: Partial<ProviderLedgerEntry> & {
          company_id: string;
          entry_type: LedgerEntryType;
          amount: number;
        };
        Update: never;
        Relationships: [
          {
            foreignKeyName: 'provider_ledger_entries_company_id_fkey';
            columns: ['company_id'];
            isOneToOne: false;
            referencedRelation: 'companies';
            referencedColumns: ['id'];
          },
        ];
      };
      provider_payouts: {
        Row: ProviderPayout;
        Insert: Partial<ProviderPayout> & { company_id: string; amount: number };
        Update: Partial<ProviderPayout>;
        Relationships: [
          {
            foreignKeyName: 'provider_payouts_company_id_fkey';
            columns: ['company_id'];
            isOneToOne: false;
            referencedRelation: 'companies';
            referencedColumns: ['id'];
          },
        ];
      };
      refunds: {
        Row: Refund;
        Insert: Partial<Refund> & {
          request_id: string;
          amount: number;
          reason: string;
          created_by: string;
        };
        Update: Partial<Refund>;
        Relationships: [
          {
            foreignKeyName: 'refunds_request_id_fkey';
            columns: ['request_id'];
            isOneToOne: false;
            referencedRelation: 'requests';
            referencedColumns: ['id'];
          },
        ];
      };
      refund_authorizers: {
        Row: { profile_id: string; granted_by: string | null; granted_at: string; note: string | null };
        Insert: { profile_id: string; granted_by?: string | null; note?: string | null };
        Update: Partial<{ note: string | null }>;
        Relationships: [];
      };
      regulated_towing_zones: {
        Row: RegulatedTowingZone;
        // Admin-only writes (0023). The geometry column is deliberately not
        // in the Row type: it is a PostGIS geography that PostgREST returns
        // as an opaque hex string, and nothing in the app should be reading
        // or round-tripping it.
        Insert: Partial<RegulatedTowingZone>;
        Update: Partial<RegulatedTowingZone>;
        Relationships: [];
      };
      regulated_zone_providers: {
        Row: RegulatedZoneProvider;
        Insert: Partial<RegulatedZoneProvider> & { zone_id: string; official_operator_name: string };
        Update: Partial<RegulatedZoneProvider>;
        Relationships: [
          {
            foreignKeyName: 'regulated_zone_providers_zone_id_fkey';
            columns: ['zone_id'];
            isOneToOne: false;
            referencedRelation: 'regulated_towing_zones';
            referencedColumns: ['id'];
          },
        ];
      };
      company_members: {
        Row: CompanyMember;
        Insert: Partial<CompanyMember> & { company_id: string; profile_id: string; role: CompanyMemberRole };
        Update: Partial<CompanyMember>;
        Relationships: [
          {
            foreignKeyName: 'company_members_company_id_fkey';
            columns: ['company_id'];
            isOneToOne: false;
            referencedRelation: 'companies';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'company_members_profile_id_fkey';
            columns: ['profile_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      fleet_vehicles: {
        Row: FleetVehicle;
        Insert: Partial<FleetVehicle> & { company_id: string };
        Update: Partial<FleetVehicle>;
        Relationships: [
          {
            foreignKeyName: 'fleet_vehicles_company_id_fkey';
            columns: ['company_id'];
            isOneToOne: false;
            referencedRelation: 'companies';
            referencedColumns: ['id'];
          },
        ];
      };
      driver_vehicle_assignments: {
        Row: DriverVehicleAssignment;
        Insert: Partial<DriverVehicleAssignment> & { fleet_vehicle_id: string; driver_id: string };
        Update: Partial<DriverVehicleAssignment>;
        Relationships: [
          {
            foreignKeyName: 'driver_vehicle_assignments_fleet_vehicle_id_fkey';
            columns: ['fleet_vehicle_id'];
            isOneToOne: false;
            referencedRelation: 'fleet_vehicles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'driver_vehicle_assignments_driver_id_fkey';
            columns: ['driver_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      company_service_areas: {
        Row: CompanyServiceArea;
        Insert: Partial<CompanyServiceArea> & { company_id: string; name: string; kind: ServiceAreaKind };
        Update: Partial<CompanyServiceArea>;
        Relationships: [
          {
            foreignKeyName: 'company_service_areas_company_id_fkey';
            columns: ['company_id'];
            isOneToOne: false;
            referencedRelation: 'companies';
            referencedColumns: ['id'];
          },
        ];
      };
      service_type_requirements: {
        Row: ServiceTypeRequirement;
        Insert: Partial<ServiceTypeRequirement> & { problem_type: string };
        Update: Partial<ServiceTypeRequirement>;
        Relationships: [];
      };
      document_requirements: {
        Row: DocumentRequirement;
        Insert: Partial<DocumentRequirement> & { document_type: DriverDocumentType };
        Update: Partial<DocumentRequirement>;
        Relationships: [];
      };
      service_supplement_types: {
        Row: ServiceSupplementType;
        Insert: Partial<ServiceSupplementType> & { key: string; label_fr: string; label_en: string };
        Update: Partial<ServiceSupplementType>;
        Relationships: [];
      };
      request_supplements: {
        Row: RequestSupplement;
        Insert: Partial<RequestSupplement> & {
          request_id: string;
          type_key: string;
          amount: number;
          proposed_by: string;
        };
        Update: Partial<RequestSupplement>;
        Relationships: [
          {
            foreignKeyName: 'request_supplements_request_id_fkey';
            columns: ['request_id'];
            isOneToOne: false;
            referencedRelation: 'requests';
            referencedColumns: ['id'];
          },
        ];
      };
      platform_pricing_config: {
        Row: PlatformPricingConfig;
        Insert: Partial<PlatformPricingConfig>;
        Update: Partial<PlatformPricingConfig>;
        Relationships: [];
      };
      pricing_rules: {
        Row: {
          id: string;
          name: string;
          target: 'customer_price' | 'provider_compensation' | 'towconnect_margin' | 'payment_processing';
          component: 'base_fee' | 'per_km' | 'minimum' | 'percentage' | 'fixed_amount' | 'cap';
          amount: number | string | null;
          percent: number | string | null;
          province: string | null;
          regulated_zone_id: string | null;
          company_id: string | null;
          problem_type: string | null;
          required_capability: ServiceCapability | null;
          day_of_week: number | null;
          hour_from: number | null;
          hour_to: number | null;
          priority: number;
          effective_from: string | null;
          effective_to: string | null;
          active: boolean;
          notes: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Record<string, unknown>;
        Update: Record<string, unknown>;
        Relationships: [];
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
    Views: {
      request_economics: {
        Row: {
          request_id: string;
          user_id: string;
          driver_id: string | null;
          customer_price: number | string;
          provider_compensation: number | string | null;
          towconnect_margin: number | string | null;
          payment_processing_cost: number | string | null;
          approved_supplements: number | string;
          customer_total: number | string;
          // 'not_configured' means no commission rate exists yet, which is a
          // different thing from a computed zero.
          economics_status: 'not_configured' | 'computed';
        };
        Relationships: [];
      };
    };
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
      // Phase 6. regulated_zone_for_point returns a single zone row whose
      // every field is null when no active zone covers the point — Postgres
      // composite-returning functions do that rather than returning nothing,
      // so callers must check `id`, not the row itself.
      regulated_zone_for_point: {
        Args: { p_lat: number; p_lng: number };
        Returns: RegulatedTowingZone | null;
      };
      company_authorized_for_zone: {
        Args: { p_company_id: string; p_zone_id: string };
        Returns: boolean;
      };
      driver_company_id: {
        Args: { p_profile_id: string };
        Returns: string | null;
      };
      company_role_of: {
        Args: { p_company_id: string; p_profile_id?: string };
        Returns: CompanyMemberRole | null;
      };
      is_company_member: {
        Args: { p_company_id: string };
        Returns: boolean;
      };
      is_company_manager: {
        Args: { p_company_id: string };
        Returns: boolean;
      };
      driver_capabilities: {
        Args: { p_driver_id: string };
        Returns: ServiceCapability[];
      };
      driver_service_compatibility: {
        Args: { p_driver_id: string; p_problem_type: string };
        Returns: string;
      };
      driver_compliance_issues: {
        Args: { p_driver_id: string };
        Returns: {
          document_type: DriverDocumentType;
          reason: string;
          blocks_online: boolean;
          blocks_dispatch: boolean;
        }[];
      };
      driver_dispatch_blocked: {
        Args: { p_driver_id: string };
        Returns: boolean;
      };
      driver_online_blocked: {
        Args: { p_driver_id: string };
        Returns: boolean;
      };
      explain_dispatch_candidates: {
        Args: { p_request_id: string };
        Returns: DispatchCandidateExplanation[];
      };
      pricing_configured: {
        Args: Record<string, never>;
        Returns: boolean;
      };
      active_pricing_config: {
        Args: Record<string, never>;
        Returns: PricingConfig | null;
      };
      provider_balances: {
        Args: { p_company_id: string };
        Returns: ProviderBalances[];
      };
      request_refunded_total: {
        Args: { p_request_id: string };
        Returns: number | string;
      };
      is_refund_authorizer: {
        Args: Record<string, never>;
        Returns: boolean;
      };
      // Returns null while no commission rate is configured. Callers must
      // render nothing in that case — never a zero.
      request_provider_compensation: {
        Args: { p_request_id: string };
        Returns: number | string | null;
      };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}
