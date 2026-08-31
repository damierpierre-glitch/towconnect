-- TowConnect — Phase 4: structured destination + a transparent, frozen price
-- breakdown per request. Additive, run after 0001-0011.

-- ============================================================
-- Destination — only towing-style problem types collect one (see
-- problemRequiresDestination() in src/lib/constants.ts); nullable for every
-- other request, which is the vast majority on day one.
-- ============================================================
alter table requests
  add column destination_address text,
  add column destination_lat double precision,
  add column destination_lng double precision,
  -- Pickup -> destination distance, in km. Computed server-side at request
  -- creation time from the two coordinate pairs (see createRequest() in
  -- lib/actions/requests.ts) — never taken from a client-supplied number.
  add column tow_distance_km numeric(6,2);

-- ============================================================
-- Price snapshot — price_estimate (existing column, numeric) remains the
-- single authoritative total charged to the customer, frozen at request
-- creation and never recomputed afterward, even if the pricing formula in
-- lib/pricing.ts changes later. These three columns are its breakdown, for
-- a transparent receipt — base + distance + surcharge always sums to
-- price_estimate at the time of creation.
-- ============================================================
alter table requests
  add column price_base numeric(8,2),
  add column price_distance numeric(8,2),
  add column price_surcharge numeric(8,2);

-- ============================================================
-- Commission / partner payout — columns only. Deliberately left NULL and
-- uncomputed in this phase: picking a commission rate is a business
-- decision, not a technical one, and inventing a number here would be
-- exactly the "arbitrary percentage" the Phase 4 brief says not to choose.
-- See TOWCONNECT_PHASE4_REPORT.md — once a rate is decided, computing and
-- populating these at capture time is a small, additive follow-up.
-- ============================================================
alter table requests
  add column commission_amount numeric(8,2),
  add column partner_amount numeric(8,2);

comment on column requests.commission_amount is
  'TowConnect''s cut of price_estimate. NULL until a commission rate is set by the business — never computed with an invented rate.';
comment on column requests.partner_amount is
  'Amount owed to the driver/partner (price_estimate - commission_amount). NULL until commission_amount is.';
