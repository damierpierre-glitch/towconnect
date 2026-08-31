import { notFound, redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { getPaymentForRequest } from '@/lib/actions/payments';
import { Receipt } from './Receipt';

export default async function ReceiptPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect('/login');

  // RLS ("requests: user reads own") already scopes this to the caller's
  // own row — a request id belonging to someone else simply returns no row,
  // not a leaked receipt.
  const { data: request } = await supabase.from('requests').select('*').eq('id', id).single();
  if (!request) notFound();

  let driverName: string | null = null;
  if (request.driver_id) {
    const { data: driverProfile } = await supabase
      .from('profiles')
      .select('full_name')
      .eq('id', request.driver_id)
      .maybeSingle();
    driverName = driverProfile?.full_name ?? null;
  }

  const payment = await getPaymentForRequest(id);

  return <Receipt request={request} driverName={driverName} payment={payment} />;
}
