import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { roleHome } from '@/lib/roleHome';
import { listAcceptedDriverRequests } from '@/lib/actions/driverHistory';
import type { DispatchOffer } from '@/lib/supabase/types';
import { DriverPerformance } from './DriverPerformance';

export default async function DriverPerformancePage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single();
  if (!profile || profile.role !== 'driver') redirect(roleHome(profile?.role ?? 'user'));

  const { data: driverProfile } = await supabase.from('driver_profiles').select('rating, total_services').eq('profile_id', user.id).single();

  // "driver reads own" has no status filter (0006_smart_dispatch.sql) — every
  // offer this driver was ever sent, which is exactly what an acceptance
  // rate / response time needs.
  const [{ data: offers }, requests] = await Promise.all([
    supabase.from('dispatch_offers').select('*').eq('driver_id', user.id),
    // Only jobs actually taken: a request the rider cancelled while this
    // driver was still deciding is not a job they did, and counting it made
    // their completion rate worse for someone else's change of mind.
    listAcceptedDriverRequests(user.id, ['completed', 'cancelled']),
  ]);

  return (
    <DriverPerformance
      rating={driverProfile?.rating ?? 5}
      totalServices={driverProfile?.total_services ?? 0}
      offers={(offers ?? []) as DispatchOffer[]}
      requests={requests}
    />
  );
}
