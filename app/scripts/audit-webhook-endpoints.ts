// Which Stripe endpoints exist, and how are they doing.
//
//   npx tsx scripts/audit-webhook-endpoints.ts
//
// Stripe returns a webhook endpoint's signing secret ONLY at creation. That
// is deliberate on Stripe's part and it is why this script cannot tell you
// whether the local secret matches: it can only tell you which endpoints
// exist, where they point, and whether Stripe is managing to deliver to them.
//
// Nothing here prints a secret, because nothing here can obtain one.
import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });
loadEnv();
import Stripe from 'stripe';

const key = process.env.STRIPE_SECRET_KEY;
if (!key) {
  console.error('STRIPE_SECRET_KEY: missing');
  process.exit(1);
}
if (!key.startsWith('sk_test_') && !key.startsWith('rk_test_')) {
  console.error('Refusing to run against a non-test key.');
  process.exit(1);
}

const stripe = new Stripe(key);

async function main() {
  const endpoints = await stripe.webhookEndpoints.list({ limit: 100 });

  console.log(`\nStripe test-mode webhook endpoints: ${endpoints.data.length}\n`);
  for (const e of endpoints.data) {
    console.log(`  ${e.id}`);
    console.log(`    url        ${e.url}`);
    console.log(`    status     ${e.status}`);
    console.log(`    api        ${e.api_version ?? '(account default)'}`);
    console.log(`    events     ${e.enabled_events.length} (${e.enabled_events.slice(0, 4).join(', ')}${e.enabled_events.length > 4 ? ', …' : ''})`);
    console.log(`    created    ${new Date(e.created * 1000).toISOString()}`);
    console.log(`    secret     never returned after creation — compare by fingerprint instead`);
    console.log('');
  }

  // Delivery health, which is the practical answer to "is the deployment's
  // secret the right one": Stripe signs with the endpoint's own secret, so a
  // successfully delivered event is proof that the receiving environment
  // holds it.
  const since = Math.floor(Date.now() / 1000) - 24 * 3600;
  const events = await stripe.events.list({ limit: 100, created: { gte: since } });
  const pending = events.data.filter((e) => (e.pending_webhooks ?? 0) > 0);
  console.log(`Events in the last 24h: ${events.data.length}`);
  console.log(`  still pending delivery: ${pending.length}`);
  if (pending.length) {
    for (const e of pending.slice(0, 5)) {
      console.log(`    ${e.id}  ${e.type}  pending_webhooks=${e.pending_webhooks}`);
    }
  }
  console.log('');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
