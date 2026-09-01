import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { roleHome } from '@/lib/roleHome';
import type { TowRequest } from '@/lib/supabase/types';
import { DriverHistory } from './DriverHistory';

export default async function DriverHistoryPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single();
  if (!profile || profile.role !== 'driver') redirect(roleHome(profile?.role ?? 'user'));

  // Every request ever matched to this driver — driver_id only lands on a
  // row once it's been offered, and is cleared back to null on a decline or
  // timeout, so what's left here is real history: completed jobs and jobs
  // the rider cancelled after matching, not passed-over offers.
  const { data: requests } = await supabase
    .from('requests')
    .select('*')
    .eq('driver_id', user.id)
    .in('status', ['completed', 'cancelled'])
    .order('created_at', { ascending: false });

  return <DriverHistory requests={(requests ?? []) as TowRequest[]} />;
}
