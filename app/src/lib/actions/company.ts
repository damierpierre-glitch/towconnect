'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import type {
  Company,
  CompanyMember,
  CompanyMemberRole,
  CompanyServiceArea,
  DriverVehicleAssignment,
  FleetVehicle,
  ServiceCapability,
  TowRequest,
  VehicleType,
} from '@/lib/supabase/types';

// No explicit "is this caller allowed?" check in this file, deliberately —
// the same reasoning as lib/actions/admin.ts. Every table touched here is
// gated by RLS through is_company_member() / is_company_manager() /
// is_company_owner_or_admin() (0024), so a caller who is not in the company
// gets zero rows or a policy violation, never a bypass. Re-checking here
// would be a second copy of the rule to keep in sync with the first.

export interface CompanyContext {
  company: Company;
  role: CompanyMemberRole;
}

// The company this user runs, if any. A user can hold several back-office
// memberships in principle; the business dashboard works on one at a time
// and this returns the first active one.
export async function getMyCompanyContext(): Promise<CompanyContext | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data, error } = await supabase
    .from('company_members')
    .select('role, companies!company_members_company_id_fkey(*)')
    .eq('profile_id', user.id)
    .eq('status', 'active')
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;

  const company = data.companies as unknown as Company | Company[] | null;
  const resolved = Array.isArray(company) ? company[0] : company;
  if (!resolved) return null;
  return { company: resolved, role: data.role as CompanyMemberRole };
}

export interface CompanyMemberRow extends CompanyMember {
  fullName: string;
  isOnline: boolean | null;
  approvalStatus: string | null;
}

export async function listCompanyMembers(companyId: string): Promise<CompanyMemberRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('company_members')
    .select('*, profiles!company_members_profile_id_fkey(full_name)')
    .eq('company_id', companyId)
    .order('role');
  if (error) throw error;

  const rows = data ?? [];
  const driverIds = rows.filter((r) => r.role === 'driver').map((r) => r.profile_id);

  // driver_profiles is readable here only for the company's own drivers, and
  // only because "driver_profiles: admins full access" / the driver's own
  // policy apply — a manager who is not an admin simply gets nothing back
  // for drivers outside their company, which is the intent.
  const availability = new Map<string, { is_online: boolean; approval_status: string }>();
  if (driverIds.length > 0) {
    const { data: profiles } = await supabase
      .from('driver_profiles')
      .select('profile_id, is_online, approval_status')
      .in('profile_id', driverIds);
    for (const p of profiles ?? []) {
      availability.set(p.profile_id, { is_online: p.is_online, approval_status: p.approval_status });
    }
  }

  return rows.map((row) => {
    const profile = row.profiles as unknown as { full_name: string } | { full_name: string }[] | null;
    const resolved = Array.isArray(profile) ? profile[0] : profile;
    const avail = availability.get(row.profile_id);
    return {
      ...row,
      fullName: resolved?.full_name || '—',
      isOnline: avail?.is_online ?? null,
      approvalStatus: avail?.approval_status ?? null,
    };
  });
}

// Adding a member is an owner/admin action. There is no self-join path: the
// insert policy requires is_company_owner_or_admin(company_id), so a driver
// calling this for someone else's company gets a policy violation.
export async function addCompanyMember(companyId: string, profileId: string, role: CompanyMemberRole) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');

  const { error } = await supabase.from('company_members').insert({
    company_id: companyId,
    profile_id: profileId,
    role,
    status: 'active',
    invited_by: user.id,
  });
  if (error) throw error;
  revalidatePath('/dashboard/business');
}

export async function removeCompanyMember(memberId: string) {
  const supabase = await createClient();
  const { error } = await supabase.from('company_members').delete().eq('id', memberId);
  if (error) throw error;
  revalidatePath('/dashboard/business');
}

// ---------------------------------------------------------------- fleet

export async function listFleetVehicles(companyId: string): Promise<FleetVehicle[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('fleet_vehicles')
    .select('*')
    .eq('company_id', companyId)
    .order('created_at');
  if (error) throw error;
  return data ?? [];
}

export interface FleetVehicleInput {
  label: string;
  truckType: VehicleType;
  plate: string;
  province: string;
  capabilities: ServiceCapability[];
}

export async function createFleetVehicle(companyId: string, input: FleetVehicleInput) {
  const supabase = await createClient();
  const { error } = await supabase.from('fleet_vehicles').insert({
    company_id: companyId,
    label: input.label.trim() || null,
    truck_type: input.truckType,
    plate: input.plate.trim() || null,
    province: input.province.trim() || null,
    capabilities: input.capabilities,
  });
  if (error) throw error;
  revalidatePath('/dashboard/business');
}

export async function updateFleetVehicleCapabilities(vehicleId: string, capabilities: ServiceCapability[]) {
  const supabase = await createClient();
  const { error } = await supabase.from('fleet_vehicles').update({ capabilities }).eq('id', vehicleId);
  if (error) throw error;
  revalidatePath('/dashboard/business');
}

export async function setFleetVehicleStatus(vehicleId: string, status: FleetVehicle['status']) {
  const supabase = await createClient();
  const { error } = await supabase.from('fleet_vehicles').update({ status }).eq('id', vehicleId);
  if (error) throw error;
  revalidatePath('/dashboard/business');
}

export async function listVehicleAssignments(companyId: string): Promise<DriverVehicleAssignment[]> {
  const supabase = await createClient();
  const { data: vehicles } = await supabase.from('fleet_vehicles').select('id').eq('company_id', companyId);
  const ids = (vehicles ?? []).map((v) => v.id);
  if (ids.length === 0) return [];

  const { data, error } = await supabase
    .from('driver_vehicle_assignments')
    .select('*')
    .in('fleet_vehicle_id', ids)
    .eq('active', true);
  if (error) throw error;
  return data ?? [];
}

// A driver never calls this — the RLS policy is manager-only, and a trigger
// additionally refuses any pairing where the driver is not an active driver
// of the vehicle's own company (0024). Both checks are server-side; this
// function is just the UI's way of asking.
export async function assignDriverToVehicle(fleetVehicleId: string, driverId: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');

  // One active assignment per driver and per truck are unique indexes, so
  // close the previous ones first rather than colliding with them.
  await supabase
    .from('driver_vehicle_assignments')
    .update({ active: false, ended_at: new Date().toISOString() })
    .eq('driver_id', driverId)
    .eq('active', true);
  await supabase
    .from('driver_vehicle_assignments')
    .update({ active: false, ended_at: new Date().toISOString() })
    .eq('fleet_vehicle_id', fleetVehicleId)
    .eq('active', true);

  const { error } = await supabase.from('driver_vehicle_assignments').insert({
    fleet_vehicle_id: fleetVehicleId,
    driver_id: driverId,
    assigned_by: user.id,
    active: true,
  });
  if (error) throw error;
  revalidatePath('/dashboard/business');
}

export async function unassignVehicle(assignmentId: string) {
  const supabase = await createClient();
  const { error } = await supabase
    .from('driver_vehicle_assignments')
    .update({ active: false, ended_at: new Date().toISOString() })
    .eq('id', assignmentId);
  if (error) throw error;
  revalidatePath('/dashboard/business');
}

// ------------------------------------------------------- service areas

export async function listServiceAreas(companyId: string): Promise<CompanyServiceArea[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('company_service_areas')
    .select('*')
    .eq('company_id', companyId)
    .order('created_at');
  if (error) throw error;
  return data ?? [];
}

// Radius areas only from this UI. Polygons are supported by the schema and
// by company_covers_point(), but drawing one needs a map editor that is not
// part of this phase — entering a polygon by hand would be a good way to
// produce a wrong boundary.
export async function createRadiusServiceArea(
  companyId: string,
  input: { name: string; lat: number; lng: number; radiusKm: number }
) {
  const supabase = await createClient();
  const { error } = await supabase.from('company_service_areas').insert({
    company_id: companyId,
    name: input.name.trim(),
    kind: 'radius',
    center_lat: input.lat,
    center_lng: input.lng,
    radius_km: input.radiusKm,
  });
  if (error) throw error;
  revalidatePath('/dashboard/business');
}

export async function setServiceAreaActive(areaId: string, active: boolean) {
  const supabase = await createClient();
  const { error } = await supabase.from('company_service_areas').update({ active }).eq('id', areaId);
  if (error) throw error;
  revalidatePath('/dashboard/business');
}

// -------------------------------------------------------------- jobs

// The company's work, resolved through its own drivers. RLS on `requests`
// only ever exposes a request to its rider, its assigned driver or an admin
// — a dispatcher is none of those — so this deliberately reads the rows the
// company's drivers can see rather than trying to widen that policy. In
// practice the dispatcher view is built from the driver roster, which is
// what a dispatcher actually manages.
export async function listCompanyJobs(companyId: string, limit = 40): Promise<TowRequest[]> {
  const supabase = await createClient();
  const { data: members } = await supabase
    .from('company_members')
    .select('profile_id')
    .eq('company_id', companyId)
    .eq('role', 'driver')
    .eq('status', 'active');
  const driverIds = (members ?? []).map((m) => m.profile_id);
  if (driverIds.length === 0) return [];

  const { data, error } = await supabase
    .from('requests')
    .select('*')
    .in('driver_id', driverIds)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data ?? [];
}
