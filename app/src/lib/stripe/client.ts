'use client';

import { loadStripe, type Stripe } from '@stripe/stripe-js';

// Publishable key only — safe to expose to the browser (NEXT_PUBLIC_*).
// Same optional-until-configured pattern as MAPBOX_TOKEN: components using
// this must handle a null resolved value (no key set) without crashing.
let stripePromise: Promise<Stripe | null> | null = null;

export function getStripeClient(): Promise<Stripe | null> {
  const publishableKey = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
  if (!publishableKey) return Promise.resolve(null);
  if (!stripePromise) stripePromise = loadStripe(publishableKey);
  return stripePromise;
}

export const STRIPE_CONFIGURED = Boolean(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY);
