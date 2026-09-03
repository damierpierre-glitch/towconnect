// Who the harness is currently acting as.
//
// The finance server actions read their caller from `@/lib/supabase/server`,
// which in the app builds a Supabase client out of the request's cookies. The
// harness cannot produce a Next request, so it swaps that ONE module for a
// client built from a real signed-in user's access token instead.
//
// What that changes: the transport. What it does not change: the identity.
// Every action still runs as a genuine authenticated user, so RLS policies,
// SECURITY DEFINER guards and triggers all fire exactly as they do in
// production. An action that would be refused in the app is refused here.

let accessToken: string | null = null;
// Carried only when an action needs the client to hold a real SESSION rather
// than just present a bearer token. auth.updateUser() is the case that
// forced this: it reads the client's own session state, so a client built
// with an Authorization header alone answers "Auth session missing".
let refreshToken: string | null = null;
let label = 'anonymous';
let requestHeaders: Record<string, string> = { host: 'localhost:3000', 'x-forwarded-proto': 'http' };

export function actAs(token: string | null, who: string, refresh?: string | null): void {
  accessToken = token;
  refreshToken = refresh ?? null;
  label = who;
}

export function currentRefreshToken(): string | null {
  return refreshToken;
}

export function currentToken(): string | null {
  return accessToken;
}

export function currentActor(): string {
  return label;
}

export function currentHeaders(): Record<string, string> {
  return requestHeaders;
}

export function setRequestHeaders(next: Record<string, string>): void {
  requestHeaders = next;
}
