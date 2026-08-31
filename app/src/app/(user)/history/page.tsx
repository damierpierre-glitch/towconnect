import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { roleHome } from '@/lib/roleHome';
import type { TowRequest } from '@/lib/supabase/types';
import { HistoryList } from './HistoryList';

export default async function HistoryPage() {
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

  const { data: requests } = await supabase
    .from('requests')
    .select('*')
    .eq('user_id', user.id)
    .eq('status', 'completed')
    .order('created_at', { ascending: false });

  return <HistoryList completed={(requests ?? []) as TowRequest[]} />;
}
