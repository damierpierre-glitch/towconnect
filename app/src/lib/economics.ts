// The economic model, in one place, as arithmetic anybody can check.
//
// THE IDENTITY THIS FILE EXISTS TO PROTECT
//
//   customer_price
//     − provider_compensation
//     − payment_processing_cost
//     = towconnect_margin
//
// Gross revenue, partner compensation and TowConnect's margin are three
// different numbers, and the fastest way to build a business that quietly
// loses money is to let them blur. Everything below keeps them apart, and
// `settle()` asserts the identity on every result rather than trusting that
// the arithmetic above stayed true while the code changed.
//
// NO RATE IS CHOSEN HERE. Every field of EconomicConfig is optional, and a
// config with no commission returns `status: 'not_configured'` with null
// amounts — not zeros. A zero looks like a decision; a null does not.

export interface EconomicConfig {
  /** Percentage of the customer total, 0-100. */
  commissionPercent?: number | null;
  /** Flat amount per job, in dollars. */
  commissionFixed?: number | null;
  /** Floor under TowConnect's own cut. */
  commissionMin?: number | null;
  /** Ceiling on TowConnect's own cut. */
  commissionMax?: number | null;
  /** Floor under what the provider receives, applied after commission. */
  providerMinimum?: number | null;
  /** Processor cost, as a percentage of the customer total. */
  paymentProcessingPercent?: number | null;
  /** Processor cost, flat per transaction. */
  paymentProcessingFixed?: number | null;
}

export type EconomicStatus = 'computed' | 'not_configured';

export interface EconomicBreakdown {
  status: EconomicStatus;
  /** What the customer is charged, including approved supplements. */
  customerPrice: number;
  /** What the provider is owed. Null when nothing is configured. */
  providerCompensation: number | null;
  /** What the processor takes. Null when processor pricing is not configured. */
  paymentProcessingCost: number | null;
  /** What TowConnect keeps after both. Null when nothing is configured. */
  towconnectMargin: number | null;
  /** Margin as a share of the customer price, 0-100. Null when not computed. */
  towconnectMarginPercent: number | null;
  /**
   * Things a human should look at before activating this configuration.
   * Deliberately factual — "the provider receives less than half" — never a
   * verdict like "this margin is too low". Nobody has established what good
   * looks like, and a made-up threshold would be taken as one.
   */
  warnings: EconomicWarning[];
}

export type EconomicWarning =
  | 'margin_negative'
  | 'provider_below_minimum_raised_margin_negative'
  | 'provider_receives_nothing'
  | 'commission_exceeds_customer_price'
  | 'processing_cost_not_configured'
  | 'commission_capped'
  | 'commission_floored'
  | 'provider_minimum_applied';

function round2(n: number): number {
  // Money is rounded once, at the end of each component, so the three parts
  // still sum to the whole. Rounding inside intermediate steps is how a
  // breakdown ends up a cent away from its own total.
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function isConfigured(config: EconomicConfig | null | undefined): boolean {
  if (!config) return false;
  return config.commissionPercent != null || config.commissionFixed != null;
}

/**
 * Split a customer total into provider compensation, processing cost and
 * TowConnect margin.
 *
 * `customerPrice` must already include any approved supplements: a supplement
 * is part of what the customer pays, so it is part of what gets split, and
 * splitting it separately would apply the commission floor twice.
 */
export function settle(customerPrice: number, config: EconomicConfig | null | undefined): EconomicBreakdown {
  const price = round2(Math.max(0, customerPrice));

  if (!isConfigured(config)) {
    return {
      status: 'not_configured',
      customerPrice: price,
      providerCompensation: null,
      paymentProcessingCost: null,
      towconnectMargin: null,
      towconnectMarginPercent: null,
      warnings: [],
    };
  }

  const c = config as EconomicConfig;
  const warnings: EconomicWarning[] = [];

  // ---- TowConnect's cut ------------------------------------------------
  let commission = (price * (c.commissionPercent ?? 0)) / 100 + (c.commissionFixed ?? 0);

  if (c.commissionMin != null && commission < c.commissionMin) {
    commission = c.commissionMin;
    warnings.push('commission_floored');
  }
  if (c.commissionMax != null && commission > c.commissionMax) {
    commission = c.commissionMax;
    warnings.push('commission_capped');
  }
  if (commission > price) {
    // A commission larger than the whole job. Reported rather than silently
    // clamped: clamping would hide a configuration that cannot work.
    warnings.push('commission_exceeds_customer_price');
  }
  commission = round2(commission);

  // ---- what the provider gets -----------------------------------------
  let provider = round2(price - commission);

  if (c.providerMinimum != null && provider < c.providerMinimum) {
    provider = round2(c.providerMinimum);
    warnings.push('provider_minimum_applied');
  }
  if (provider <= 0) {
    warnings.push('provider_receives_nothing');
  }

  // ---- what the processor takes ---------------------------------------
  const processingConfigured =
    c.paymentProcessingPercent != null || c.paymentProcessingFixed != null;
  const processing = processingConfigured
    ? round2((price * (c.paymentProcessingPercent ?? 0)) / 100 + (c.paymentProcessingFixed ?? 0))
    : null;
  if (!processingConfigured) {
    // Margin computed without a processing cost is margin overstated. Say so
    // rather than presenting a number that looks complete.
    warnings.push('processing_cost_not_configured');
  }

  // ---- what is left ----------------------------------------------------
  const margin = round2(price - provider - (processing ?? 0));

  if (margin < 0) {
    warnings.push(
      warnings.includes('provider_minimum_applied')
        ? 'provider_below_minimum_raised_margin_negative'
        : 'margin_negative'
    );
  }

  const breakdown: EconomicBreakdown = {
    status: 'computed',
    customerPrice: price,
    providerCompensation: provider,
    paymentProcessingCost: processing,
    towconnectMargin: margin,
    towconnectMarginPercent: price > 0 ? round2((margin / price) * 100) : null,
    warnings,
  };

  assertIdentity(breakdown);
  return breakdown;
}

/**
 * The identity is checked, not assumed. If a future edit makes the parts stop
 * summing to the whole, this throws in development and in tests rather than
 * shipping a rounding error into a partner's pay.
 */
export function assertIdentity(b: EconomicBreakdown): void {
  if (b.status !== 'computed') return;
  const sum = round2((b.providerCompensation ?? 0) + (b.paymentProcessingCost ?? 0) + (b.towconnectMargin ?? 0));
  if (Math.abs(sum - b.customerPrice) > 0.005) {
    throw new Error(
      `Economic identity violated: provider ${b.providerCompensation} + processing ` +
        `${b.paymentProcessingCost} + margin ${b.towconnectMargin} = ${sum}, ` +
        `but the customer pays ${b.customerPrice}`
    );
  }
}

/** The job sizes the simulator compares by default. */
export const SIMULATION_AMOUNTS = [60, 80, 100, 150, 200, 250, 300] as const;

export interface SimulationRow extends EconomicBreakdown {
  amount: number;
}

export function simulate(
  config: EconomicConfig | null | undefined,
  amounts: readonly number[] = SIMULATION_AMOUNTS
): SimulationRow[] {
  return amounts.map((amount) => ({ amount, ...settle(amount, config) }));
}

/**
 * What a cancellation costs and pays, given a configuration.
 *
 * Before a driver has accepted, the default is that nobody is charged and
 * nobody is paid: no partner performed any work, and inventing a cancellation
 * fee would charge a real customer for a rule nobody set. After acceptance the
 * same holds unless the configuration actually carries the two amounts.
 */
export interface CancellationOutcome {
  customerCharge: number | null;
  providerCompensation: number | null;
  status: EconomicStatus;
}

export function settleCancellation(
  stage: 'before_match' | 'after_match',
  config: (EconomicConfig & {
    cancellationFeeCustomer?: number | null;
    cancellationCompensationProvider?: number | null;
  }) | null | undefined
): CancellationOutcome {
  if (stage === 'before_match') {
    // Nothing was performed. This is a rule, not a missing configuration.
    return { customerCharge: 0, providerCompensation: 0, status: 'computed' };
  }
  const fee = config?.cancellationFeeCustomer ?? null;
  const compensation = config?.cancellationCompensationProvider ?? null;
  if (fee == null && compensation == null) {
    return { customerCharge: null, providerCompensation: null, status: 'not_configured' };
  }
  return {
    customerCharge: fee == null ? 0 : round2(fee),
    providerCompensation: compensation == null ? 0 : round2(compensation),
    status: 'computed',
  };
}
