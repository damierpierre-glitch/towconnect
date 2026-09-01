-- TowConnect — Phase 5: driver-facing "which jobs do you actually take"
-- field, requested for onboarding/profile. Additive, run after 0001-0017.
--
-- Deliberately informational only: nearby_drivers() and dispatch_next_
-- candidate_core() (0006/0007/0017) are validated foundations this phase is
-- not authorized to touch, so this column is captured and displayed but does
-- NOT filter dispatch. See TOWCONNECT_PHASE5_REPORT.md for the reasoning —
-- wiring it into matching is a real, separate decision for a later phase.
--
-- No RLS change needed: driver_profiles' existing "driver reads/updates own"
-- policy (0001) is column-unrestricted except for the fields the 0003/0016
-- guard trigger explicitly locks down (approval_status, rating,
-- total_services) — a plain array column is exactly as driver-writable as
-- vehicle_type already is.
alter table driver_profiles
  add column service_types text[] not null default '{}';

comment on column driver_profiles.service_types is
  'Problem-type keys (see PROBLEM_TYPES in constants.ts) this driver says '
  'they handle. Display-only as of Phase 5 — not read by dispatch.';
