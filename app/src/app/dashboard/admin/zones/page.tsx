import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { roleHome } from '@/lib/roleHome';
import { listRegulatedZones, listZoneAudit } from '@/lib/actions/zones';
import { ZonesAdmin } from './ZonesAdmin';

export default async function AdminZonesPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single();
  if (!profile || profile.role !== 'admin') redirect(roleHome(profile?.role ?? 'user'));

  const [zones, audit, companies] = await Promise.all([
    listRegulatedZones(),
    listZoneAudit(30),
    supabase.from('companies').select('id, name, display_name').order('name'),
  ]);

  return <ZonesAdmin zones={zones} audit={audit} companies={companies.data ?? []} />;
}
