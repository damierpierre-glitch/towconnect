// Control characters are matched by codepoint escape rather than typed
// literally, so the source stays readable and copy-paste safe.
const CONTROL_OR_SPACE = /[\u0000-\u0020\u007f]/;

/**
 * Where `?next=` is allowed to send somebody after an auth callback.
 *
 * It has to be a path on this site and nothing else. Three shapes are refused
 * explicitly, and the first is the one that catches people out:
 *
 *   `//evil.example`   a protocol-relative URL. Concatenated onto an origin it
 *                      still looks like a path to the code doing the
 *                      concatenating, and enough clients resolve it as a host
 *                      to make it a real open-redirect primitive.
 *   `https://…`        an absolute URL, for the obvious reason.
 *   `/\evil.example`   a backslash, which several browsers normalise to `/`
 *                      before parsing — turning it into the first case.
 *
 * Whitespace and control characters go too: they are how a second value gets
 * smuggled past a naive parser further down the line. Hyphens are deliberately
 * fine, since several real routes contain them.
 *
 * Anything that does not survive becomes the site root, which is never wrong,
 * only unhelpful. Kept in its own module so it can be unit-tested: a redirect
 * guard that has never been fed a hostile string is a guard nobody has checked.
 */
export function safeNext(raw: string | null | undefined): string {
  if (!raw) return '/';
  if (!raw.startsWith('/')) return '/';
  if (raw.startsWith('//')) return '/';
  if (raw.includes('\\')) return '/';
  if (CONTROL_OR_SPACE.test(raw)) return '/';
  return raw;
}
