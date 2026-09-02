'use server';

import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { DATASETS, findDataset, type DatasetFilters } from '@/lib/exports/datasets';
import { toCsv, toXlsx } from '@/lib/exports/format';
import type { AdminCapability } from '@/lib/supabase/types';

// Admin exports.
//
// THE INVARIANT
// An export can never widen a role's visibility. The file is always a SUBSET
// of what that person could already read on screen — never a way around the
// screen. Three things make that true rather than intended:
//
//  1. Every dataset names the capabilities that may export it, and the check
//     below runs on the SERVER against the database's own answer.
//  2. The browser sends FILTERS, never rows and never ids. A list of ids from
//     a client is a request to trust the client about what it may read.
//  3. Columns are enumerated by hand in datasets.ts. `select *` would start
//     exporting whatever column somebody adds next.
//
// Nothing here can export a token, a Stripe key, a bank detail or a KYC field,
// because no dataset selects one.

export interface ExportRequest {
  dataset: string;
  format: 'csv' | 'xlsx';
  filters?: DatasetFilters;
}

export interface ExportResult {
  filename: string;
  mimeType: string;
  /** base64 — server-generated, so the browser never assembles the dataset. */
  content: string;
  rowCount: number;
}

export interface AvailableDataset {
  key: string;
  label: string;
}

/** What this admin may export. Used to render the menu, not to decide access. */
export async function listAvailableExports(): Promise<AvailableDataset[]> {
  const supabase = await createClient();
  const held = await heldCapabilities(supabase);
  return DATASETS.filter((d) => d.capabilities.some((c) => held.has(c))).map((d) => ({
    key: d.key,
    label: d.label,
  }));
}

type ServerClient = Awaited<ReturnType<typeof createClient>>;

async function heldCapabilities(supabase: ServerClient): Promise<Set<AdminCapability>> {
  const held = new Set<AdminCapability>();
  const capabilities: AdminCapability[] = ['super_admin', 'operations', 'finance', 'support'];
  for (const capability of capabilities) {
    const { data } = await supabase.rpc('has_admin_capability' as never, {
      p_capability: capability,
    } as never);
    if (data === true) held.add(capability);
  }
  return held;
}

/**
 * Produce a file, on the server, for a dataset this caller may already read.
 *
 * Re-authorized here every time. The UI hides what somebody cannot export,
 * but hiding is not a control: this function is what refuses.
 */
export async function runExport(request: ExportRequest): Promise<ExportResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');

  const dataset = findDataset(request.dataset);
  if (!dataset) throw new Error('Unknown dataset.');

  const held = await heldCapabilities(supabase);
  // The capability actually used, recorded in the audit trail — not the most
  // powerful one the person holds, the one that granted this export.
  const usedCapability = dataset.capabilities.find((c) => held.has(c));
  if (!usedCapability) {
    throw new Error(`You do not have a capability that can export "${dataset.label}".`);
  }

  const filters = request.filters ?? {};
  const rows = await dataset.fetch(filters);

  const stamp = new Date().toISOString().slice(0, 10);
  const base = `towconnect-${dataset.key}-${stamp}`;

  let content: string;
  let mimeType: string;
  let filename: string;

  if (request.format === 'csv') {
    content = Buffer.from(toCsv(dataset.columns, rows), 'utf8').toString('base64');
    mimeType = 'text/csv;charset=utf-8';
    filename = `${base}.csv`;
  } else {
    const buffer = await toXlsx(dataset.columns, rows, {
      sheetName: 'Données',
      summary: dataset.summary?.(rows),
    });
    content = buffer.toString('base64');
    mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    filename = `${base}.xlsx`;
  }

  // Audited through the service role: export_audit has no INSERT policy, so
  // nobody can write a line into it — or omit one — from a browser session.
  // The FILE is never stored; a log holding copies of exports would be a
  // second, unguarded copy of the data it exists to police.
  const admin = createAdminClient();
  await admin.from('export_audit').insert({
    actor_id: user.id,
    capability: usedCapability,
    dataset: dataset.key,
    format: request.format,
    filters: filters as Record<string, unknown>,
    row_count: rows.length,
  });

  return { filename, mimeType, content, rowCount: rows.length };
}

export interface ExportAuditRow {
  id: number;
  dataset: string;
  format: string;
  capability: string;
  row_count: number;
  created_at: string;
  actor_name: string | null;
}

/** Who exported what. Super admins only: that record is itself sensitive. */
export async function listExportAudit(limit = 50): Promise<ExportAuditRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('export_audit')
    .select('id, dataset, format, capability, row_count, created_at, actor_id')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;

  const admin = createAdminClient();
  const ids = [...new Set((data ?? []).map((r) => r.actor_id).filter(Boolean))] as string[];
  const { data: profiles } = ids.length
    ? await admin.from('profiles').select('id, full_name').in('id', ids)
    : { data: [] as { id: string; full_name: string }[] };
  const name = new Map((profiles ?? []).map((p) => [p.id, p.full_name]));

  return (data ?? []).map((r) => ({
    id: r.id,
    dataset: r.dataset,
    format: r.format,
    capability: r.capability,
    row_count: r.row_count,
    created_at: r.created_at,
    actor_name: r.actor_id ? name.get(r.actor_id) ?? null : null,
  }));
}
