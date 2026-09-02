-- TowConnect — Phase 6.1: the first entries in document_requirements, and the
-- only ones any official source actually supports. Additive, run after 0030
-- (which must have committed: it adds the 'tow_certificate' enum value this
-- file uses, and Postgres refuses a new enum value inside the transaction
-- that created it).
--
-- ONTARIO — verified
-- Source: Towing and vehicle storage requirements, Government of Ontario,
--   https://www.ontario.ca/page/towing-and-vehicle-storage-requirements
--   made under the Towing and Storage Safety and Enforcement Act, 2021.
-- The page states two things about a driver in plain words: they must "have
-- the proper class of driver's licence for the tow truck you are driving",
-- and they must "carry both the tow operator's certificate and your tow
-- driver's certificate when operating the tow truck". Those are the two rows
-- below, and nothing else.
--
-- WHAT IS DELIBERATELY ABSENT
--   * Insurance. The Ontario page does not state an insurance requirement for
--     a driver, so none is recorded. It is very likely that operators carry
--     insurance obligations somewhere in the regulations; "very likely" is not
--     a source.
--   * Quebec. Nothing is seeded for the province TowConnect actually launches
--     in. LegisQuebec returned 403 to automated fetching, the SAAQ material
--     found covers heavy-vehicle and recreational-vehicle obligations rather
--     than what a tow operator must hold, and the MTMD exclusive-towing pages
--     cover rates and procedure, not operator credentials. Seeding a plausible
--     Quebec rule would have been inventing law for the one jurisdiction where
--     it would immediately gate real drivers. This is the top open item.
--   * A generic "Canada" rule. Explicitly out of scope: there is no federal
--     towing credential to point at.
--
-- EFFECT TODAY: none on anybody. Every driver on the platform is in Quebec, so
-- these rows gate nobody until an Ontario driver signs up — which is exactly
-- when they should start gating.

insert into document_requirements (
  province, document_type, required, blocks_online, blocks_dispatch,
  requires_expiry, grace_days, source_url, source_title, last_verified_at, active, notes
) values (
  'ON',
  'license',
  true, true, true,
  false, 0,
  'https://www.ontario.ca/page/towing-and-vehicle-storage-requirements',
  'Towing and vehicle storage requirements — Government of Ontario (Towing and Storage Safety and Enforcement Act, 2021)',
  now(),
  true,
  'ontario.ca: a tow truck driver must "have the proper class of driver''s licence for the tow truck you are driving".'
), (
  'ON',
  'tow_certificate',
  true, true, true,
  -- requires_expiry stays false: tow driver certificates are renewed every
  -- three years, but ontario.ca does not say the expiry date must be on file,
  -- and enforcing a date nobody verified would be inventing the rule rather
  -- than recording it.
  false, 0,
  'https://www.ontario.ca/page/towing-and-vehicle-storage-requirements',
  'Towing and vehicle storage requirements — Government of Ontario (Towing and Storage Safety and Enforcement Act, 2021)',
  now(),
  true,
  'ontario.ca: a driver must "carry both the tow operator''s certificate and your tow driver''s certificate when operating the tow truck".'
)
on conflict (province, document_type) do nothing;
