import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { roleHome } from '@/lib/roleHome';
import type { DispatchOffer, TowRequest } from '@/lib/supabase/types';
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
  const [{ data: offers }, { data: requests }] = await Promise.all([
    supabase.from('dispatch_offers').select('*').eq('driver_id', user.id),
    supabase.from('requests').select('*').eq('driver_id', user.id).in('status', ['completed', 'cancelled']),
  ]);

  return (
    <DriverPerformance
      rating={driverProfile?.rating ?? 5}
      totalServices={driverProfile?.total_services ?? 0}
      offers={(offers ?? []) as DispatchOffer[]}
      requests={(requests ?? []) as TowRequest[]}
    />
  );
}
