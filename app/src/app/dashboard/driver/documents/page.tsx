import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { roleHome } from '@/lib/roleHome';
import { listDriverDocuments } from '@/lib/actions/driverDocuments';
import { DriverDocuments } from './DriverDocuments';

export default async function DriverDocumentsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single();
  if (!profile || profile.role !== 'driver') redirect(roleHome(profile?.role ?? 'user'));

  const documents = await listDriverDocuments();

  return <DriverDocuments initialDocuments={documents} />;
}
