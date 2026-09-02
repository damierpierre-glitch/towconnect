'use server';

import { createClient } from '@/lib/supabase/server';
import type { RequestStatus, TowRequest } from '@/lib/supabase/types';

// THE RULE, IN ONE PLACE
// A driver's history is the jobs they actually took, not the jobs they were
// once offered.
//
// `requests.driver_id` is set when the OFFER is made (0006), and it
// deliberately survives two paths that never reached acceptance:
// expire_offer_on_cancel() leaves it in place when the rider cancels, and
// cleanup_stale() leaves it when a pending request expires. So filtering on
// driver_id alone put "rider cancelled while I was still deciding" into a
// driver's completed-and-cancelled history, and into the denominator of their
// performance stats.
//
// The discriminator is whether the request ever reached 'matched', read from
// request_events — the same fact Phase 5.1 used to decide when a driver may
// read a rider's profile, and for the same reason: request_events is written
// by a trigger on `requests` itself, so it captures every path to 'matched',
// and it is append-only, so the evidence survives the job being completed or
// cancelled afterwards.
//
// Using the same source as the privacy rule is deliberate. Two different
// answers to "did this driver actually take this job?" would eventually
// disagree, and the version that disagreed would be the one nobody tested.
export async function listAcceptedDriverRequests(
  driverId: string,
  statuses: RequestStatus[]
): Promise<TowRequest[]> {
  const supabase = await createClient();

  // `!inner` turns the embedded request_events into an inner join, so a
  // request with no 'matched' event drops out of the parent result entirely.
  const { data, error } = await supabase
    .from('requests')
    .select('*, request_events!inner(status)')
    .eq('driver_id', driverId)
    .eq('request_events.status', 'matched')
    .in('status', statuses)
    .order('created_at', { ascending: false });

  if (error) throw error;

  // Drop the embedded rows: they were a filter, not data the screens want.
  return (data ?? []).map((row) => {
    const request = { ...(row as TowRequest & { request_events?: unknown }) };
    delete request.request_events;
    return request as TowRequest;
  });
}
