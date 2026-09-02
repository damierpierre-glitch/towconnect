import 'server-only';
import { createAdminClient } from '@/lib/supabase/admin';
import type {
  AdminCapability,
  IncidentStatus,
  PaymentStatus,
  RefundStatus,
  RequestStatus,
} from '@/lib/supabase/types';

// What can be exported, by whom, and where each column comes from.
//
// THE INVARIANT THIS FILE EXISTS TO HOLD
// An export can never widen a role's visibility. Every dataset below names
// the capability that already grants read access to the same data through the
// UI, and the export path refuses anything else — so a file is always a
// SUBSET of what that person could already see on screen, never a way around
// the screen.
//
// Two consequences, both deliberate:
//  * The browser sends filters, never rows and never ids. A list of ids from
//    a client is a request to trust the client about what it may read.
//  * Columns are enumerated by hand. `select *` would silently start
//    exporting whatever column somebody adds next — including a token, a
//    Stripe key or a KYC field.

export type ColumnType = 'text' | 'number' | 'money' | 'date' | 'datetime' | 'boolean';

export interface Column {
  key: string;
  header: string;
  type: ColumnType;
}

export interface DatasetFilters {
  from?: string | null;
  to?: string | null;
  status?: string | null;
  companyId?: string | null;
  driverId?: string | null;
  problemType?: string | null;
  zoneId?: string | null;
}

export interface SummaryRow {
  label: string;
  value: string | number | null;
}

export interface DatasetDefinition {
  key: string;
  label: string;
  /** The capabilities that may export it. Mirrors who may already read it. */
  capabilities: AdminCapability[];
  columns: Column[];
  fetch: (filters: DatasetFilters) => Promise<Record<string, unknown>[]>;
  /** Optional Résumé sheet for XLSX, derived from the very rows exported. */
  summary?: (rows: Record<string, unknown>[]) => SummaryRow[];
}

const money = (v: unknown) => (v == null ? null : Number(v));

// ---------------------------------------------------------------- operations

const requestsDataset: DatasetDefinition = {
  key: 'requests',
  label: 'Interventions',
  capabilities: ['operations', 'support', 'super_admin'],
  columns: [
    { key: 'id', header: 'ID', type: 'text' },
    { key: 'created_at', header: 'Créée le', type: 'datetime' },
    { key: 'status', header: 'Statut', type: 'text' },
    { key: 'problem_type', header: 'Service', type: 'text' },
    { key: 'location_text', header: 'Lieu de prise en charge', type: 'text' },
    { key: 'destination_address', header: 'Destination', type: 'text' },
    { key: 'tow_distance_km', header: 'Distance remorquage (km)', type: 'number' },
    { key: 'driver_name', header: 'Chauffeur', type: 'text' },
    { key: 'company_name', header: 'Entreprise', type: 'text' },
    { key: 'regulated_zone', header: 'Zone réglementée', type: 'text' },
    { key: 'regulated_state', header: 'État réglementaire', type: 'text' },
    { key: 'price_estimate', header: 'Prix client', type: 'money' },
  ],
  async fetch(filters) {
    const admin = createAdminClient();
    let query = admin
      .from('requests')
      .select(
        'id, created_at, status, problem_type, location_text, destination_address, tow_distance_km, price_estimate, driver_id, regulated_zone_id, regulated_dispatch_state'
      )
      .order('created_at', { ascending: false })
      .limit(10_000);
    if (filters.from) query = query.gte('created_at', filters.from);
    if (filters.to) query = query.lt('created_at', filters.to);
    if (filters.status) query = query.eq('status', filters.status as RequestStatus);
    if (filters.driverId) query = query.eq('driver_id', filters.driverId);
    if (filters.problemType) query = query.eq('problem_type', filters.problemType);
    if (filters.zoneId) query = query.eq('regulated_zone_id', filters.zoneId);

    const { data, error } = await query;
    if (error) throw error;

    const driverIds = [...new Set((data ?? []).map((r) => r.driver_id).filter(Boolean))] as string[];
    const zoneIds = [...new Set((data ?? []).map((r) => r.regulated_zone_id).filter(Boolean))] as string[];

    const [{ data: drivers }, { data: zones }] = await Promise.all([
      driverIds.length
        ? admin.from('profiles').select('id, full_name').in('id', driverIds)
        : Promise.resolve({ data: [] as { id: string; full_name: string }[] }),
      zoneIds.length
        ? admin.from('regulated_towing_zones').select('id, zone_code, official_name').in('id', zoneIds)
        : Promise.resolve({ data: [] as { id: string; zone_code: string | null; official_name: string }[] }),
    ]);
    const driverName = new Map((drivers ?? []).map((d) => [d.id, d.full_name]));
    const zoneName = new Map(
      (zones ?? []).map((z) => [z.id, z.zone_code ? `${z.zone_code} — ${z.official_name}` : z.official_name])
    );

    const companyByDriver = new Map<string, string | null>();
    for (const id of driverIds) {
      const { data: companyId } = await admin.rpc('driver_company_id' as never, { p_profile_id: id } as never);
      companyByDriver.set(id, (companyId as unknown as string | null) ?? null);
    }
    const companyIds = [...new Set([...companyByDriver.values()].filter(Boolean))] as string[];
    const { data: companies } = companyIds.length
      ? await admin.from('companies').select('id, name, display_name').in('id', companyIds)
      : { data: [] as { id: string; name: string; display_name: string | null }[] };
    const companyName = new Map((companies ?? []).map((c) => [c.id, c.display_name || c.name]));

    let rows = (data ?? []).map((r) => {
      const companyId = r.driver_id ? companyByDriver.get(r.driver_id) ?? null : null;
      return {
        id: r.id,
        created_at: r.created_at,
        status: r.status,
        problem_type: r.problem_type,
        location_text: r.location_text,
        destination_address: r.destination_address,
        tow_distance_km: r.tow_distance_km == null ? null : Number(r.tow_distance_km),
        driver_name: r.driver_id ? driverName.get(r.driver_id) ?? null : null,
        company_name: companyId ? companyName.get(companyId) ?? null : null,
        regulated_zone: r.regulated_zone_id ? zoneName.get(r.regulated_zone_id) ?? null : null,
        regulated_state: r.regulated_dispatch_state,
        price_estimate: money(r.price_estimate),
        _company_id: companyId,
      };
    });
    if (filters.companyId) rows = rows.filter((r) => r._company_id === filters.companyId);
    return rows.map(({ _company_id, ...rest }) => {
      void _company_id;
      return rest;
    });
  },
};

const dispatchDataset: DatasetDefinition = {
  key: 'dispatch',
  label: 'Répartition',
  capabilities: ['operations', 'super_admin'],
  columns: [
    { key: 'request_id', header: 'Intervention', type: 'text' },
    { key: 'driver_name', header: 'Chauffeur', type: 'text' },
    { key: 'status', header: 'Résultat', type: 'text' },
    { key: 'offered_at', header: 'Offerte le', type: 'datetime' },
    { key: 'responded_at', header: 'Réponse le', type: 'datetime' },
    { key: 'expires_at', header: 'Expiration', type: 'datetime' },
  ],
  async fetch(filters) {
    const admin = createAdminClient();
    let query = admin
      .from('dispatch_offers')
      .select('request_id, driver_id, status, offered_at, responded_at, expires_at')
      .order('offered_at', { ascending: false })
      .limit(10_000);
    if (filters.from) query = query.gte('offered_at', filters.from);
    if (filters.to) query = query.lt('offered_at', filters.to);
    if (filters.driverId) query = query.eq('driver_id', filters.driverId);
    const { data, error } = await query;
    if (error) throw error;

    const ids = [...new Set((data ?? []).map((o) => o.driver_id))];
    const { data: drivers } = ids.length
      ? await admin.from('profiles').select('id, full_name').in('id', ids)
      : { data: [] as { id: string; full_name: string }[] };
    const name = new Map((drivers ?? []).map((d) => [d.id, d.full_name]));

    return (data ?? []).map((o) => ({
      request_id: o.request_id,
      driver_name: name.get(o.driver_id) ?? null,
      status: o.status,
      offered_at: o.offered_at,
      responded_at: o.responded_at,
      expires_at: o.expires_at,
    }));
  },
};

const driversDataset: DatasetDefinition = {
  key: 'drivers',
  label: 'Chauffeurs',
  capabilities: ['operations', 'super_admin'],
  columns: [
    { key: 'name', header: 'Nom', type: 'text' },
    { key: 'approval_status', header: 'Approbation', type: 'text' },
    { key: 'is_online', header: 'En ligne', type: 'boolean' },
    { key: 'last_heartbeat_at', header: 'Dernier battement', type: 'datetime' },
    { key: 'vehicle_type', header: 'Type de camion', type: 'text' },
    { key: 'province', header: 'Province', type: 'text' },
    { key: 'rating', header: 'Note', type: 'number' },
    { key: 'total_services', header: 'Courses complétées', type: 'number' },
  ],
  async fetch() {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from('driver_profiles')
      .select(
        'profile_id, approval_status, is_online, last_heartbeat_at, vehicle_type, province, rating, total_services'
      )
      .limit(5_000);
    if (error) throw error;
    const ids = (data ?? []).map((d) => d.profile_id);
    const { data: profiles } = ids.length
      ? await admin.from('profiles').select('id, full_name').in('id', ids)
      : { data: [] as { id: string; full_name: string }[] };
    const name = new Map((profiles ?? []).map((p) => [p.id, p.full_name]));
    return (data ?? []).map((d) => ({
      name: name.get(d.profile_id) ?? null,
      approval_status: d.approval_status,
      is_online: d.is_online,
      last_heartbeat_at: d.last_heartbeat_at,
      vehicle_type: d.vehicle_type,
      province: d.province,
      // A driver with no completed job has no rating to report. Exporting the
      // 5.0 default as if it were earned is exactly the fabricated data this
      // project refuses.
      rating: d.total_services > 0 ? Number(d.rating) : null,
      total_services: d.total_services,
    }));
  },
};

const companiesDataset: DatasetDefinition = {
  key: 'companies',
  label: 'Entreprises',
  capabilities: ['operations', 'super_admin'],
  columns: [
    { key: 'name', header: 'Entreprise', type: 'text' },
    { key: 'status', header: 'Statut', type: 'text' },
    { key: 'province', header: 'Province', type: 'text' },
    { key: 'connect_status', header: 'Statut Connect', type: 'text' },
    { key: 'payouts_enabled', header: 'Versements activés', type: 'boolean' },
    { key: 'created_at', header: 'Créée le', type: 'datetime' },
  ],
  async fetch(filters) {
    const admin = createAdminClient();
    let query = admin
      .from('companies')
      .select('id, name, display_name, status, province, connect_status, connect_payouts_enabled, created_at')
      .order('name')
      .limit(5_000);
    if (filters.companyId) query = query.eq('id', filters.companyId);
    const { data, error } = await query;
    if (error) throw error;
    return (data ?? []).map((c) => ({
      name: c.display_name || c.name,
      status: c.status,
      province: c.province,
      connect_status: c.connect_status,
      payouts_enabled: c.connect_payouts_enabled,
      created_at: c.created_at,
    }));
  },
};

const incidentsDataset: DatasetDefinition = {
  key: 'incidents',
  label: 'Incidents',
  capabilities: ['operations', 'super_admin'],
  columns: [
    { key: 'created_at', header: 'Ouvert le', type: 'datetime' },
    { key: 'type', header: 'Type', type: 'text' },
    { key: 'severity', header: 'Gravité', type: 'text' },
    { key: 'status', header: 'Statut', type: 'text' },
    { key: 'title', header: 'Titre', type: 'text' },
    { key: 'request_id', header: 'Intervention', type: 'text' },
    { key: 'resolved_at', header: 'Clos le', type: 'datetime' },
  ],
  async fetch(filters) {
    const admin = createAdminClient();
    let query = admin
      .from('operational_incidents')
      .select('created_at, type, severity, status, title, request_id, resolved_at')
      .order('created_at', { ascending: false })
      .limit(10_000);
    if (filters.from) query = query.gte('created_at', filters.from);
    if (filters.to) query = query.lt('created_at', filters.to);
    if (filters.status) query = query.eq('status', filters.status as IncidentStatus);
    const { data, error } = await query;
    if (error) throw error;
    return data ?? [];
  },
};

const zonesDataset: DatasetDefinition = {
  key: 'regulated_zones',
  label: 'Zones réglementées',
  capabilities: ['operations', 'super_admin'],
  columns: [
    { key: 'province', header: 'Province', type: 'text' },
    { key: 'zone_code', header: 'Code', type: 'text' },
    { key: 'official_name', header: 'Nom officiel', type: 'text' },
    { key: 'active', header: 'Active', type: 'boolean' },
    { key: 'geometry_confidence', header: 'Confiance géométrie', type: 'text' },
    { key: 'restriction_type', header: 'Type de restriction', type: 'text' },
    { key: 'dispatch_mode', header: 'Mode de répartition', type: 'text' },
    { key: 'source_url', header: 'Source', type: 'text' },
    { key: 'last_verified_at', header: 'Dernière vérification', type: 'date' },
  ],
  async fetch() {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from('regulated_towing_zones')
      .select(
        'province, zone_code, official_name, active, geometry_confidence, restriction_type, dispatch_mode, source_url, last_verified_at'
      )
      .order('province')
      .order('zone_code');
    if (error) throw error;
    return data ?? [];
  },
};

const documentsDataset: DatasetDefinition = {
  key: 'driver_documents',
  label: 'Documents chauffeurs',
  capabilities: ['operations', 'super_admin'],
  columns: [
    { key: 'driver_name', header: 'Chauffeur', type: 'text' },
    { key: 'type', header: 'Type', type: 'text' },
    { key: 'status', header: 'Statut', type: 'text' },
    { key: 'uploaded_at', header: 'Téléversé le', type: 'datetime' },
    { key: 'reviewed_at', header: 'Revu le', type: 'datetime' },
    { key: 'expires_at', header: 'Expire le', type: 'date' },
  ],
  async fetch(filters) {
    const admin = createAdminClient();
    // Deliberately NOT storage_path: an export must not hand out the location
    // of somebody's licence scan.
    let query = admin
      .from('driver_documents')
      .select('driver_id, type, status, uploaded_at, reviewed_at, expires_at')
      .order('uploaded_at', { ascending: false })
      .limit(10_000);
    if (filters.driverId) query = query.eq('driver_id', filters.driverId);
    const { data, error } = await query;
    if (error) throw error;
    const ids = [...new Set((data ?? []).map((d) => d.driver_id))];
    const { data: profiles } = ids.length
      ? await admin.from('profiles').select('id, full_name').in('id', ids)
      : { data: [] as { id: string; full_name: string }[] };
    const name = new Map((profiles ?? []).map((p) => [p.id, p.full_name]));
    return (data ?? []).map((d) => ({
      driver_name: name.get(d.driver_id) ?? null,
      type: d.type,
      status: d.status,
      uploaded_at: d.uploaded_at,
      reviewed_at: d.reviewed_at,
      expires_at: d.expires_at,
    }));
  },
};

// ------------------------------------------------------------------ finance

const paymentsDataset: DatasetDefinition = {
  key: 'payments',
  label: 'Paiements',
  capabilities: ['finance', 'super_admin'],
  columns: [
    { key: 'created_at', header: 'Créé le', type: 'datetime' },
    { key: 'request_id', header: 'Intervention', type: 'text' },
    { key: 'status', header: 'Statut', type: 'text' },
    { key: 'amount', header: 'Montant', type: 'money' },
    { key: 'currency', header: 'Devise', type: 'text' },
    { key: 'failure_reason', header: 'Motif d’échec', type: 'text' },
  ],
  async fetch(filters) {
    const admin = createAdminClient();
    // stripe_payment_intent_id is omitted on purpose: an export is not the
    // place for a payment-processor identifier.
    let query = admin
      .from('payments')
      .select('created_at, request_id, status, amount, currency, failure_reason')
      .order('created_at', { ascending: false })
      .limit(10_000);
    if (filters.from) query = query.gte('created_at', filters.from);
    if (filters.to) query = query.lt('created_at', filters.to);
    if (filters.status) query = query.eq('status', filters.status as PaymentStatus);
    const { data, error } = await query;
    if (error) throw error;
    return (data ?? []).map((p) => ({ ...p, amount: money(p.amount) }));
  },
  summary(rows) {
    const sum = (predicate: (r: Record<string, unknown>) => boolean) =>
      rows.filter(predicate).reduce((s, r) => s + Number(r.amount ?? 0), 0);
    return [
      { label: 'Paiements', value: rows.length },
      { label: 'Encaissés', value: sum((r) => r.status === 'captured') },
      { label: 'Autorisés', value: sum((r) => r.status === 'authorized') },
      { label: 'Remboursés', value: sum((r) => r.status === 'refunded') },
      { label: 'Échoués', value: rows.filter((r) => r.status === 'failed').length },
    ];
  },
};

const refundsDataset: DatasetDefinition = {
  key: 'refunds',
  label: 'Remboursements',
  capabilities: ['finance', 'super_admin'],
  columns: [
    { key: 'created_at', header: 'Créé le', type: 'datetime' },
    { key: 'request_id', header: 'Intervention', type: 'text' },
    { key: 'amount', header: 'Montant', type: 'money' },
    { key: 'status', header: 'Statut', type: 'text' },
    { key: 'reason', header: 'Raison', type: 'text' },
    { key: 'is_supplement', header: 'Sur un supplément', type: 'boolean' },
  ],
  async fetch(filters) {
    const admin = createAdminClient();
    let query = admin
      .from('refunds')
      .select('created_at, request_id, amount, status, reason, supplement_id')
      .order('created_at', { ascending: false })
      .limit(10_000);
    if (filters.from) query = query.gte('created_at', filters.from);
    if (filters.to) query = query.lt('created_at', filters.to);
    if (filters.status) query = query.eq('status', filters.status as RefundStatus);
    const { data, error } = await query;
    if (error) throw error;
    return (data ?? []).map((r) => ({
      created_at: r.created_at,
      request_id: r.request_id,
      amount: money(r.amount),
      status: r.status,
      reason: r.reason,
      is_supplement: r.supplement_id != null,
    }));
  },
  summary(rows) {
    const succeeded = rows.filter((r) => r.status === 'succeeded');
    return [
      { label: 'Remboursements', value: rows.length },
      { label: 'Réussis', value: succeeded.length },
      { label: 'Montant remboursé', value: succeeded.reduce((s, r) => s + Number(r.amount ?? 0), 0) },
    ];
  },
};

const supplementsDataset: DatasetDefinition = {
  key: 'supplements',
  label: 'Suppléments',
  capabilities: ['finance', 'super_admin'],
  columns: [
    { key: 'created_at', header: 'Proposé le', type: 'datetime' },
    { key: 'request_id', header: 'Intervention', type: 'text' },
    { key: 'type_key', header: 'Type', type: 'text' },
    { key: 'amount', header: 'Montant', type: 'money' },
    { key: 'status', header: 'Statut', type: 'text' },
    { key: 'payment_state', header: 'État du paiement', type: 'text' },
    { key: 'collection_method', header: 'Mode d’encaissement', type: 'text' },
  ],
  async fetch(filters) {
    const admin = createAdminClient();
    let query = admin
      .from('request_supplements')
      .select('created_at, request_id, type_key, amount, status, payment_state, collection_method')
      .order('created_at', { ascending: false })
      .limit(10_000);
    if (filters.from) query = query.gte('created_at', filters.from);
    if (filters.to) query = query.lt('created_at', filters.to);
    const { data, error } = await query;
    if (error) throw error;
    return (data ?? []).map((s) => ({ ...s, amount: money(s.amount) }));
  },
  summary(rows) {
    const settled = rows.filter((r) => r.payment_state === 'settled');
    return [
      { label: 'Suppléments proposés', value: rows.length },
      { label: 'Approuvés', value: rows.filter((r) => r.status === 'approved').length },
      { label: 'Encaissés', value: settled.length },
      { label: 'Montant encaissé', value: settled.reduce((s, r) => s + Number(r.amount ?? 0), 0) },
      {
        label: 'Approuvés non encaissés',
        value: rows.filter((r) => r.status === 'approved' && r.payment_state !== 'settled').length,
      },
    ];
  },
};

const ledgerDataset: DatasetDefinition = {
  key: 'ledger',
  label: 'Grand livre partenaire',
  capabilities: ['finance', 'super_admin'],
  columns: [
    { key: 'created_at', header: 'Écriture du', type: 'datetime' },
    { key: 'company_name', header: 'Entreprise', type: 'text' },
    { key: 'entry_type', header: 'Type', type: 'text' },
    { key: 'amount', header: 'Montant', type: 'money' },
    { key: 'available_at', header: 'Disponible le', type: 'datetime' },
    { key: 'request_id', header: 'Intervention', type: 'text' },
    { key: 'description', header: 'Description', type: 'text' },
  ],
  async fetch(filters) {
    const admin = createAdminClient();
    let query = admin
      .from('provider_ledger_entries')
      .select('created_at, company_id, entry_type, amount, available_at, request_id, description')
      .order('created_at', { ascending: false })
      .limit(20_000);
    if (filters.from) query = query.gte('created_at', filters.from);
    if (filters.to) query = query.lt('created_at', filters.to);
    if (filters.companyId) query = query.eq('company_id', filters.companyId);
    const { data, error } = await query;
    if (error) throw error;
    const ids = [...new Set((data ?? []).map((e) => e.company_id))];
    const { data: companies } = ids.length
      ? await admin.from('companies').select('id, name, display_name').in('id', ids)
      : { data: [] as { id: string; name: string; display_name: string | null }[] };
    const name = new Map((companies ?? []).map((c) => [c.id, c.display_name || c.name]));
    return (data ?? []).map((e) => ({
      created_at: e.created_at,
      company_name: name.get(e.company_id) ?? null,
      entry_type: e.entry_type,
      amount: money(e.amount),
      available_at: e.available_at,
      request_id: e.request_id,
      description: e.description,
    }));
  },
  summary(rows) {
    const by = (type: string) =>
      rows.filter((r) => r.entry_type === type).reduce((s, r) => s + Number(r.amount ?? 0), 0);
    return [
      { label: 'Écritures', value: rows.length },
      { label: 'Gains', value: by('earning') },
      { label: 'Suppléments', value: by('supplement') },
      { label: 'Reprises sur remboursement', value: by('refund_reversal') },
      { label: 'Versements', value: by('payout') },
      { label: 'Solde net', value: rows.reduce((s, r) => s + Number(r.amount ?? 0), 0) },
    ];
  },
};

const payoutsDataset: DatasetDefinition = {
  key: 'payouts',
  label: 'Versements',
  capabilities: ['finance', 'super_admin'],
  columns: [
    { key: 'created_at', header: 'Créé le', type: 'datetime' },
    { key: 'company_name', header: 'Entreprise', type: 'text' },
    { key: 'amount', header: 'Montant', type: 'money' },
    { key: 'state', header: 'État', type: 'text' },
    { key: 'executed_by_stripe', header: 'Exécuté par Stripe', type: 'boolean' },
    { key: 'paid_at', header: 'Payé le', type: 'datetime' },
  ],
  async fetch(filters) {
    const admin = createAdminClient();
    let query = admin
      .from('provider_payouts')
      .select('created_at, company_id, amount, state, stripe_transfer_id, paid_at')
      .order('created_at', { ascending: false })
      .limit(10_000);
    if (filters.from) query = query.gte('created_at', filters.from);
    if (filters.to) query = query.lt('created_at', filters.to);
    if (filters.companyId) query = query.eq('company_id', filters.companyId);
    const { data, error } = await query;
    if (error) throw error;
    const ids = [...new Set((data ?? []).map((p) => p.company_id))];
    const { data: companies } = ids.length
      ? await admin.from('companies').select('id, name, display_name').in('id', ids)
      : { data: [] as { id: string; name: string; display_name: string | null }[] };
    const name = new Map((companies ?? []).map((c) => [c.id, c.display_name || c.name]));
    return (data ?? []).map((p) => ({
      created_at: p.created_at,
      company_name: name.get(p.company_id) ?? null,
      amount: money(p.amount),
      state: p.state,
      // The distinction Phase 7.1 insisted on: prepared internally is not the
      // same as sent by Stripe, and a spreadsheet must not blur it.
      executed_by_stripe: p.stripe_transfer_id != null,
      paid_at: p.paid_at,
    }));
  },
  summary(rows) {
    return [
      { label: 'Versements', value: rows.length },
      { label: 'Préparés en interne', value: rows.filter((r) => !r.executed_by_stripe).length },
      { label: 'Exécutés par Stripe', value: rows.filter((r) => r.executed_by_stripe).length },
      { label: 'Montant total', value: rows.reduce((s, r) => s + Number(r.amount ?? 0), 0) },
    ];
  },
};

const reconciliationDataset: DatasetDefinition = {
  key: 'reconciliation',
  label: 'Exceptions de réconciliation',
  capabilities: ['finance', 'operations', 'super_admin'],
  columns: [
    { key: 'kind', header: 'Type d’exception', type: 'text' },
    { key: 'request_id', header: 'Intervention', type: 'text' },
    { key: 'company_id', header: 'Entreprise', type: 'text' },
    { key: 'detail', header: 'Détail', type: 'text' },
  ],
  async fetch() {
    const admin = createAdminClient();
    const { data, error } = await admin.rpc('ops_reconciliation_exceptions' as never, {} as never);
    if (error) throw error;
    return (data ?? []) as Record<string, unknown>[];
  },
};

// ------------------------------------------------------------------ support

const supportRequestsDataset: DatasetDefinition = {
  key: 'support_requests',
  label: 'Interventions (support)',
  capabilities: ['support', 'super_admin'],
  columns: [
    { key: 'id', header: 'ID', type: 'text' },
    { key: 'created_at', header: 'Créée le', type: 'datetime' },
    { key: 'status', header: 'Statut', type: 'text' },
    { key: 'problem_type', header: 'Service', type: 'text' },
    { key: 'location_text', header: 'Lieu', type: 'text' },
  ],
  async fetch(filters) {
    const admin = createAdminClient();
    // Narrower than the operations version on purpose: support answers "what
    // happened to this job", not "what does the platform earn".
    let query = admin
      .from('requests')
      .select('id, created_at, status, problem_type, location_text')
      .order('created_at', { ascending: false })
      .limit(5_000);
    if (filters.from) query = query.gte('created_at', filters.from);
    if (filters.to) query = query.lt('created_at', filters.to);
    if (filters.status) query = query.eq('status', filters.status as RequestStatus);
    const { data, error } = await query;
    if (error) throw error;
    return data ?? [];
  },
};

// --------------------------------------------------------------------- KPIs

const kpiDataset: DatasetDefinition = {
  key: 'kpis',
  label: 'Indicateurs',
  capabilities: ['operations', 'finance', 'super_admin'],
  columns: [
    { key: 'metric', header: 'Indicateur', type: 'text' },
    { key: 'value', header: 'Valeur', type: 'number' },
    { key: 'definition', header: 'Définition', type: 'text' },
  ],
  async fetch(filters) {
    const admin = createAdminClient();
    const from = filters.from ?? new Date(Date.now() - 30 * 86_400_000).toISOString();
    const to = filters.to ?? new Date().toISOString();
    const { data, error } = await admin.rpc('ops_kpis' as never, { p_from: from, p_to: to } as never);
    if (error) throw error;
    const k = (data as Record<string, unknown>[] | null)?.[0];
    if (!k) return [];

    // The definitions are copied from ops_kpis() itself, so the spreadsheet
    // and the dashboard cannot end up describing different things.
    const rows: { metric: string; value: number | null; definition: string }[] = [
      { metric: 'Demandes créées', value: Number(k.requests_created), definition: 'requests créées dans la période' },
      { metric: 'Demandes matchées', value: Number(k.requests_matched), definition: 'ayant atteint le statut matched' },
      { metric: 'Complétées', value: Number(k.requests_completed), definition: 'statut completed' },
      { metric: 'Annulées', value: Number(k.requests_cancelled), definition: 'statut cancelled' },
      { metric: 'Taux de matching (%)', value: k.match_rate == null ? null : Number(k.match_rate), definition: 'matchées / créées' },
      { metric: 'Taux de complétion (%)', value: k.completion_rate == null ? null : Number(k.completion_rate), definition: 'complétées / matchées' },
      { metric: "Taux d'annulation (%)", value: k.cancellation_rate == null ? null : Number(k.cancellation_rate), definition: 'annulées / créées' },
      { metric: "Taux d'acceptation (%)", value: k.acceptance_rate == null ? null : Number(k.acceptance_rate), definition: 'offres acceptées / offres émises' },
      { metric: 'Délai médian de matching (s)', value: k.median_time_to_match_seconds == null ? null : Number(k.median_time_to_match_seconds), definition: "premier événement matched − requests.created_at" },
      { metric: "Délai médian jusqu'à l'arrivée (s)", value: k.median_time_to_arrival_seconds == null ? null : Number(k.median_time_to_arrival_seconds), definition: "premier événement arrived − requests.created_at" },
      { metric: 'Courses en zone réglementée', value: Number(k.regulated_requests), definition: 'regulated_zone_id non nul' },
      { metric: 'Ayant nécessité un humain', value: Number(k.requests_needing_human), definition: 'au moins un incident rattaché' },
      { metric: 'Taux de paiement échoué (%)', value: k.failed_payment_rate == null ? null : Number(k.failed_payment_rate), definition: 'dernier paiement failed / avec paiement' },
    ];
    return rows;
  },
};

export const DATASETS: DatasetDefinition[] = [
  requestsDataset,
  dispatchDataset,
  driversDataset,
  companiesDataset,
  incidentsDataset,
  zonesDataset,
  documentsDataset,
  paymentsDataset,
  refundsDataset,
  supplementsDataset,
  ledgerDataset,
  payoutsDataset,
  reconciliationDataset,
  supportRequestsDataset,
  kpiDataset,
];

export function findDataset(key: string): DatasetDefinition | undefined {
  return DATASETS.find((d) => d.key === key);
}
