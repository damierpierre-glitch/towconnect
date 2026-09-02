// Deterministic date formatting for anything rendered on both the server and
// the client.
//
// `toLocaleDateString()` / `toLocaleString()` resolve against the host's ICU
// data and time zone, and Node's answer is routinely not the browser's — so
// a timestamp formatted that way inside a component hydrates as a mismatch.
// The admin zones page reproduced exactly that. These helpers read the
// components off the ISO string instead, which is the same text everywhere.
//
// The trade-off is deliberate: an ISO-style date is less pretty than a
// localized one, and it is a date an operator can compare, sort and paste
// into a ticket — which is what "last verified on" is for.

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return iso.slice(0, 10);
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  // "2026-09-01T14:03:55.893736+00:00" -> "2026-09-01 14:03 UTC"
  const [date, rest] = iso.split('T');
  if (!rest) return date;
  return `${date} ${rest.slice(0, 5)} UTC`;
}
