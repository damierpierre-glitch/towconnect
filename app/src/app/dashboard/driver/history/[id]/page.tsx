import { notFound, redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { roleHome } from '@/lib/roleHome';
import { JobDetail } from './JobDetail';

export default async function DriverJobDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single();
  if (!profile || profile.role !== 'driver') redirect(roleHome(profile?.role ?? 'user'));

  // RLS ("requests: driver reads their own assigned requests") already
  // scopes this to the caller's own row — a job id belonging to a different
  // driver simply returns no row.
  const { data: request } = await supabase.from('requests').select('*').eq('id', id).eq('driver_id', user.id).single();
  if (!request) notFound();

  const { data: clientProfile } = await supabase.from('profiles').select('full_name').eq('id', request.user_id).maybeSingle();

  return <JobDetail request={request} clientName={clientProfile?.full_name ?? null} />;
}
