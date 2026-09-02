import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { roleHome } from '@/lib/roleHome';
import { listAcceptedDriverRequests } from '@/lib/actions/driverHistory';
import { DriverHistory } from './DriverHistory';

export default async function DriverHistoryPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single();
  if (!profile || profile.role !== 'driver') redirect(roleHome(profile?.role ?? 'user'));

  // Jobs this driver actually took. The earlier version filtered on
  // driver_id alone, which also caught requests the rider cancelled while the
  // driver was still deciding — driver_id is set at OFFER time and survives a
  // cancellation. See listAcceptedDriverRequests().
  const requests = await listAcceptedDriverRequests(user.id, ['completed', 'cancelled']);

  return <DriverHistory requests={requests} />;
}
