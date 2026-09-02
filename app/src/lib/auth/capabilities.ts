import 'server-only';
import { createClient } from '@/lib/supabase/server';
import type { AdminCapability } from '@/lib/supabase/types';

// The capability guard, in one place.
//
// It lived in three files before Phase 10 — operations, exports and now
// pilot — which is three chances for one of them to drift into checking
// something slightly different. It is not exported from a `'use server'`
// module on purpose: everything exported from one of those becomes a
// callable endpoint, and a guard is not an endpoint.
//
// WHAT THIS IS AND IS NOT
// The database refuses unauthorized work on its own, null-safely (0039), in
// every function these callers use. This exists so the UI can hide what
// somebody cannot do and so a server action can fail with a sentence instead
// of a Postgres error. It is not the protection.

export const ALL_CAPABILITIES: AdminCapability[] = ['super_admin', 'operations', 'finance', 'support'];

/** Throws unless the signed-in user holds the capability. Returns their id. */
export async function requireCapability(capability: AdminCapability): Promise<string> {
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

/** Everything the signed-in user holds. Used to render, never to allow. */
export async function heldCapabilities(): Promise<Set<AdminCapability>> {
  const supabase = await createClient();
  const held = new Set<AdminCapability>();
  for (const capability of ALL_CAPABILITIES) {
    const { data } = await supabase.rpc('has_admin_capability' as never, {
      p_capability: capability,
    } as never);
    if (data === true) held.add(capability);
  }
  return held;
}

/**
 * True when the caller holds ANY of these.
 *
 * Several Phase 10 screens are readable by more than one role — health by
 * operations, the funnel by operations or finance — and the database
 * functions say so themselves. This mirrors that, rather than inventing a
 * second, stricter answer in the UI.
 */
export async function requireAnyCapability(capabilities: AdminCapability[]): Promise<string> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');

  for (const capability of capabilities) {
    const { data } = await supabase.rpc('has_admin_capability' as never, {
      p_capability: capability,
    } as never);
    if (data === true) return user.id;
  }
  throw new Error(`This action needs one of: ${capabilities.join(', ')}.`);
}
