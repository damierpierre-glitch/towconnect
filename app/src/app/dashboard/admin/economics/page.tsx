import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { roleHome } from '@/lib/roleHome';
import { listPricingAudit, listPricingConfigs } from '@/lib/actions/economics';
import { EconomicsAdmin } from './EconomicsAdmin';

export default async function AdminEconomicsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single();
  if (!profile || profile.role !== 'admin') redirect(roleHome(profile?.role ?? 'user'));

  const [configs, audit] = await Promise.all([listPricingConfigs(), listPricingAudit(30)]);

  return <EconomicsAdmin configs={configs} audit={audit} />;
}
