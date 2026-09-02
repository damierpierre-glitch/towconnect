-- TowConnect — Phase 6.1: let a boundary be looked at before it is trusted.
-- Additive, run after 0031.
--
-- A derived geometry is a claim about where the law applies. The Phase 6 admin
-- screen showed the claim's provenance — source, confidence, verification date
-- — but not the claim itself, so the only way to check whether a polygon
-- actually followed the right stretch of highway was to read the SQL. This
-- returns the boundary as GeoJSON so it can be put on a map next to its
-- source, which is what "inspect before activating" has to mean.
--
-- Simplified to ~5 m for transport: enough to see the shape and where it
-- starts and stops, small enough to send fifteen of them to a browser. The
-- stored geometry is untouched — this is a view of it, not a replacement.
--
-- Inactive zones are readable by admins only, matching the RLS policy on the
-- table. That is deliberate rather than incidental: an unactivated boundary is
-- exactly the thing an admin needs to see and a customer must not.
create or replace function regulated_zone_geojson(p_zone_id uuid)
returns jsonb
language sql
stable
security definer set search_path = public
as $fn$
  select jsonb_build_object(
    'type', 'Feature',
    'properties', jsonb_build_object(
      'zone_code', z.zone_code,
      'official_name', z.official_name,
      'active', z.active,
      'geometry_confidence', z.geometry_confidence
    ),
    'geometry', ST_AsGeoJSON(ST_SimplifyPreserveTopology(z.geometry::geometry, 0.00005))::jsonb,
    'bbox', to_jsonb(array[
      ST_XMin(z.geometry::geometry), ST_YMin(z.geometry::geometry),
      ST_XMax(z.geometry::geometry), ST_YMax(z.geometry::geometry)
    ])
  )
  from regulated_towing_zones z
  where z.id = p_zone_id
    and z.geometry is not null
    and (z.active or public.is_admin())
$fn$;

revoke all on function regulated_zone_geojson(uuid) from public;
grant execute on function regulated_zone_geojson(uuid) to authenticated, service_role;

comment on function regulated_zone_geojson(uuid) is
  'Phase 6.1. A zone boundary as GeoJSON so it can be LOOKED AT before it is trusted. Inactive '
  'zones are visible to admins only, which is the point: a derived geometry has to be inspectable '
  'before activation.';
