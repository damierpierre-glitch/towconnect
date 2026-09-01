import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { roleHome } from '@/lib/roleHome';
import { DriverProfile } from './DriverProfile';

export default async function DriverProfilePage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: profile } = await supabase.from('profiles').select('role, full_name, phone').eq('id', user.id).single();
  if (!profile || profile.role !== 'driver') redirect(roleHome(profile?.role ?? 'user'));

  const { data: driverProfile } = await supabase.from('driver_profiles').select('*').eq('profile_id', user.id).single();
  if (!driverProfile) redirect('/login');

  return <DriverProfile fullName={profile.full_name} phone={profile.phone} driverProfile={driverProfile} />;
}
