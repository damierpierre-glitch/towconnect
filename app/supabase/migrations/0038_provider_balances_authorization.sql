-- TowConnect — Phase 7: close a hole in provider_balances(). Additive, run
-- after 0037.
--
-- WHAT WAS WRONG
-- 0035 defined provider_balances() as SECURITY DEFINER and granted it to every
-- authenticated user, with no check on who was asking. The table underneath is
-- correctly RLS-protected, but a SECURITY DEFINER function bypasses that by
-- design — so any signed-in account could read any company's pending,
-- available and paid totals by passing its id. The ledger rows stayed private;
-- the sums did not.
--
-- The fix is the same shape as request_provider_compensation(): the function
-- states who may ask, and raises for everyone else.
create or replace function provider_balances(p_company_id uuid)
returns table (
  pending numeric,
  available numeric,
  paid_total numeric,
  lifetime_earned numeric
)
language plpgsql
stable
security definer set search_path = public
as $$
begin
  if auth.role() <> 'service_role'
     and not public.is_admin()
     and not is_company_owner_or_admin(p_company_id) then
    raise exception 'Not authorized to read this company''s balances' using errcode = '42501';
  end if;

  return query
  select
    -- Earned but not yet payable.
    coalesce(sum(e.amount) filter (
      where e.available_at is null or e.available_at > now()
    ), 0)::numeric(12,2) as pending,
    -- Payable now: everything released, less everything already paid out.
    coalesce(sum(e.amount) filter (
      where e.available_at is not null and e.available_at <= now()
    ), 0)::numeric(12,2) as available,
    coalesce(-sum(e.amount) filter (where e.entry_type = 'payout'), 0)::numeric(12,2) as paid_total,
    coalesce(sum(e.amount) filter (
      where e.entry_type in ('earning', 'supplement')
    ), 0)::numeric(12,2) as lifetime_earned
  from provider_ledger_entries e
  where e.company_id = p_company_id;
end;
$$;

revoke all on function provider_balances(uuid) from public;
grant execute on function provider_balances(uuid) to authenticated, service_role;

comment on function provider_balances(uuid) is
  'Every figure is derived from the ledger. There is no stored balance to disagree with the '
  'movements that produced it. Readable by the company''s own owner/admin, a platform admin, '
  'or the service role — nobody else (0038).';
