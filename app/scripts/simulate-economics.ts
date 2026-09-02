// Prints the economic comparison table for TOWCONNECT_PHASE7_REPORT.md.
//
// EVERY ROW HERE IS HYPOTHETICAL.
// None of these configurations is active, none is stored, and none is a
// recommendation. They exist so that a decision about the commission can be
// made by looking at its consequences instead of at a number. Running this
// script changes nothing in the database — it imports the same pure module
// the server uses and prints arithmetic.
//
//   npx tsx scripts/simulate-economics.ts
import { SIMULATION_AMOUNTS, settle, type EconomicConfig } from '../src/lib/economics';

// Stripe's published Canadian card rate at the time of writing, used as the
// processing cost in the scenarios that model one. It is a cost we are
// charged, not a rate we set.
const STRIPE_CA = { paymentProcessingPercent: 2.9, paymentProcessingFixed: 0.3 };

const SCENARIOS: { label: string; config: EconomicConfig }[] = [
  { label: 'Nothing configured', config: {} },
  { label: '10 % commission', config: { commissionPercent: 10, ...STRIPE_CA } },
  { label: '15 % commission', config: { commissionPercent: 15, ...STRIPE_CA } },
  { label: '20 % commission', config: { commissionPercent: 20, ...STRIPE_CA } },
  { label: '25 % commission', config: { commissionPercent: 25, ...STRIPE_CA } },
  { label: '15 % + $2 fixed', config: { commissionPercent: 15, commissionFixed: 2, ...STRIPE_CA } },
  {
    label: '20 % capped at $40',
    config: { commissionPercent: 20, commissionMax: 40, ...STRIPE_CA },
  },
  {
    label: '20 %, provider floor $70',
    config: { commissionPercent: 20, providerMinimum: 70, ...STRIPE_CA },
  },
];

const money = (n: number | null) => (n == null ? '—' : `$${n.toFixed(2)}`);
const pct = (n: number | null) => (n == null ? '—' : `${n.toFixed(1)} %`);

console.log('| Scenario | Customer | Provider | Processing | TowConnect | Margin % |');
console.log('| --- | ---: | ---: | ---: | ---: | ---: |');

for (const scenario of SCENARIOS) {
  for (const amount of SIMULATION_AMOUNTS) {
    const b = settle(amount, scenario.config);
    console.log(
      `| ${scenario.label} | $${amount.toFixed(2)} | ${money(b.providerCompensation)} | ` +
        `${money(b.paymentProcessingCost)} | ${money(b.towconnectMargin)} | ${pct(b.towconnectMarginPercent)} |`
    );
  }
}

// The identity is what makes the table trustworthy: if these three do not add
// back up to the customer price, the table is fiction.
let worst = 0;
for (const scenario of SCENARIOS) {
  for (const amount of SIMULATION_AMOUNTS) {
    const b = settle(amount, scenario.config);
    if (b.status !== 'computed') continue;
    const sum = (b.providerCompensation ?? 0) + (b.paymentProcessingCost ?? 0) + (b.towconnectMargin ?? 0);
    worst = Math.max(worst, Math.abs(sum - b.customerPrice));
  }
}
console.log(`\nLargest identity drift across every row: $${worst.toFixed(4)}`);
