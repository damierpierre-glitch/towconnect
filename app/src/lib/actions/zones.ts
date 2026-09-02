'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import type {
  DispatchCandidateExplanation,
  RegulatedTowingZone,
  RegulatedZoneProvider,
  ZoneAuthorizationStatus,
} from '@/lib/supabase/types';

// Enforcement is RLS ("regulated zones: admins full access", 0023), same as
// lib/actions/admin.ts. Every write here also goes through the audit trigger,
// which no role — admin included — has a policy to delete from.

export interface ZoneWithProviders extends RegulatedTowingZone {
  providers: RegulatedZoneProvider[];
}

export async function listRegulatedZones(): Promise<ZoneWithProviders[]> {
  const supabase = await createClient();
  // geometry is excluded on purpose: PostgREST serializes a PostGIS
  // geography as a long opaque hex string that nothing in the UI can use.
  // Whether a zone HAS a geometry is what matters, and geometry_confidence
  // already says so.
  const { data: zones, error } = await supabase
    .from('regulated_towing_zones')
    // One literal, not a concatenation: supabase-js infers the row shape from
    // the string itself, and `a` + `b` collapses to plain `string`.
    .select('id, country, province, jurisdiction, official_name, zone_code, restriction_type, dispatch_mode, geometry_confidence, geometry_note, source_url, source_title, effective_from, effective_to, last_verified_at, active, user_instruction_fr, user_instruction_en, authority_phone, precedence, created_at, updated_at')
    .order('province')
    .order('precedence');
  if (error) throw error;

  const { data: providers, error: provError } = await supabase
    .from('regulated_zone_providers')
    .select('*')
    .order('priority');
  if (provError) throw provError;

  return (zones ?? []).map((z) => ({
    ...(z as RegulatedTowingZone),
    providers: (providers ?? []).filter((p) => p.zone_id === z.id),
  }));
}

// Activating a zone is refused by a CHECK constraint unless it has a real
// geometry with a stated provenance (0023). This surfaces that as a readable
// message instead of a raw constraint error, because "you cannot switch on a
// zone that has no boundary" is the actual product rule, not a database
// accident.
export async function setZoneActive(zoneId: string, active: boolean) {
  const supabase = await createClient();
  const { error } = await supabase.from('regulated_towing_zones').update({ active }).eq('id', zoneId);
  if (error) {
    if (/regulated_zone_active_requires_geometry/.test(error.message)) {
      throw new Error(
        'This zone has no verified boundary yet. A zone cannot gate service until a real geometry ' +
          'and its provenance are attached — see the geometry note.'
      );
    }
    throw error;
  }
  revalidatePath('/dashboard/admin/zones');
}

// Re-verification is a first-class action: the point of last_verified_at is
// that somebody looked at the official source on a date, not that the row
// exists.
export async function markZoneVerified(zoneId: string) {
  const supabase = await createClient();
  const { error } = await supabase
    .from('regulated_towing_zones')
    .update({ last_verified_at: new Date().toISOString() })
    .eq('id', zoneId);
  if (error) throw error;
  revalidatePath('/dashboard/admin/zones');
}

// Links an officially-named operator to an actual TowConnect company. This
// is the only way a company becomes dispatchable inside a regulated zone,
// and it is an admin action backed by the source recorded on the row — never
// something a company can grant itself.
export async function linkProviderToCompany(providerId: string, companyId: string | null) {
  const supabase = await createClient();
  const { error } = await supabase
    .from('regulated_zone_providers')
    .update({ company_id: companyId })
    .eq('id', providerId);
  if (error) throw error;
  revalidatePath('/dashboard/admin/zones');
}

export async function setProviderAuthorizationStatus(providerId: string, status: ZoneAuthorizationStatus) {
  const supabase = await createClient();
  const { error } = await supabase
    .from('regulated_zone_providers')
    .update({
      authorization_status: status,
      last_verified_at: new Date().toISOString(),
    })
    .eq('id', providerId);
  if (error) throw error;
  revalidatePath('/dashboard/admin/zones');
}

export interface ZoneAuditEntry {
  id: number;
  table_name: string;
  row_id: string;
  action: string;
  actor_id: string | null;
  created_at: string;
}

export async function listZoneAudit(limit = 50): Promise<ZoneAuditEntry[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('regulated_zone_audit' as never)
    .select('id, table_name, row_id, action, actor_id, created_at')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as unknown as ZoneAuditEntry[];
}

// Why dispatch chose (or refused) each driver for a request. Admin-only,
// enforced inside the function itself as well as by this call site.
export async function explainDispatch(requestId: string): Promise<DispatchCandidateExplanation[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('explain_dispatch_candidates', { p_request_id: requestId });
  if (error) throw error;
  return (data ?? []) as DispatchCandidateExplanation[];
}
