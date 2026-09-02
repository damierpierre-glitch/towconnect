import { describe, expect, it } from 'vitest';
import {
  assertIdentity,
  isConfigured,
  settle,
  settleCancellation,
  simulate,
  SIMULATION_AMOUNTS,
  type EconomicConfig,
} from './economics';

describe('economics: nothing is invented', () => {
  it('returns not_configured, with nulls rather than zeros, when no commission is set', () => {
    const b = settle(100, {});
    expect(b.status).toBe('not_configured');
    // The distinction that matters: a zero would render as "$0.00" on a
    // driver's offer card, which is a claim. Null renders as nothing.
    expect(b.providerCompensation).toBeNull();
    expect(b.towconnectMargin).toBeNull();
    expect(b.paymentProcessingCost).toBeNull();
  });

  it('treats a null config the same way', () => {
    expect(settle(100, null).status).toBe('not_configured');
    expect(settle(100, undefined).status).toBe('not_configured');
    expect(isConfigured(null)).toBe(false);
    expect(isConfigured({ providerMinimum: 50 })).toBe(false);
  });

  it('is configured as soon as either commission form is present', () => {
    expect(isConfigured({ commissionPercent: 0 })).toBe(true);
    expect(isConfigured({ commissionFixed: 0 })).toBe(true);
  });
});

describe('economics: the identity holds', () => {
  const configs: [string, EconomicConfig][] = [
    ['percent only', { commissionPercent: 20 }],
    ['fixed only', { commissionFixed: 12 }],
    ['percent + fixed', { commissionPercent: 15, commissionFixed: 3 }],
    ['with processing', { commissionPercent: 18, paymentProcessingPercent: 2.9, paymentProcessingFixed: 0.3 }],
    ['with floor', { commissionPercent: 10, commissionMin: 15 }],
    ['with cap', { commissionPercent: 30, commissionMax: 40 }],
    ['with provider minimum', { commissionPercent: 40, providerMinimum: 70 }],
    ['everything', {
      commissionPercent: 22, commissionFixed: 2, commissionMin: 10, commissionMax: 60,
      providerMinimum: 45, paymentProcessingPercent: 2.9, paymentProcessingFixed: 0.3,
    }],
  ];

  for (const [name, config] of configs) {
    it(`customer = provider + processing + margin, for ${name}`, () => {
      for (const amount of [...SIMULATION_AMOUNTS, 37.55, 1234.99]) {
        const b = settle(amount, config);
        expect(b.status).toBe('computed');
        // settle() asserts this internally; calling it again here is the point
        // of the test, so a future refactor that removes the internal check
        // still fails loudly.
        expect(() => assertIdentity(b)).not.toThrow();
        const sum =
          (b.providerCompensation ?? 0) + (b.paymentProcessingCost ?? 0) + (b.towconnectMargin ?? 0);
        expect(Math.abs(sum - b.customerPrice)).toBeLessThan(0.005);
      }
    });
  }
});

describe('economics: the arithmetic itself', () => {
  it('takes a straight percentage', () => {
    const b = settle(100, { commissionPercent: 20 });
    expect(b.providerCompensation).toBe(80);
    expect(b.towconnectMargin).toBe(20);
    expect(b.towconnectMarginPercent).toBe(20);
  });

  it('adds a fixed amount to the percentage', () => {
    const b = settle(100, { commissionPercent: 10, commissionFixed: 5 });
    expect(b.providerCompensation).toBe(85);
    expect(b.towconnectMargin).toBe(15);
  });

  it('subtracts processing from the margin, not from the provider', () => {
    const b = settle(100, {
      commissionPercent: 20,
      paymentProcessingPercent: 2.9,
      paymentProcessingFixed: 0.3,
    });
    // The provider is unaffected by what the processor charges.
    expect(b.providerCompensation).toBe(80);
    expect(b.paymentProcessingCost).toBe(3.2);
    expect(b.towconnectMargin).toBe(16.8);
  });

  it('applies a commission floor on small jobs', () => {
    const b = settle(60, { commissionPercent: 10, commissionMin: 12 });
    expect(b.towconnectMargin).toBe(12);
    expect(b.providerCompensation).toBe(48);
    expect(b.warnings).toContain('commission_floored');
  });

  it('applies a commission cap on large jobs', () => {
    const b = settle(900, { commissionPercent: 20, commissionMax: 100 });
    expect(b.providerCompensation).toBe(800);
    expect(b.towconnectMargin).toBe(100);
    expect(b.warnings).toContain('commission_capped');
  });

  it('honours a provider minimum, and says the margin went negative because of it', () => {
    const b = settle(60, { commissionPercent: 25, providerMinimum: 55 });
    expect(b.providerCompensation).toBe(55);
    expect(b.towconnectMargin).toBe(5);
    expect(b.warnings).toContain('provider_minimum_applied');

    const squeezed = settle(60, {
      commissionPercent: 10,
      providerMinimum: 58,
      paymentProcessingPercent: 2.9,
      paymentProcessingFixed: 0.3,
    });
    expect(squeezed.towconnectMargin).toBeLessThan(0);
    expect(squeezed.warnings).toContain('provider_below_minimum_raised_margin_negative');
  });

  it('flags a commission larger than the job instead of hiding it', () => {
    const b = settle(50, { commissionFixed: 80 });
    expect(b.warnings).toContain('commission_exceeds_customer_price');
    expect(b.warnings).toContain('provider_receives_nothing');
  });

  it('warns that margin is overstated when processing cost is unknown', () => {
    const b = settle(100, { commissionPercent: 20 });
    expect(b.paymentProcessingCost).toBeNull();
    expect(b.warnings).toContain('processing_cost_not_configured');
  });

  it('never invents a threshold for what a good margin is', () => {
    const b = settle(100, { commissionPercent: 3, paymentProcessingPercent: 2.9, paymentProcessingFixed: 0.3 });
    // A 3% commission against 3.2% processing is a losing configuration, and
    // the only thing reported is the arithmetic fact that it loses money.
    expect(b.towconnectMargin).toBeLessThan(0);
    expect(b.warnings).toContain('margin_negative');
    expect(b.warnings).not.toContain('margin_too_low');
  });
});

describe('economics: supplements are part of what gets split', () => {
  it('splits the total including the approved supplement, not the base twice', () => {
    const config: EconomicConfig = { commissionPercent: 20, commissionMin: 15 };
    const base = settle(100, config);
    const withSupplement = settle(145, config);

    // The floor applies once to the whole job, not once per component. Had we
    // settled the base and the supplement separately, TowConnect would have
    // taken the $15 minimum twice.
    expect(base.towconnectMargin).toBe(20);
    expect(withSupplement.towconnectMargin).toBe(29);
    expect(withSupplement.providerCompensation).toBe(116);
  });
});

describe('economics: cancellations', () => {
  it('charges and pays nothing before a driver has accepted', () => {
    const out = settleCancellation('before_match', { commissionPercent: 20 });
    expect(out.status).toBe('computed');
    expect(out.customerCharge).toBe(0);
    expect(out.providerCompensation).toBe(0);
  });

  it('says not_configured after a match when no cancellation amounts are set', () => {
    const out = settleCancellation('after_match', { commissionPercent: 20 });
    expect(out.status).toBe('not_configured');
    expect(out.customerCharge).toBeNull();
    expect(out.providerCompensation).toBeNull();
  });

  it('uses the configured amounts once they exist', () => {
    const out = settleCancellation('after_match', {
      commissionPercent: 20,
      cancellationFeeCustomer: 25,
      cancellationCompensationProvider: 20,
    });
    expect(out.customerCharge).toBe(25);
    expect(out.providerCompensation).toBe(20);
  });
});

describe('economics: the simulator', () => {
  it('covers every amount the brief asks for', () => {
    const rows = simulate({ commissionPercent: 20 });
    expect(rows.map((r) => r.amount)).toEqual([60, 80, 100, 150, 200, 250, 300]);
  });

  it('accepts a custom amount', () => {
    const rows = simulate({ commissionPercent: 20 }, [77.5]);
    expect(rows[0].amount).toBe(77.5);
    expect(rows[0].providerCompensation).toBe(62);
  });

  it('reports not_configured for every row when nothing is set', () => {
    const rows = simulate({});
    expect(rows.every((r) => r.status === 'not_configured')).toBe(true);
    expect(rows.every((r) => r.providerCompensation === null)).toBe(true);
  });
});
