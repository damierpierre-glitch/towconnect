import 'server-only';
import Stripe from 'stripe';

// Lazy singleton, not instantiated at module load: mirrors the existing
// MAPBOX_TOKEN-optional pattern (lib/mapbox.ts) — the app must still build
// and run every non-payment feature with no Stripe keys configured at all.
// Every payment code path calls this and gets a clear, actionable error
// instead of a silent crash or a fabricated key.
let stripe: Stripe | null = null;

export function isStripeConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

export function getStripe(): Stripe {
  if (stripe) return stripe;
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    throw new Error(
      'STRIPE_SECRET_KEY is not configured — payments are unavailable until it is set. See .env.local.example.'
    );
  }
  stripe = new Stripe(secretKey);
  return stripe;
}
