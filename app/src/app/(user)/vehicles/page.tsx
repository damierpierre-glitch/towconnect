import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { roleHome } from '@/lib/roleHome';
import { getVehicles } from '@/lib/actions/vehicles';
import { VehiclesManager } from './VehiclesManager';

export default async function VehiclesPage() {
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

  const vehicles = await getVehicles();

  return <VehiclesManager initialVehicles={vehicles} />;
}
