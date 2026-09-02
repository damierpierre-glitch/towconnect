'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { requireCapability, requireAnyCapability } from '@/lib/auth/capabilities';
import type {
  CoverageReportRow,
  FunnelStep,
  GoNoGoCriterion,
  OpsAlert,
  PartnerLink,
  PartnerPilotStatus,
  PartnerReadiness,
  PilotConfig,
  PilotCoverageArea,
  PilotGateAnswer,
  ReadinessItem,
  ReadinessStatus,
  SystemHealthComponent,
} from '@/lib/supabase/types';

// The pilot layer.
//
// Every function here passes a database answer through — none of them
// recompute readiness, coverage or health in TypeScript. The reason is the
// same one that shaped Phase 8: a screen that derives "are we ready" its own
// way will eventually disagree with the trigger that actually refuses a
// request, and the disagreeing version is the one nobody tests.

// ---------------------------------------------------------------- the gate

/**
 * What the pilot would do with a request from this person, at this point.
 *
 * Called before the customer confirms, so the answer is a sentence rather
 * than a failed submit. It is NOT the enforcement — a trigger on `requests`
 * is (0047). This is the courtesy; that is the control.
 */
export async function checkPilotGate(
  lat: number | null,
  lng: number | null
): Promise<PilotGateAnswer> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data, error } = await supabase.rpc('pilot_gate' as never, {
    p_profile_id: user?.id ?? null,
    p_lat: lat,
    p_lng: lng,
  } as never);

  // A gate that cannot be read must not become a refusal: the platform
  // behaves as it did before this phase rather than closing on a hiccup.
  if (error) return { allowed: true, reason: 'open', detail: null };
  const row = (data as PilotGateAnswer[] | null)?.[0];
  return row ?? { allowed: true, reason: 'open', detail: null };
}

/** Mode, territory and hours, for a customer-facing notice. Never the allowlist. */
export async function getPilotNotice(): Promise<{
  mode: PilotConfig['mode'];
  territoryLabel: string;
  hoursStart: string | null;
  hoursEnd: string | null;
  timezone: string;
  pausedReason: string | null;
} | null> {
  const supabase = await createClient();
  const { data } = await supabase
    .from('pilot_config')
    .select('mode, territory_label, hours_start, hours_end, timezone, paused_reason')
    .maybeSingle();
  if (!data) return null;
  return {
    mode: data.mode,
    territoryLabel: data.territory_label,
    hoursStart: data.hours_start,
    hoursEnd: data.hours_end,
    timezone: data.timezone,
    pausedReason: data.paused_reason,
  };
}

// ------------------------------------------------------------ the checklist

export async function getReadinessItems(): Promise<ReadinessItem[]> {
  await requireAnyCapability(['operations', 'finance', 'support', 'super_admin']);
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('launch_readiness_items')
    .select('*')
    .order('domain')
    .order('key');
  if (error) throw error;
  return data ?? [];
}

/**
 * Change one line of the checklist.
 *
 * There is no "mark everything ready" here, and there never should be. The
 * database refuses `ready` without evidence; this refuses it earlier so the
 * person gets a sentence rather than a constraint violation.
 */
export async function updateReadinessItem(input: {
  key: string;
  status: ReadinessStatus;
  evidence?: string | null;
  note?: string | null;
}): Promise<void> {
  await requireCapability('operations');
  if (input.status === 'ready' && !input.evidence?.trim()) {
    throw new Error('An item cannot be marked ready without evidence of how it was checked.');
  }
  if ((input.status === 'blocked' || input.status === 'not_applicable') && !input.note?.trim()) {
    throw new Error('Say why. A blocked or skipped item without a reason is a decision nobody can review.');
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from('launch_readiness_items')
    .update({
      status: input.status,
      evidence: input.evidence ?? null,
      note: input.note ?? null,
      last_reviewed_at: new Date().toISOString(),
    })
    .eq('key', input.key);
  if (error) throw error;
  revalidatePath('/dashboard/admin/operations/pilot');
}

// --------------------------------------------------------------- the switch

export async function getPilotConfig(): Promise<PilotConfig | null> {
  await requireAnyCapability(['operations', 'super_admin']);
  const supabase = await createClient();
  const { data, error } = await supabase.from('pilot_config').select('*').maybeSingle();
  if (error) throw error;
  return data;
}

export async function updatePilotConfig(input: {
  mode?: PilotConfig['mode'];
  hoursStart?: string | null;
  hoursEnd?: string | null;
  allowlistEnabled?: boolean;
  minReadyPartners?: number | null;
  pausedReason?: string | null;
}): Promise<void> {
  const userId = await requireCapability('operations');
  if (input.mode === 'paused' && !input.pausedReason?.trim()) {
    throw new Error('Say why the pilot is paused. A pause with no reason is a pause nobody lifts.');
  }
  // Both or neither: half an hours window is a window that silently means
  // something different from what was typed.
  const start = input.hoursStart?.trim() || null;
  const end = input.hoursEnd?.trim() || null;
  if ((start === null) !== (end === null)) {
    throw new Error('Give both an opening and a closing time, or neither.');
  }

  const supabase = await createClient();
  const patch: Partial<PilotConfig> = {
    updated_at: new Date().toISOString(),
    updated_by: userId,
  };
  if (input.mode !== undefined) patch.mode = input.mode;
  if (input.hoursStart !== undefined || input.hoursEnd !== undefined) {
    patch.hours_start = start;
    patch.hours_end = end;
  }
  if (input.allowlistEnabled !== undefined) patch.allowlist_enabled = input.allowlistEnabled;
  if (input.minReadyPartners !== undefined) patch.min_ready_partners = input.minReadyPartners;
  if (input.pausedReason !== undefined) patch.paused_reason = input.pausedReason?.trim() ?? null;

  const { error } = await supabase.from('pilot_config').update(patch).eq('id', true);
  if (error) throw error;
  revalidatePath('/dashboard/admin/operations/pilot');
  revalidatePath('/request');
}

// -------------------------------------------------------------- the territory

export async function getCoverageAreas(): Promise<PilotCoverageArea[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('pilot_coverage_areas')
    .select('id, name, state, kind, center_lat, center_lng, radius_km, note, active, created_at, updated_at')
    .eq('active', true)
    .order('state')
    .order('name');
  if (error) throw error;
  return data ?? [];
}

/** Declared territory beside the capacity that actually reaches it. */
export async function getCoverageReport(): Promise<CoverageReportRow[]> {
  await requireAnyCapability(['operations', 'super_admin']);
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('pilot_coverage_report' as never, {} as never);
  if (error) throw error;
  return (data as CoverageReportRow[] | null) ?? [];
}

// --------------------------------------------------------------- the partners

export async function getPartnerReadiness(): Promise<PartnerReadiness[]> {
  await requireAnyCapability(['operations', 'finance', 'super_admin']);
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('pilot_partner_readiness' as never, {} as never);
  if (error) throw error;
  return (data as PartnerReadiness[] | null) ?? [];
}

/**
 * Move a company through the pilot rollout.
 *
 * Commercial only. It does not approve them to operate (that is
 * companies.status), it does not make a truck available (that is
 * driver_profiles.is_online), and dispatch never reads it.
 */
export async function setPartnerPilotStatus(input: {
  companyId: string;
  status: PartnerPilotStatus;
  note?: string | null;
}): Promise<void> {
  await requireCapability('operations');
  const supabase = await createClient();
  const { error } = await supabase
    .from('companies')
    .update({ pilot_status: input.status, pilot_status_note: input.note ?? null })
    .eq('id', input.companyId);
  if (error) throw error;
  revalidatePath('/dashboard/admin/operations/pilot');
}

// ---------------------------------------------------------------- monitoring

export async function getSystemHealth(): Promise<SystemHealthComponent[]> {
  await requireAnyCapability(['operations', 'super_admin']);
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('ops_system_health' as never, {} as never);
  if (error) throw error;
  return (data as SystemHealthComponent[] | null) ?? [];
}

export async function getAlerts(): Promise<OpsAlert[]> {
  await requireAnyCapability(['operations', 'super_admin']);
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('ops_alerts' as never, {} as never);
  if (error) throw error;
  return (data as OpsAlert[] | null) ?? [];
}

export async function getGoNoGo(): Promise<GoNoGoCriterion[]> {
  await requireAnyCapability(['operations', 'super_admin']);
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('pilot_go_no_go' as never, {} as never);
  if (error) throw error;
  return (data as GoNoGoCriterion[] | null) ?? [];
}

export async function getFunnel(from: string, to: string): Promise<FunnelStep[]> {
  await requireAnyCapability(['operations', 'finance', 'super_admin']);
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('funnel_summary' as never, {
    p_from: from,
    p_to: to,
  } as never);
  if (error) throw error;
  return (data as FunnelStep[] | null) ?? [];
}

// -------------------------------------------------------------- attribution

export async function listPartnerLinks(): Promise<PartnerLink[]> {
  await requireAnyCapability(['operations', 'super_admin']);
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('partner_links')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data ?? [];
}

/**
 * Create a code for a QR sticker, a partner page or a phone conversation.
 *
 * It measures where a request came from and does nothing else: no rate, no
 * discount, no payout. Making it mean money later would be a decision with
 * its own migration, not a quiet change of meaning here.
 */
export async function createPartnerLink(input: {
  code: string;
  label: string;
  kind: 'qr' | 'link' | 'manual';
  companyId?: string | null;
  note?: string | null;
}): Promise<void> {
  const userId = await requireCapability('operations');
  const code = input.code.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{2,31}$/.test(code)) {
    throw new Error('A code is 3 to 32 characters: lowercase letters, digits and hyphens.');
  }
  const supabase = await createClient();
  const { error } = await supabase.from('partner_links').insert({
    code,
    label: input.label.trim(),
    kind: input.kind,
    company_id: input.companyId ?? null,
    note: input.note ?? null,
    created_by: userId,
  });
  if (error) throw error;
  revalidatePath('/dashboard/admin/operations/pilot');
}

export async function setPartnerLinkActive(code: string, active: boolean): Promise<void> {
  await requireCapability('operations');
  const supabase = await createClient();
  const { error } = await supabase.from('partner_links').update({ active }).eq('code', code);
  if (error) throw error;
  revalidatePath('/dashboard/admin/operations/pilot');
}
