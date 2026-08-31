import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { roleHome } from '@/lib/roleHome';
import { getActiveRequest } from '@/lib/actions/requests';
import { getPaymentForRequest } from '@/lib/actions/payments';
import { getVehicles } from '@/lib/actions/vehicles';
import type { PaymentStatus } from '@/lib/supabase/types';
import { RequestFlow } from './RequestFlow';

// A request whose payment never resolved is still 'pending', so it looks
// active — but dispatch deliberately never ran for it. Resuming such a
// request straight into the tracking screen showed the rider "Searching for
// the best tow truck…" forever, with no driver ever coming and no way to
// act. Found during the live end-to-end run; see
// TOWCONNECT_LIVE_VALIDATION_REPORT.md.
const UNRESOLVED_PAYMENT: PaymentStatus[] = ['requires_payment_method', 'requires_action', 'failed'];

export default async function RequestPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect('/login');

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  if (profile && profile.role !== 'user') redirect(roleHome(profile.role));

  // Fetched server-side, scoped to this user by RLS: a connected user with an
  // active intervention lands directly back in tracking, never on a blank
  // form or a marketing screen.
  const [vehicles, activeRequest] = await Promise.all([getVehicles(), getActiveRequest()]);

  // Only relevant while the request is still searching and driverless — once
  // a driver has accepted, tracking is the right screen regardless.
  let unresolvedPaymentStatus: PaymentStatus | null = null;
  if (activeRequest && activeRequest.status === 'pending' && !activeRequest.driver_id) {
    const payment = await getPaymentForRequest(activeRequest.id);
    if (payment && UNRESOLVED_PAYMENT.includes(payment.status)) {
      unresolvedPaymentStatus = payment.status;
    }
  }

  return (
    <RequestFlow
      userId={user.id}
      vehicles={vehicles}
      initialActiveRequest={activeRequest}
      initialUnresolvedPaymentStatus={unresolvedPaymentStatus}
    />
  );
}
