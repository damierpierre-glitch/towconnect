'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { settle, simulate, type EconomicConfig, type SimulationRow } from '@/lib/economics';
import type { PricingConfig, PricingConfigStatus } from '@/lib/supabase/types';

// Reading and writing the economic configuration.
//
// Writes are RLS-gated to platform admins ("pricing configs: admins full
// access", 0033) and every one of them is recorded by the audit trigger, which
// no role can delete from. There is no "quick edit" path: a change to the
// economics is a new version, and activating it is its own explicit action.

function toEconomicConfig(row: PricingConfig | null | undefined): EconomicConfig | null {
  if (!row) return null;
  const num = (v: number | string | null) => (v == null ? null : Number(v));
  return {
    commissionPercent: num(row.commission_percent),
    commissionFixed: num(row.commission_fixed),
    commissionMin: num(row.commission_min),
    commissionMax: num(row.commission_max),
    providerMinimum: num(row.provider_minimum),
    paymentProcessingPercent: num(row.payment_processing_percent),
    paymentProcessingFixed: num(row.payment_processing_fixed),
  };
}

export async function listPricingConfigs(): Promise<PricingConfig[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('pricing_configs')
    .select('*')
    .order('version', { ascending: false });
  if (error) throw error;
  return data ?? [];
}

export async function getActivePricingConfig(): Promise<PricingConfig | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('pricing_configs')
    .select('*')
    .eq('status', 'active')
    .maybeSingle();
  if (error) throw error;
  return data ?? null;
}

export interface PricingConfigInput {
  label: string;
  commissionPercent: number | null;
  commissionFixed: number | null;
  commissionMin: number | null;
  commissionMax: number | null;
  providerMinimum: number | null;
  paymentProcessingPercent: number | null;
  paymentProcessingFixed: number | null;
  cancellationFeeCustomer: number | null;
  cancellationCompensationProvider: number | null;
  notes: string | null;
}

export async function createPricingDraft(input: PricingConfigInput): Promise<PricingConfig> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');

  const { data: latest } = await supabase
    .from('pricing_configs')
    .select('version')
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle();
  const nextVersion = (latest?.version ?? 0) + 1;

  const { data, error } = await supabase
    .from('pricing_configs')
    .insert({
      version: nextVersion,
      label: input.label.trim() || `Version ${nextVersion}`,
      status: 'draft',
      commission_percent: input.commissionPercent,
      commission_fixed: input.commissionFixed,
      commission_min: input.commissionMin,
      commission_max: input.commissionMax,
      provider_minimum: input.providerMinimum,
      payment_processing_percent: input.paymentProcessingPercent,
      payment_processing_fixed: input.paymentProcessingFixed,
      cancellation_fee_customer: input.cancellationFeeCustomer,
      cancellation_compensation_provider: input.cancellationCompensationProvider,
      notes: input.notes,
      created_by: user.id,
    })
    .select('*')
    .single();
  if (error) throw error;
  revalidatePath('/dashboard/admin/economics');
  return data;
}

/**
 * Activation is its own deliberate action, never a side effect of editing.
 *
 * The previously active version is archived rather than deleted: a job priced
 * under it still points at it, and a configuration that vanishes takes the
 * explanation of somebody's pay with it. The unique index in 0033 is what
 * actually guarantees only one is active; this just does it in the right
 * order.
 */
export async function activatePricingConfig(configId: string): Promise<void> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');

  const { data: target, error: readError } = await supabase
    .from('pricing_configs')
    .select('*')
    .eq('id', configId)
    .single();
  if (readError) throw readError;
  if (target.commission_percent == null && target.commission_fixed == null) {
    throw new Error(
      'This configuration defines no commission. Activating it would look like a decision and compute nothing.'
    );
  }

  const { error: archiveError } = await supabase
    .from('pricing_configs')
    .update({ status: 'archived', archived_at: new Date().toISOString() })
    .eq('status', 'active');
  if (archiveError) throw archiveError;

  const { error } = await supabase
    .from('pricing_configs')
    .update({
      status: 'active',
      activated_at: new Date().toISOString(),
      activated_by: user.id,
    })
    .eq('id', configId);
  if (error) throw error;

  revalidatePath('/dashboard/admin/economics');
}

export async function archivePricingConfig(configId: string): Promise<void> {
  const supabase = await createClient();
  const { error } = await supabase
    .from('pricing_configs')
    .update({ status: 'archived', archived_at: new Date().toISOString() })
    .eq('id', configId);
  if (error) throw error;
  revalidatePath('/dashboard/admin/economics');
}

export interface AuditEntry {
  id: number;
  config_id: string | null;
  action: string;
  actor_id: string | null;
  created_at: string;
}

export async function listPricingAudit(limit = 40): Promise<AuditEntry[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('pricing_config_audit' as never)
    .select('id, config_id, action, actor_id, created_at')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as unknown as AuditEntry[];
}

/** Run the simulator against a stored configuration, or against a draft. */
export async function simulateConfig(
  input: Partial<PricingConfigInput>,
  amounts?: number[]
): Promise<SimulationRow[]> {
  const config: EconomicConfig = {
    commissionPercent: input.commissionPercent ?? null,
    commissionFixed: input.commissionFixed ?? null,
    commissionMin: input.commissionMin ?? null,
    commissionMax: input.commissionMax ?? null,
    providerMinimum: input.providerMinimum ?? null,
    paymentProcessingPercent: input.paymentProcessingPercent ?? null,
    paymentProcessingFixed: input.paymentProcessingFixed ?? null,
  };
  return simulate(config, amounts && amounts.length ? amounts : undefined);
}

/**
 * Freeze the economics of a job at acceptance.
 *
 * Called from the accept path. Runs with the service role because a driver's
 * own session is (correctly) forbidden from writing any of these columns —
 * the 0033 guard rejects it — and because the numbers must be the platform's,
 * not the accepting party's.
 *
 * Deliberately a no-op when nothing is configured: a NULL partner_amount means
 * "no economic configuration was active", which is a fact worth keeping and
 * very different from zero.
 */
export async function freezeRequestEconomics(requestId: string): Promise<void> {
  const admin = createAdminClient();

  const { data: request } = await admin
    .from('requests')
    .select('id, price_estimate, economics_frozen_at')
    .eq('id', requestId)
    .maybeSingle();
  if (!request || request.economics_frozen_at) return;

  const { data: config } = await admin
    .from('pricing_configs')
    .select('*')
    .eq('status', 'active')
    .maybeSingle();

  const breakdown = settle(Number(request.price_estimate), toEconomicConfig(config));

  await admin
    .from('requests')
    .update({
      pricing_config_id: config?.id ?? null,
      pricing_config_version: config?.version ?? null,
      partner_amount: breakdown.providerCompensation,
      commission_amount: breakdown.towconnectMargin,
      payment_processing_cost: breakdown.paymentProcessingCost,
      economics_frozen_at: new Date().toISOString(),
    })
    .eq('id', requestId);
}

/**
 * What a driver would be paid for a job they have not accepted yet.
 *
 * Uses the currently active configuration, because nothing is frozen until
 * acceptance. Returns null when nothing is configured, and the offer card
 * renders nothing at all in that case — never "$0".
 */
export async function quoteProviderCompensation(customerPrice: number): Promise<number | null> {
  const supabase = await createClient();
  const { data: config } = await supabase
    .from('pricing_configs')
    .select('*')
    .eq('status', 'active')
    .maybeSingle();
  return settle(customerPrice, toEconomicConfig(config)).providerCompensation;
}

export async function getPricingStatus(): Promise<{ configured: boolean; status: PricingConfigStatus | null }> {
  const config = await getActivePricingConfig();
  return {
    configured: Boolean(config && (config.commission_percent != null || config.commission_fixed != null)),
    status: config?.status ?? null,
  };
}
