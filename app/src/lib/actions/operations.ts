'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import type {
  AdminCapability,
  PaymentStatus,
  RequestStatus,
  AttentionItem,
  CompanyHealthRow,
  DispatchCandidateRow,
  DriverOpsRow,
  IncidentEvent,
  IncidentSeverity,
  IncidentStatus,
  IncidentType,
  LiveMapEntity,
  OperationalIncident,
  OpsKpis,
  ReconciliationException,
  RequestTimelineEntry,
  RiskFlag,
  TowRequest,
} from '@/lib/supabase/types';

// The operations command centre.
//
// ONE RULE RUNS THROUGH ALL OF THIS
// Nothing here computes an operational fact for itself. The attention queue,
// the KPIs, the reconciliation exceptions and the live map are all database
// functions (0041, 0042), and these actions only pass them through. A
// dashboard that derives "requests needing attention" its own way will
// eventually disagree with what dispatch actually did — and the disagreeing
// version is the one nobody tests.
//
// AUTHORIZATION
// Every function below is guarded IN THE DATABASE by has_admin_capability(),
// null-safely (0039). The checks in this file exist so the UI can hide what a
// user cannot do; they are not the protection. An operator with no grants at
// all keeps full access — see the grandfather rule in 0041.

async function requireCapability(capability: AdminCapability): Promise<string> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');

  const { data, error } = await supabase.rpc('has_admin_capability' as never, {
    p_capability: capability,
  } as never);
  if (error) throw error;
  if (data !== true) {
    throw new Error(`This action needs the "${capability}" capability.`);
  }
  return user.id;
}

/** What the signed-in admin may do. Used to decide what to render, not what to allow. */
export async function getMyCapabilities(): Promise<{
  isAdmin: boolean;
  operations: boolean;
  finance: boolean;
  support: boolean;
  superAdmin: boolean;
  scoped: boolean;
}> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { isAdmin: false, operations: false, finance: false, support: false, superAdmin: false, scoped: false };
  }

  const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single();
  if (profile?.role !== 'admin') {
    return { isAdmin: false, operations: false, finance: false, support: false, superAdmin: false, scoped: false };
  }

  const [operations, finance, support, superAdmin, grants] = await Promise.all([
    supabase.rpc('has_admin_capability' as never, { p_capability: 'operations' } as never),
    supabase.rpc('has_admin_capability' as never, { p_capability: 'finance' } as never),
    supabase.rpc('has_admin_capability' as never, { p_capability: 'support' } as never),
    supabase.rpc('has_admin_capability' as never, { p_capability: 'super_admin' } as never),
    supabase.from('admin_grants').select('capability').eq('profile_id', user.id),
  ]);

  return {
    isAdmin: true,
    operations: operations.data === true,
    finance: finance.data === true,
    support: support.data === true,
    superAdmin: superAdmin.data === true,
    // Whether anybody has narrowed this account yet. An unscoped admin sees
    // everything; the UI says so rather than implying the grants are real.
    scoped: (grants.data ?? []).length > 0,
  };
}

// ---------------------------------------------------------------- the queue

export async function getAttentionQueue(): Promise<AttentionItem[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('ops_attention_queue' as never, {} as never);
  if (error) throw error;
  return (data ?? []) as unknown as AttentionItem[];
}

export interface OperationsSnapshot {
  activeRequests: number;
  pendingRequests: number;
  openOffers: number;
  driversOnline: number;
  driversStale: number;
  regulatedActive: number;
  paymentsNeedingAttention: number;
  refundsInFlight: number;
  supplementsUncollected: number;
  payoutsAwaiting: number;
  openIncidents: number;
}

/**
 * The counts on the command centre header.
 *
 * Each one is a count of something a person acts on. There is no "total
 * requests ever" here on purpose: a number that only ever goes up tells an
 * operator nothing about their shift.
 */
export async function getOperationsSnapshot(): Promise<OperationsSnapshot> {
  await requireCapability('operations');
  const admin = createAdminClient();

  // The stale window is the dispatch engine's own: a driver it will not offer
  // work to is a driver operations should not count as online.
  const staleWindow = new Date(Date.now() - 120_000).toISOString();
  const now = new Date().toISOString();
  const ACTIVE: RequestStatus[] = ['matched', 'en_route', 'arrived', 'in_progress'];

  const [
    active,
    pending,
    offers,
    online,
    stale,
    regulated,
    payments,
    refunds,
    supplements,
    payouts,
    incidents,
  ] = await Promise.all([
    admin.from('requests').select('id', { count: 'exact', head: true }).in('status', ACTIVE),
    admin.from('requests').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
    admin
      .from('dispatch_offers')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'offered')
      .gt('expires_at', now),
    admin
      .from('driver_profiles')
      .select('profile_id', { count: 'exact', head: true })
      .eq('is_online', true)
      .gte('last_heartbeat_at', staleWindow),
    admin
      .from('driver_profiles')
      .select('profile_id', { count: 'exact', head: true })
      .eq('is_online', true)
      .lt('last_heartbeat_at', staleWindow),
    admin
      .from('requests')
      .select('id', { count: 'exact', head: true })
      .in('status', [...ACTIVE, 'pending'] as RequestStatus[])
      .not('regulated_zone_id', 'is', null),
    admin
      .from('payments')
      .select('id', { count: 'exact', head: true })
      .in('status', ['failed', 'requires_action', 'requires_payment_method'] as PaymentStatus[]),
    admin.from('refunds').select('id', { count: 'exact', head: true }).in('status', ['pending', 'failed']),
    admin
      .from('request_supplements')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'approved')
      .eq('payment_state', 'uncollected'),
    admin.from('provider_payouts').select('id', { count: 'exact', head: true }).in('state', ['pending', 'held']),
    admin
      .from('operational_incidents')
      .select('id', { count: 'exact', head: true })
      .in('status', ['open', 'investigating']),
  ]);

  return {
    activeRequests: active.count ?? 0,
    pendingRequests: pending.count ?? 0,
    openOffers: offers.count ?? 0,
    driversOnline: online.count ?? 0,
    driversStale: stale.count ?? 0,
    regulatedActive: regulated.count ?? 0,
    paymentsNeedingAttention: payments.count ?? 0,
    refundsInFlight: refunds.count ?? 0,
    supplementsUncollected: supplements.count ?? 0,
    payoutsAwaiting: payouts.count ?? 0,
    openIncidents: incidents.count ?? 0,
  };
}

// ---------------------------------------------------------------- KPIs

export async function getOpsKpis(days = 30): Promise<OpsKpis | null> {
  const supabase = await createClient();
  const to = new Date();
  const from = new Date(to.getTime() - days * 86_400_000);
  const { data, error } = await supabase.rpc('ops_kpis' as never, {
    p_from: from.toISOString(),
    p_to: to.toISOString(),
  } as never);
  if (error) throw error;
  const row = (data as OpsKpis[] | null)?.[0];
  return row ?? null;
}

export async function getReconciliationExceptions(): Promise<ReconciliationException[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('ops_reconciliation_exceptions' as never, {} as never);
  if (error) throw error;
  return (data ?? []) as unknown as ReconciliationException[];
}

// ---------------------------------------------------------------- live map

export async function getLiveMap(bounds: {
  minLat: number;
  minLng: number;
  maxLat: number;
  maxLng: number;
}): Promise<LiveMapEntity[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('ops_live_map' as never, {
    p_min_lat: bounds.minLat,
    p_min_lng: bounds.minLng,
    p_max_lat: bounds.maxLat,
    p_max_lng: bounds.maxLng,
  } as never);
  if (error) throw error;
  return (data ?? []) as unknown as LiveMapEntity[];
}

// ---------------------------------------------------------------- jobs

export interface JobFilters {
  status?: RequestStatus[];
  province?: string | null;
  companyId?: string | null;
  driverId?: string | null;
  problemType?: string | null;
  regulatedOnly?: boolean;
  olderThanMinutes?: number | null;
}

export interface JobRow extends TowRequest {
  /** Seconds since the request was created. Sorting key for urgency. */
  ageSeconds: number;
  driverName: string | null;
  companyName: string | null;
  hasOpenIncident: boolean;
}

/**
 * The active job list, ordered by operational urgency rather than by date.
 *
 * "Newest first" is the wrong order for this screen: the request that has been
 * waiting longest with nobody assigned is the one that needs somebody, and it
 * is the oldest row. Urgency here means: unmatched first, then longest waiting.
 */
export async function listJobs(filters: JobFilters = {}, limit = 100): Promise<JobRow[]> {
  await requireCapability('operations');
  const admin = createAdminClient();

  let query = admin.from('requests').select('*').order('created_at', { ascending: true }).limit(limit);

  const statuses = (filters.status?.length
    ? filters.status
    : ['pending', 'matched', 'en_route', 'arrived', 'in_progress']) as RequestStatus[];
  query = query.in('status', statuses);

  if (filters.driverId) query = query.eq('driver_id', filters.driverId);
  if (filters.problemType) query = query.eq('problem_type', filters.problemType);
  if (filters.regulatedOnly) query = query.not('regulated_zone_id', 'is', null);
  if (filters.olderThanMinutes) {
    query = query.lt('created_at', new Date(Date.now() - filters.olderThanMinutes * 60_000).toISOString());
  }

  const { data: requests, error } = await query;
  if (error) throw error;

  const driverIds = Array.from(
    new Set((requests ?? []).map((r) => r.driver_id).filter((id): id is string => Boolean(id)))
  );
  const requestIds = (requests ?? []).map((r) => r.id);

  const [{ data: drivers }, { data: incidents }] = await Promise.all([
    driverIds.length
      ? admin.from('profiles').select('id, full_name').in('id', driverIds)
      : Promise.resolve({ data: [] as { id: string; full_name: string }[] }),
    requestIds.length
      ? admin
          .from('operational_incidents')
          .select('request_id')
          .in('request_id', requestIds)
          .in('status', ['open', 'investigating'])
      : Promise.resolve({ data: [] as { request_id: string | null }[] }),
  ]);

  const companyByDriver = new Map<string, string | null>();
  for (const driverId of driverIds) {
    const { data: companyId } = await admin.rpc('driver_company_id' as never, {
      p_profile_id: driverId,
    } as never);
    companyByDriver.set(driverId, (companyId as unknown as string | null) ?? null);
  }
  const companyIds = Array.from(new Set([...companyByDriver.values()].filter((id): id is string => Boolean(id))));
  const { data: companies } = companyIds.length
    ? await admin.from('companies').select('id, name, display_name').in('id', companyIds)
    : { data: [] as { id: string; name: string; display_name: string | null }[] };

  const driverName = new Map((drivers ?? []).map((d) => [d.id, d.full_name]));
  const companyName = new Map((companies ?? []).map((c) => [c.id, c.display_name || c.name]));
  const incidentRequests = new Set((incidents ?? []).map((i) => i.request_id));

  const now = Date.now();
  const rows: JobRow[] = (requests ?? []).map((r) => {
    const companyId = r.driver_id ? companyByDriver.get(r.driver_id) ?? null : null;
    return {
      ...(r as TowRequest),
      ageSeconds: Math.round((now - new Date(r.created_at).getTime()) / 1000),
      driverName: r.driver_id ? driverName.get(r.driver_id) ?? null : null,
      companyName: companyId ? companyName.get(companyId) ?? null : null,
      hasOpenIncident: incidentRequests.has(r.id),
    };
  });

  const filtered = filters.companyId
    ? rows.filter((r) => r.companyName != null && companyName.get(filters.companyId!) === r.companyName)
    : rows;
  const byProvince = filters.province
    ? filtered.filter((r) => (r.location_text ?? '').toUpperCase().includes(filters.province!.toUpperCase()))
    : filtered;

  // Unassigned first, then oldest first. Both halves stay oldest-first, so the
  // top of the list is always the thing that has waited longest for a person.
  return byProvince.sort((a, b) => {
    const aUnassigned = a.status === 'pending' ? 0 : 1;
    const bUnassigned = b.status === 'pending' ? 0 : 1;
    if (aUnassigned !== bUnassigned) return aUnassigned - bUnassigned;
    return b.ageSeconds - a.ageSeconds;
  });
}

export interface JobDetail {
  request: TowRequest;
  customerName: string | null;
  customerEmail: string | null;
  driverName: string | null;
  companyName: string | null;
  timeline: RequestTimelineEntry[];
  offers: {
    id: string;
    driver_id: string;
    driverName: string | null;
    status: string;
    offered_at: string;
    expires_at: string;
    responded_at: string | null;
  }[];
  payment: { id: string; status: string; amount: number | string; stripe_payment_intent_id: string | null } | null;
  refunds: { id: string; amount: number | string; status: string; reason: string; created_at: string }[];
  supplements: { id: string; type_key: string; amount: number | string; status: string; payment_state: string }[];
  ledger: { id: number; entry_type: string; amount: number | string; available_at: string | null; created_at: string }[];
  incidents: OperationalIncident[];
  zone: { id: string; official_name: string; zone_code: string | null; province: string } | null;
}

export async function getJobDetail(requestId: string): Promise<JobDetail> {
  await requireCapability('operations');
  const admin = createAdminClient();

  const { data: request, error } = await admin.from('requests').select('*').eq('id', requestId).single();
  if (error) throw error;

  const [
    { data: customer },
    { data: driver },
    { data: events },
    { data: offers },
    { data: payment },
    { data: refunds },
    { data: supplements },
    { data: ledger },
    { data: incidents },
    { data: zone },
  ] = await Promise.all([
    admin.from('profiles').select('full_name').eq('id', request.user_id).maybeSingle(),
    request.driver_id
      ? admin.from('profiles').select('full_name').eq('id', request.driver_id).maybeSingle()
      : Promise.resolve({ data: null }),
    admin.from('request_events').select('status, created_at').eq('request_id', requestId).order('created_at'),
    admin.from('dispatch_offers').select('*').eq('request_id', requestId).order('offered_at'),
    admin
      .from('payments')
      .select('id, status, amount, stripe_payment_intent_id')
      .eq('request_id', requestId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    admin.from('refunds').select('id, amount, status, reason, created_at').eq('request_id', requestId),
    admin
      .from('request_supplements')
      .select('id, type_key, amount, status, payment_state')
      .eq('request_id', requestId),
    admin
      .from('provider_ledger_entries')
      .select('id, entry_type, amount, available_at, created_at')
      .eq('request_id', requestId)
      .order('id'),
    admin.from('operational_incidents').select('*').eq('request_id', requestId).order('created_at', { ascending: false }),
    request.regulated_zone_id
      ? admin
          .from('regulated_towing_zones')
          .select('id, official_name, zone_code, province')
          .eq('id', request.regulated_zone_id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  const offerDriverIds = Array.from(new Set((offers ?? []).map((o) => o.driver_id)));
  const { data: offerDrivers } = offerDriverIds.length
    ? await admin.from('profiles').select('id, full_name').in('id', offerDriverIds)
    : { data: [] as { id: string; full_name: string }[] };
  const offerDriverName = new Map((offerDrivers ?? []).map((d) => [d.id, d.full_name]));

  let companyName: string | null = null;
  if (request.driver_id) {
    const { data: companyId } = await admin.rpc('driver_company_id' as never, {
      p_profile_id: request.driver_id,
    } as never);
    if (companyId) {
      const { data: company } = await admin
        .from('companies')
        .select('name, display_name')
        .eq('id', companyId as unknown as string)
        .maybeSingle();
      companyName = company ? company.display_name || company.name : null;
    }
  }

  // The customer's email lives on auth.users, not on profiles — reachable only
  // with the service role, and only shown to staff who can already see the job.
  let customerEmail: string | null = null;
  try {
    const { data: authUser } = await admin.auth.admin.getUserById(request.user_id);
    customerEmail = authUser.user?.email ?? null;
  } catch {
    // A deleted account leaves the request behind; the job is still auditable.
  }

  return {
    request: request as TowRequest,
    customerName: customer?.full_name ?? null,
    customerEmail,
    driverName: driver?.full_name ?? null,
    companyName,
    timeline: (events ?? []) as RequestTimelineEntry[],
    offers: (offers ?? []).map((o) => ({
      id: o.id,
      driver_id: o.driver_id,
      driverName: offerDriverName.get(o.driver_id) ?? null,
      status: o.status,
      offered_at: o.offered_at,
      expires_at: o.expires_at,
      responded_at: o.responded_at ?? null,
    })),
    payment: payment ?? null,
    refunds: refunds ?? [],
    supplements: (supplements ?? []) as JobDetail['supplements'],
    ledger: ledger ?? [],
    incidents: (incidents ?? []) as OperationalIncident[],
    zone: zone ?? null,
  };
}

/**
 * Why each driver was or was not offered this request.
 *
 * Calls explain_dispatch_candidates(), which runs the SAME query the engine
 * uses to pick a driver (0026). A second implementation here would be a second
 * opinion, and the one on screen would be the one nobody could trust.
 */
export async function explainDispatch(requestId: string): Promise<DispatchCandidateRow[]> {
  await requireCapability('operations');
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('explain_dispatch_candidates', { p_request_id: requestId });
  if (error) throw error;
  return (data ?? []) as unknown as DispatchCandidateRow[];
}

// ---------------------------------------------------------------- incidents

export async function listIncidents(status?: IncidentStatus[]): Promise<OperationalIncident[]> {
  const supabase = await createClient();
  let query = supabase.from('operational_incidents').select('*').order('created_at', { ascending: false }).limit(200);
  if (status?.length) query = query.in('status', status);
  const { data, error } = await query;
  if (error) throw error;
  return data ?? [];
}

export async function getIncidentEvents(incidentId: string): Promise<IncidentEvent[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('incident_events')
    .select('*')
    .eq('incident_id', incidentId)
    .order('created_at');
  if (error) throw error;
  return data ?? [];
}

export async function openIncident(input: {
  type: IncidentType;
  severity: IncidentSeverity;
  title: string;
  description?: string | null;
  requestId?: string | null;
  companyId?: string | null;
  driverId?: string | null;
  paymentId?: string | null;
}): Promise<OperationalIncident> {
  const actorId = await requireCapability('operations');
  const supabase = await createClient();

  const { data, error } = await supabase
    .from('operational_incidents')
    .insert({
      type: input.type,
      severity: input.severity,
      title: input.title.trim(),
      description: input.description?.trim() || null,
      request_id: input.requestId ?? null,
      company_id: input.companyId ?? null,
      driver_id: input.driverId ?? null,
      payment_id: input.paymentId ?? null,
      created_by: actorId,
    })
    .select('*')
    .single();
  if (error) throw error;

  revalidatePath('/dashboard/admin/operations');
  return data;
}

/**
 * Move an incident along. The status trigger writes the history, so nothing
 * here records it a second time — one writer, one story.
 */
export async function setIncidentStatus(
  incidentId: string,
  status: IncidentStatus,
  resolutionNote?: string
): Promise<void> {
  await requireCapability('operations');
  const supabase = await createClient();
  const { error } = await supabase
    .from('operational_incidents')
    .update({ status, resolution_note: resolutionNote?.trim() || null })
    .eq('id', incidentId);
  if (error) throw error;
  revalidatePath('/dashboard/admin/operations/incidents');
}

export async function assignIncident(incidentId: string, adminId: string | null): Promise<void> {
  await requireCapability('operations');
  const supabase = await createClient();
  const { error } = await supabase
    .from('operational_incidents')
    .update({ assigned_admin: adminId })
    .eq('id', incidentId);
  if (error) throw error;
  revalidatePath('/dashboard/admin/operations/incidents');
}

// ---------------------------------------------------------------- risk

export async function listRiskFlags(includeAcknowledged = false): Promise<RiskFlag[]> {
  const supabase = await createClient();
  let query = supabase.from('risk_flags').select('*').order('created_at', { ascending: false }).limit(100);
  if (!includeAcknowledged) query = query.is('acknowledged_at', null);
  const { data, error } = await query;
  if (error) throw error;
  return data ?? [];
}

export async function acknowledgeRiskFlag(flagId: number, note?: string): Promise<void> {
  const actorId = await requireCapability('operations');
  const supabase = await createClient();
  const { error } = await supabase
    .from('risk_flags')
    .update({ acknowledged_at: new Date().toISOString(), acknowledged_by: actorId, note: note ?? null })
    .eq('id', flagId);
  if (error) throw error;
  revalidatePath('/dashboard/admin/operations/incidents');
}

/**
 * Recompute the objective risk signals.
 *
 * Counting, nothing more. No score, no model, no automatic consequence — each
 * flag is a reason for a person to look, and it carries the numbers it was
 * derived from so that person can disagree with it.
 *
 * Windows are stated inline rather than configured: they are the definition of
 * the signal, not a tunable, and hiding them in a table would make the flag
 * harder to argue with rather than easier.
 */
export async function refreshRiskSignals(): Promise<{ created: number }> {
  const actorId = await requireCapability('operations');
  const admin = createAdminClient();
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  let created = 0;

  const record = async (
    kind: RiskFlag['kind'],
    profileId: string,
    observation: Record<string, unknown>
  ) => {
    // One open flag of a kind per subject: re-running this must not bury an
    // operator in duplicates of the same observation.
    const { data: existing } = await admin
      .from('risk_flags')
      .select('id')
      .eq('kind', kind)
      .eq('subject_profile_id', profileId)
      .is('acknowledged_at', null)
      .maybeSingle();
    if (existing) return;
    await admin.from('risk_flags').insert({
      kind,
      subject_profile_id: profileId,
      observation,
      created_by: actorId,
    } as never);
    created += 1;
  };

  // Customers refunded more than twice in thirty days.
  const { data: refunds } = await admin
    .from('refunds')
    .select('request_id')
    .eq('status', 'succeeded')
    .gte('created_at', since);
  if (refunds?.length) {
    const { data: refundRequests } = await admin
      .from('requests')
      .select('id, user_id')
      .in('id', refunds.map((r) => r.request_id));
    const byUser = new Map<string, number>();
    for (const r of refundRequests ?? []) byUser.set(r.user_id, (byUser.get(r.user_id) ?? 0) + 1);
    for (const [userId, count] of byUser) {
      if (count > 2) await record('repeated_refunds', userId, { count, window_days: 30 });
    }
  }

  // Customers who cancelled more than three requests in thirty days.
  const { data: cancelled } = await admin
    .from('requests')
    .select('user_id')
    .eq('status', 'cancelled')
    .gte('created_at', since);
  const cancelByUser = new Map<string, number>();
  for (const r of cancelled ?? []) cancelByUser.set(r.user_id, (cancelByUser.get(r.user_id) ?? 0) + 1);
  for (const [userId, count] of cancelByUser) {
    if (count > 3) await record('repeated_cancellations', userId, { count, window_days: 30 });
  }

  // Customers with more than two failed payments in thirty days.
  const { data: failed } = await admin
    .from('payments')
    .select('request_id')
    .eq('status', 'failed')
    .gte('created_at', since);
  if (failed?.length) {
    const { data: failedRequests } = await admin
      .from('requests')
      .select('id, user_id')
      .in('id', failed.map((p) => p.request_id));
    const failByUser = new Map<string, number>();
    for (const r of failedRequests ?? []) failByUser.set(r.user_id, (failByUser.get(r.user_id) ?? 0) + 1);
    for (const [userId, count] of failByUser) {
      if (count > 2) await record('repeated_payment_failures', userId, { count, window_days: 30 });
    }
  }

  revalidatePath('/dashboard/admin/operations/incidents');
  return { created };
}

// ---------------------------------------------------------------- directory

export async function listCompanyHealth(): Promise<CompanyHealthRow[]> {
  await requireCapability('operations');
  const admin = createAdminClient();
  const staleWindow = new Date(Date.now() - 120_000).toISOString();

  const { data: companies } = await admin
    .from('companies')
    .select('id, name, display_name, status, province, connect_status, connect_payouts_enabled')
    .order('name');

  const rows: CompanyHealthRow[] = [];
  for (const company of companies ?? []) {
    const [{ data: members }, { data: vehicles }, { data: areas }, { data: zoneAuth }, { data: incidents }] =
      await Promise.all([
        admin.from('company_members').select('profile_id, role').eq('company_id', company.id).eq('status', 'active'),
        admin.from('fleet_vehicles').select('id').eq('company_id', company.id),
        admin.from('company_service_areas').select('id').eq('company_id', company.id),
        admin.from('regulated_zone_providers').select('id, authorization_status').eq('company_id', company.id),
        admin
          .from('operational_incidents')
          .select('id')
          .eq('company_id', company.id)
          .in('status', ['open', 'investigating']),
      ]);

    const driverIds = (members ?? []).filter((m) => m.role === 'driver').map((m) => m.profile_id);
    const { data: driverProfiles } = driverIds.length
      ? await admin
          .from('driver_profiles')
          .select('profile_id, is_online, last_heartbeat_at, approval_status')
          .in('profile_id', driverIds)
      : { data: [] as { profile_id: string; is_online: boolean; last_heartbeat_at: string | null; approval_status: string }[] };

    const online = (driverProfiles ?? []).filter(
      (d) => d.is_online && d.last_heartbeat_at && d.last_heartbeat_at >= staleWindow
    ).length;

    const { data: jobs } = driverIds.length
      ? await admin.from('requests').select('status').in('driver_id', driverIds)
      : { data: [] as { status: string }[] };
    const matchedJobs = (jobs ?? []).length;
    const completedJobs = (jobs ?? []).filter((j) => j.status === 'completed').length;

    rows.push({
      id: company.id,
      name: company.display_name || company.name,
      status: company.status,
      province: company.province,
      drivers: driverIds.length,
      driversOnline: online,
      driversApproved: (driverProfiles ?? []).filter((d) => d.approval_status === 'approved').length,
      vehicles: (vehicles ?? []).length,
      serviceAreas: (areas ?? []).length,
      zoneAuthorizations: (zoneAuth ?? []).filter((z) => z.authorization_status === 'authorized').length,
      connectStatus: company.connect_status ?? 'not_started',
      payoutReady: Boolean(company.connect_payouts_enabled),
      // NULL rather than 0% when there is nothing to divide: "no jobs yet" is
      // not the same as "never completes a job".
      completionRate: matchedJobs === 0 ? null : Math.round((completedJobs / matchedJobs) * 1000) / 10,
      openIncidents: (incidents ?? []).length,
    });
  }
  return rows;
}

export async function listDriverOps(companyId?: string | null): Promise<DriverOpsRow[]> {
  await requireCapability('operations');
  const admin = createAdminClient();
  const staleWindow = Date.now() - 120_000;

  const { data: driverProfiles } = await admin
    .from('driver_profiles')
    .select('*')
    .order('last_heartbeat_at', { ascending: false, nullsFirst: false })
    .limit(300);

  const ids = (driverProfiles ?? []).map((d) => d.profile_id);
  if (!ids.length) return [];

  const [{ data: profiles }, { data: activeJobs }, { data: documents }, { data: incidents }] = await Promise.all([
    admin.from('profiles').select('id, full_name, phone').in('id', ids),
    admin
      .from('requests')
      .select('id, driver_id, status')
      .in('driver_id', ids)
      .in('status', ['matched', 'en_route', 'arrived', 'in_progress']),
    admin.from('driver_documents').select('driver_id, status').in('driver_id', ids),
    admin.from('operational_incidents').select('driver_id').in('driver_id', ids).in('status', ['open', 'investigating']),
  ]);

  const nameById = new Map((profiles ?? []).map((p) => [p.id, p.full_name]));
  const jobByDriver = new Map((activeJobs ?? []).map((j) => [j.driver_id as string, j]));
  const incidentCount = new Map<string, number>();
  for (const i of incidents ?? []) {
    if (i.driver_id) incidentCount.set(i.driver_id, (incidentCount.get(i.driver_id) ?? 0) + 1);
  }
  const docsByDriver = new Map<string, { approved: number; pending: number; rejected: number }>();
  for (const d of documents ?? []) {
    const entry = docsByDriver.get(d.driver_id) ?? { approved: 0, pending: 0, rejected: 0 };
    if (d.status === 'approved') entry.approved += 1;
    else if (d.status === 'rejected') entry.rejected += 1;
    else entry.pending += 1;
    docsByDriver.set(d.driver_id, entry);
  }

  const rows: DriverOpsRow[] = [];
  for (const dp of driverProfiles ?? []) {
    const companyIdOf = await admin.rpc('driver_company_id' as never, { p_profile_id: dp.profile_id } as never);
    const resolvedCompany = (companyIdOf.data as unknown as string | null) ?? null;
    if (companyId && resolvedCompany !== companyId) continue;

    const beat = dp.last_heartbeat_at ? new Date(dp.last_heartbeat_at).getTime() : 0;
    rows.push({
      profileId: dp.profile_id,
      name: nameById.get(dp.profile_id) ?? '—',
      companyId: resolvedCompany,
      approvalStatus: dp.approval_status,
      // Three states, not two: a driver whose app is open but whose heartbeat
      // has lapsed is neither online nor offline, and treating them as online
      // is exactly how a job gets sent nowhere.
      presence: !dp.is_online ? 'offline' : beat >= staleWindow ? 'online' : 'stale',
      lastHeartbeatAt: dp.last_heartbeat_at,
      rating: dp.rating,
      totalServices: dp.total_services,
      activeRequestId: jobByDriver.get(dp.profile_id)?.id ?? null,
      activeStatus: jobByDriver.get(dp.profile_id)?.status ?? null,
      documents: docsByDriver.get(dp.profile_id) ?? { approved: 0, pending: 0, rejected: 0 },
      openIncidents: incidentCount.get(dp.profile_id) ?? 0,
    });
  }
  return rows;
}

// ---------------------------------------------------------------- support

export interface SupportHit {
  requestId: string;
  createdAt: string;
  status: string;
  locationText: string;
  customerName: string | null;
  customerEmail: string | null;
  matchedVia: string;
}

/**
 * Find a job the way support is actually asked for it: by whatever the caller
 * has to hand — a request id, an email, a phone number, or a Stripe reference.
 */
export async function supportSearch(term: string): Promise<SupportHit[]> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');
  const { data: allowed } = await supabase.rpc('has_admin_capability' as never, {
    p_capability: 'support',
  } as never);
  const { data: alsoOperations } = await supabase.rpc('has_admin_capability' as never, {
    p_capability: 'operations',
  } as never);
  if (allowed !== true && alsoOperations !== true) {
    throw new Error('This lookup needs the "support" or "operations" capability.');
  }

  const admin = createAdminClient();
  const query = term.trim();
  if (!query) return [];

  const requestIds = new Set<string>();
  const matchedVia = new Map<string, string>();
  const uuidLike = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  if (uuidLike.test(query)) {
    requestIds.add(query);
    matchedVia.set(query, 'request id');
  }

  if (query.startsWith('pi_') || query.startsWith('re_') || query.startsWith('ch_')) {
    const { data: payments } = await admin
      .from('payments')
      .select('request_id')
      .eq('stripe_payment_intent_id', query);
    for (const p of payments ?? []) {
      requestIds.add(p.request_id);
      matchedVia.set(p.request_id, 'payment reference');
    }
    const { data: refundRows } = await admin.from('refunds').select('request_id').eq('stripe_refund_id', query);
    for (const r of refundRows ?? []) {
      requestIds.add(r.request_id);
      matchedVia.set(r.request_id, 'refund reference');
    }
  }

  if (query.includes('@')) {
    const { data: users } = await admin.auth.admin.listUsers({ perPage: 200 });
    const match = users.users.find((u) => (u.email ?? '').toLowerCase() === query.toLowerCase());
    if (match) {
      const { data: theirs } = await admin
        .from('requests')
        .select('id')
        .eq('user_id', match.id)
        .order('created_at', { ascending: false })
        .limit(25);
      for (const r of theirs ?? []) {
        requestIds.add(r.id);
        matchedVia.set(r.id, 'customer email');
      }
    }
  }

  const digits = query.replace(/\D/g, '');
  if (digits.length >= 7) {
    const { data: profiles } = await admin.from('profiles').select('id').ilike('phone', `%${digits}%`).limit(10);
    for (const p of profiles ?? []) {
      const { data: theirs } = await admin
        .from('requests')
        .select('id')
        .eq('user_id', p.id)
        .order('created_at', { ascending: false })
        .limit(25);
      for (const r of theirs ?? []) {
        requestIds.add(r.id);
        if (!matchedVia.has(r.id)) matchedVia.set(r.id, 'phone number');
      }
    }
  }

  if (!requestIds.size) return [];

  const { data: requests } = await admin
    .from('requests')
    .select('id, created_at, status, location_text, user_id')
    .in('id', [...requestIds])
    .order('created_at', { ascending: false });

  const userIds = Array.from(new Set((requests ?? []).map((r) => r.user_id)));
  const { data: customers } = userIds.length
    ? await admin.from('profiles').select('id, full_name').in('id', userIds)
    : { data: [] as { id: string; full_name: string }[] };
  const nameById = new Map((customers ?? []).map((c) => [c.id, c.full_name]));

  return (requests ?? []).map((r) => ({
    requestId: r.id,
    createdAt: r.created_at,
    status: r.status,
    locationText: r.location_text,
    customerName: nameById.get(r.user_id) ?? null,
    customerEmail: null,
    matchedVia: matchedVia.get(r.id) ?? 'search',
  }));
}

// ---------------------------------------------------------------- access

export interface AdminAccount {
  id: string;
  name: string;
  capabilities: AdminCapability[];
}

export async function listAdminAccounts(): Promise<AdminAccount[]> {
  await requireCapability('super_admin');
  const admin = createAdminClient();
  const { data: admins } = await admin.from('profiles').select('id, full_name').eq('role', 'admin').order('full_name');
  const ids = (admins ?? []).map((a) => a.id);
  const { data: grants } = ids.length
    ? await admin.from('admin_grants').select('profile_id, capability').in('profile_id', ids)
    : { data: [] as { profile_id: string; capability: AdminCapability }[] };

  return (admins ?? []).map((a) => ({
    id: a.id,
    name: a.full_name || '—',
    capabilities: (grants ?? []).filter((g) => g.profile_id === a.id).map((g) => g.capability),
  }));
}

export async function grantCapability(profileId: string, capability: AdminCapability): Promise<void> {
  const actorId = await requireCapability('super_admin');
  const supabase = await createClient();
  const { error } = await supabase
    .from('admin_grants')
    .insert({ profile_id: profileId, capability, granted_by: actorId });
  if (error) throw error;
  revalidatePath('/dashboard/admin/operations/access');
}

export async function revokeCapability(profileId: string, capability: AdminCapability): Promise<void> {
  await requireCapability('super_admin');
  const supabase = await createClient();
  const { error } = await supabase
    .from('admin_grants')
    .delete()
    .eq('profile_id', profileId)
    .eq('capability', capability);
  if (error) throw error;
  revalidatePath('/dashboard/admin/operations/access');
}

// ---------------------------------------------------------------- zones

export interface ZoneHealthRow {
  id: string;
  province: string;
  officialName: string;
  zoneCode: string | null;
  active: boolean;
  geometryConfidence: string;
  hasGeometry: boolean;
  sourceUrl: string;
  lastVerifiedAt: string;
  authorizedProviders: number;
  jobsAffected: number;
  capacityWaits: number;
}

export async function listZoneHealth(): Promise<ZoneHealthRow[]> {
  await requireCapability('operations');
  const admin = createAdminClient();

  const { data: zones } = await admin
    .from('regulated_towing_zones')
    .select('id, province, official_name, zone_code, active, geometry_confidence, source_url, last_verified_at')
    .order('province')
    .order('zone_code');

  const rows: ZoneHealthRow[] = [];
  for (const z of zones ?? []) {
    const [{ data: providers }, { data: affected }, { data: waits }, { data: geo }] = await Promise.all([
      admin
        .from('regulated_zone_providers')
        .select('id')
        .eq('zone_id', z.id)
        .eq('authorization_status', 'authorized'),
      admin.from('requests').select('id', { count: 'exact', head: true }).eq('regulated_zone_id', z.id),
      admin
        .from('requests')
        .select('id', { count: 'exact', head: true })
        .eq('regulated_zone_id', z.id)
        .eq('regulated_dispatch_state', 'restricted_capacity_wait'),
      admin.rpc('regulated_zone_geojson' as never, { p_zone_id: z.id } as never),
    ]);

    rows.push({
      id: z.id,
      province: z.province,
      officialName: z.official_name,
      zoneCode: z.zone_code,
      active: z.active,
      geometryConfidence: z.geometry_confidence,
      hasGeometry: geo != null,
      sourceUrl: z.source_url,
      lastVerifiedAt: z.last_verified_at,
      authorizedProviders: (providers ?? []).length,
      jobsAffected: (affected as unknown as { count: number | null })?.count ?? 0,
      capacityWaits: (waits as unknown as { count: number | null })?.count ?? 0,
    });
  }
  return rows;
}

// ---------------------------------------------------------------- dispatch

export interface DispatchHealth {
  pendingWithoutOffer: { id: string; location_text: string; created_at: string; regulatedState: string | null }[];
  repeatedlyDeclined: { id: string; location_text: string; declines: number; created_at: string }[];
  recentOutcomes: { status: string; count: number }[];
  exclusionReasons: { reason: string; count: number }[];
  staleDrivers: number;
}

/**
 * Where dispatch is failing, using the engine's own vocabulary.
 *
 * The exclusion reasons are not re-derived here — they are counted from what
 * dispatch_candidates() said about the requests that are still waiting. A
 * second taxonomy of "why nobody was found" would drift from the first, and
 * the one on screen is the one people would act on.
 */
export async function getDispatchHealth(): Promise<DispatchHealth> {
  await requireCapability('operations');
  const admin = createAdminClient();
  const since = new Date(Date.now() - 24 * 3_600_000).toISOString();

  const { data: pending } = await admin
    .from('requests')
    .select('id, location_text, created_at, regulated_dispatch_state')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(50);

  const { data: offers } = await admin
    .from('dispatch_offers')
    .select('request_id, status')
    .gte('offered_at', since);

  const offersByRequest = new Map<string, { declined: number; total: number }>();
  const outcomes = new Map<string, number>();
  for (const o of offers ?? []) {
    outcomes.set(o.status, (outcomes.get(o.status) ?? 0) + 1);
    const entry = offersByRequest.get(o.request_id) ?? { declined: 0, total: 0 };
    entry.total += 1;
    if (o.status === 'declined') entry.declined += 1;
    offersByRequest.set(o.request_id, entry);
  }

  const pendingWithoutOffer = (pending ?? [])
    .filter((r) => !offersByRequest.has(r.id))
    .map((r) => ({
      id: r.id,
      location_text: r.location_text,
      created_at: r.created_at,
      regulatedState: r.regulated_dispatch_state ?? null,
    }));

  const declinedIds = [...offersByRequest.entries()]
    .filter(([, v]) => v.declined >= 2)
    .map(([id]) => id);
  const { data: declinedRequests } = declinedIds.length
    ? await admin.from('requests').select('id, location_text, created_at').in('id', declinedIds)
    : { data: [] as { id: string; location_text: string; created_at: string }[] };

  // Ask the engine why, for the requests still waiting. Bounded to a handful:
  // this runs the real candidate query, and running it for every historical
  // request would be an expensive way to learn nothing new.
  const exclusionCounts = new Map<string, number>();
  for (const request of pendingWithoutOffer.slice(0, 10)) {
    const { data: candidates } = await admin.rpc('explain_dispatch_candidates', {
      p_request_id: request.id,
    });
    for (const c of (candidates ?? []) as { eligible: boolean; exclusion_reason: string | null }[]) {
      if (c.eligible || !c.exclusion_reason) continue;
      exclusionCounts.set(c.exclusion_reason, (exclusionCounts.get(c.exclusion_reason) ?? 0) + 1);
    }
  }

  const staleWindow = new Date(Date.now() - 120_000).toISOString();
  const { count: staleDrivers } = await admin
    .from('driver_profiles')
    .select('profile_id', { count: 'exact', head: true })
    .eq('is_online', true)
    .lt('last_heartbeat_at', staleWindow);

  return {
    pendingWithoutOffer,
    repeatedlyDeclined: (declinedRequests ?? []).map((r) => ({
      id: r.id,
      location_text: r.location_text,
      created_at: r.created_at,
      declines: offersByRequest.get(r.id)?.declined ?? 0,
    })),
    recentOutcomes: [...outcomes.entries()].map(([status, count]) => ({ status, count })).sort((a, b) => b.count - a.count),
    exclusionReasons: [...exclusionCounts.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count),
    staleDrivers: staleDrivers ?? 0,
  };
}
