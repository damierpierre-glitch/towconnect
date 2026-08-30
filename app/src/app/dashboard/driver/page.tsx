import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { roleHome } from '@/lib/roleHome';
import { DriverDashboard } from './DriverDashboard';

export default async function DriverDashboardPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, full_name')
    .eq('id', user.id)
    .single();

  if (!profile || profile.role !== 'driver') redirect(roleHome(profile?.role ?? 'user'));

  const { data: driverProfile } = await supabase
    .from('driver_profiles')
    .select('*')
    .eq('profile_id', user.id)
    .single();

  if (!driverProfile) redirect('/login');

  return (
    <DriverDashboard
      driverId={user.id}
      fullName={profile.full_name}
      initialDriverProfile={driverProfile}
    />
  );
}
