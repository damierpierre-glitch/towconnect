// The parts of next/headers the finance actions touch.
//
// Only the TRANSPORT is replaced. The actions still run against a real
// Supabase session belonging to a real user, so RLS, policies and triggers
// are exercised exactly as they are in the app — see supabase-server.ts.
import { currentHeaders } from '../session';

export async function headers() {
  return {
    get(name: string): string | null {
      return currentHeaders()[name.toLowerCase()] ?? null;
    },
  };
}

export async function cookies() {
  return {
    getAll() {
      return [] as { name: string; value: string }[];
    },
    // Typed as the real cookie store's setter so the module it stands in for
    // still typechecks. Nothing is stored: the harness carries its session in
    // a token, not in cookies.
    set: (() => {}) as (name: string, value: string, options?: unknown) => void,
  };
}
