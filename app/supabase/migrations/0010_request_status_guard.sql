-- TowConnect — Phase 3: server-side guard on the driver-facing status
-- progression (matched -> en_route -> arrived -> in_progress -> completed).
-- Additive, run after 0009_in_progress_status.sql.
--
-- Before this migration, "requests: assigned driver updates" (0001) allowed
-- the assigned driver to set requests.status to ANY value via a plain
-- UPDATE — advanceRequestStatus() in the app only ever sent an adjacent
-- next status, but nothing in the database enforced that. A driver's own
-- session (or anyone replaying/forging the same RPC call) could otherwise
-- jump straight from 'matched' to 'completed', or move a request backwards.
create or replace function guard_request_status_transition()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  v_next_allowed request_status;
begin
  if new.status is distinct from old.status
     and auth.uid() = old.driver_id
     and auth.role() <> 'service_role' then

    -- pending -> matched is accept_request()'s job (Phase 2), already
    -- atomic and guarded there (one-active-job unique index, driver_id +
    -- status predicate) — this trigger only governs what comes *after* a
    -- match, so it steps aside for that specific transition.
    if old.status = 'pending' then
      return new;
    end if;

    v_next_allowed := case old.status
      when 'matched' then 'en_route'
      when 'en_route' then 'arrived'
      when 'arrived' then 'in_progress'
      when 'in_progress' then 'completed'
      else null
    end;

    if v_next_allowed is null or new.status <> v_next_allowed then
      raise exception 'Cannot move request % from % directly to % — only % -> % is allowed from here',
        old.id, old.status, new.status, old.status, coalesce(v_next_allowed::text, '(nothing)')
        using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

create trigger requests_guard_status_transition
  before update on requests
  for each row execute procedure guard_request_status_transition();
