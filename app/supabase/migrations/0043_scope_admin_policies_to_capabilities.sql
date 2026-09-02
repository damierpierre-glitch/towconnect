-- TowConnect — Phase 8: least privilege, actually enforced. Additive, run
-- after 0042.
--
-- WHAT WAS WRONG
-- 0041 introduced operations / finance / support, and the Phase 8 RLS test
-- immediately caught that they meant nothing where it mattered most: the
-- policies guarding money and the regulatory layer all read
--
--   using (public.is_admin())
--
-- which is true for ANY admin whatever capability they hold. An operations
-- admin could write the platform's commission; a finance admin could
-- deactivate a regulated zone. The roles existed; the boundaries did not.
--
-- Capabilities are only worth having if the refusal is in the database, so
-- each of these policies now names the capability it belongs to. The
-- grandfather rule (0041) means an unscoped admin is unaffected: nothing
-- changes for anybody until somebody is deliberately scoped.
--
-- WHO OWNS WHAT
--   finance     — the money: refunds, payouts, the economic configuration
--   operations  — the platform: regulated zones and their authorized providers
--   support     — neither; it reads, and that is the whole point of it

-- ---- the money ----------------------------------------------------------
drop policy "pricing configs: admins full access" on pricing_configs;
create policy "pricing configs: finance full access" on pricing_configs
  for all using (public.has_admin_capability('finance'))
  with check (public.has_admin_capability('finance'));

drop policy "refunds: admins full access" on refunds;
create policy "refunds: finance full access" on refunds
  for all using (public.has_admin_capability('finance'))
  with check (public.has_admin_capability('finance'));

drop policy "payouts: admins full access" on provider_payouts;
create policy "payouts: finance full access" on provider_payouts
  for all using (public.has_admin_capability('finance'))
  with check (public.has_admin_capability('finance'));

-- ---- the regulatory layer ----------------------------------------------
-- A zone boundary is a claim about where the law applies. Deciding it is
-- operational work, and it is emphatically not a finance decision.
drop policy "regulated zones: admins full access" on regulated_towing_zones;
create policy "regulated zones: operations full access" on regulated_towing_zones
  for all using (public.has_admin_capability('operations'))
  with check (public.has_admin_capability('operations'));

drop policy "zone providers: admins full access" on regulated_zone_providers;
create policy "zone providers: operations full access" on regulated_zone_providers
  for all using (public.has_admin_capability('operations'))
  with check (public.has_admin_capability('operations'));

comment on function public.has_admin_capability(admin_capability) is
  'True when the caller is an admin AND either holds this capability (or super_admin), or holds no '
  'grant at all — the grandfather rule that keeps existing administrators working until somebody '
  'deliberately scopes them. Used by the policies on pricing_configs, refunds, provider_payouts, '
  'regulated_towing_zones and regulated_zone_providers (0043), not only by application code.';

-- ---- proving the derived thresholds have not drifted --------------------
-- ops_attention_queue() calls the engine's own functions, so its BEHAVIOUR
-- cannot drift. What can drift is the number shown next to it in
-- ops_thresholds, which an operator reads as the rule. This function compares
-- the two, and verify:operations fails when they disagree.
create or replace function ops_threshold_drift()
returns table (key text, stored_seconds integer, engine_seconds integer)
language sql
stable
security definer set search_path = public
as $$
  select 'driver_stale_heartbeat',
         (select value_seconds from ops_thresholds where key = 'driver_stale_heartbeat'),
         extract(epoch from driver_heartbeat_max_age())::integer
  union all
  select 'offer_ttl',
         (select value_seconds from ops_thresholds where key = 'offer_ttl'),
         extract(epoch from dispatch_offer_window())::integer;
$$;

revoke all on function ops_threshold_drift() from public;
grant execute on function ops_threshold_drift() to authenticated, service_role;

comment on function ops_threshold_drift() is
  'Compares the operator-visible thresholds against the rules the dispatch engine actually enforces. '
  'A difference means the command centre is describing a system that no longer exists.';
