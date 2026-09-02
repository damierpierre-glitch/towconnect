import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { roleHome } from '@/lib/roleHome';
import { getAdminFinanceOverview } from '@/lib/actions/finance';
import { getConnectAvailability } from '@/lib/actions/connect';
import { FinanceAdmin } from './FinanceAdmin';

export default async function AdminFinancePage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single();
  if (!profile || profile.role !== 'admin') redirect(roleHome(profile?.role ?? 'user'));

  const [overview, connect] = await Promise.all([getAdminFinanceOverview(), getConnectAvailability()]);

  return <FinanceAdmin overview={overview} connect={connect} />;
}
