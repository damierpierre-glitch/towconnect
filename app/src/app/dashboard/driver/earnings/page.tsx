import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { roleHome } from '@/lib/roleHome';
import type { ProviderLedgerEntry, TowRequest } from '@/lib/supabase/types';
import { DriverEarnings } from './DriverEarnings';

export default async function DriverEarningsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single();
  if (!profile || profile.role !== 'driver') redirect(roleHome(profile?.role ?? 'user'));

  // The ledger, not the requests table, is what a driver is actually owed.
  // A completed job's price is what the CUSTOMER paid; the entries below are
  // what reached this driver, including supplements and corrections.
  // "ledger: driver reads their own entries" (0035) is what scopes this — the
  // filter is a convenience, not the protection.
  const { data: entries } = await supabase
    .from('provider_ledger_entries')
    .select('*')
    .eq('driver_id', user.id)
    .order('created_at', { ascending: false });

  const requestIds = Array.from(
    new Set((entries ?? []).map((e) => e.request_id).filter((id): id is string => Boolean(id)))
  );

  const { data: requests } = requestIds.length
    ? await supabase.from('requests').select('*').in('id', requestIds)
    : { data: [] };

  // Completed jobs with nothing in the ledger are jobs accepted while no
  // economic configuration was active. They are shown, without an amount,
  // rather than hidden — a driver whose work is missing from their own
  // earnings page has no way to ask about it.
  const { data: completed } = await supabase
    .from('requests')
    .select('*')
    .eq('driver_id', user.id)
    .eq('status', 'completed')
    .order('created_at', { ascending: false })
    .limit(50);

  return (
    <DriverEarnings
      entries={(entries ?? []) as ProviderLedgerEntry[]}
      requests={(requests ?? []) as TowRequest[]}
      completed={(completed ?? []) as TowRequest[]}
    />
  );
}
