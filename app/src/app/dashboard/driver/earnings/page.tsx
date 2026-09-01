import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { roleHome } from '@/lib/roleHome';
import type { TowRequest } from '@/lib/supabase/types';
import { DriverEarnings } from './DriverEarnings';

export default async function DriverEarningsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single();
  if (!profile || profile.role !== 'driver') redirect(roleHome(profile?.role ?? 'user'));

  const { data: completed } = await supabase
    .from('requests')
    .select('*')
    .eq('driver_id', user.id)
    .eq('status', 'completed')
    .order('created_at', { ascending: false });

  return <DriverEarnings completed={(completed ?? []) as TowRequest[]} />;
}
