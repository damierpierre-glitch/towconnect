-- TowConnect — Phase 7: make the SECURITY DEFINER authorization guards
-- null-safe. Additive, run after 0038.
--
-- THE BUG, AND WHY IT WAS INVISIBLE
-- Every guard in this codebase was written as
--
--   if auth.role() <> 'service_role' and not is_admin() and ... then raise
--
-- which reads correctly and fails open. `auth.role()` returns NULL when the
-- role claim is not where it looks for it, and in SQL `NULL <> 'service_role'`
-- is NULL, not true. `NULL and false` is NULL. `if NULL then` does not fire.
-- So the one branch that exists to refuse the request silently does nothing,
-- and the function returns the data.
--
-- The Phase 7 RLS test caught it on provider_balances(): a company owner read
-- another company's balances through a guard that looked airtight. The same
-- shape appears on three sibling functions, so all four are fixed here rather
-- than only the one the test happened to point at.
--
-- The fix is to make every term null-safe. A guard that cannot decide must
-- refuse, never allow.

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
  if coalesce(auth.role(), '') <> 'service_role'
     and not coalesce(public.is_admin(), false)
     and not coalesce(is_company_owner_or_admin(p_company_id), false) then
    raise exception 'Not authorized to read this company''s balances' using errcode = '42501';
  end if;

  return query
  select
    coalesce(sum(e.amount) filter (
      where e.available_at is null or e.available_at > now()
    ), 0)::numeric(12,2) as pending,
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

create or replace function request_provider_compensation(p_request_id uuid)
returns numeric
language plpgsql
stable
security definer set search_path = public
as $$
declare
  v_request requests;
begin
  select * into v_request from requests where id = p_request_id;
  if not found then
    return null;
  end if;

  if coalesce(auth.role(), '') <> 'service_role'
     and not coalesce(public.is_admin(), false)
     and auth.uid() is distinct from v_request.driver_id
     and auth.uid() is distinct from v_request.user_id
     and not coalesce(is_company_manager(driver_company_id(v_request.driver_id)), false) then
    raise exception 'Not authorized to read this request''s economics' using errcode = '42501';
  end if;

  -- Frozen or nothing. NULL means no economic configuration was active when
  -- this job was accepted; the caller must render that as "not configured",
  -- never as zero.
  return v_request.partner_amount;
end;
$$;

revoke all on function request_provider_compensation(uuid) from public;
grant execute on function request_provider_compensation(uuid) to authenticated, service_role;

create or replace function request_total_customer_price(p_request_id uuid)
returns numeric
language plpgsql
stable
security definer set search_path = public
as $$
declare
  v_request requests;
  v_supplements numeric;
begin
  select * into v_request from requests where id = p_request_id;
  if not found then
    return null;
  end if;

  if coalesce(auth.role(), '') <> 'service_role'
     and not coalesce(public.is_admin(), false)
     and auth.uid() is distinct from v_request.driver_id
     and auth.uid() is distinct from v_request.user_id then
    raise exception 'Not authorized to read this request''s economics' using errcode = '42501';
  end if;

  select coalesce(sum(s.amount), 0) into v_supplements
  from request_supplements s
  where s.request_id = p_request_id and s.status = 'approved';

  return round(coalesce(v_request.price_estimate, 0) + v_supplements, 2);
end;
$$;

revoke all on function request_total_customer_price(uuid) from public;
grant execute on function request_total_customer_price(uuid) to authenticated, service_role;

create or replace function request_total_provider_compensation(p_request_id uuid)
returns numeric
language plpgsql
stable
security definer set search_path = public
as $$
declare
  v_request requests;
  v_extra numeric;
begin
  select * into v_request from requests where id = p_request_id;
  if not found then
    return null;
  end if;

  if coalesce(auth.role(), '') <> 'service_role'
     and not coalesce(public.is_admin(), false)
     and auth.uid() is distinct from v_request.driver_id
     and auth.uid() is distinct from v_request.user_id
     and not coalesce(is_company_manager(driver_company_id(v_request.driver_id)), false) then
    raise exception 'Not authorized to read this request''s economics' using errcode = '42501';
  end if;

  if v_request.partner_amount is null then
    return null;
  end if;

  select coalesce(sum(e.amount), 0) into v_extra
  from provider_ledger_entries e
  where e.request_id = p_request_id
    and e.entry_type in ('supplement', 'adjustment', 'refund_reversal');

  return round(v_request.partner_amount + v_extra, 2);
end;
$$;

revoke all on function request_total_provider_compensation(uuid) from public;
grant execute on function request_total_provider_compensation(uuid) to authenticated, service_role;
