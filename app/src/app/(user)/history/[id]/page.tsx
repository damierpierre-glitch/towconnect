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

  // Both are scoped by RLS to this customer's own request — "supplements:
  // request participants read" (0027) and "refunds: customer reads their own"
  // (0036). Being refunded without being told is its own kind of failure.
  const [{ data: supplements }, { data: refunds }] = await Promise.all([
    supabase.from('request_supplements').select('*').eq('request_id', id).order('created_at'),
    supabase.from('refunds').select('*').eq('request_id', id).order('created_at'),
  ]);

  return (
    <Receipt
      request={request}
      driverName={driverName}
      payment={payment}
      supplements={supplements ?? []}
      refunds={refunds ?? []}
    />
  );
}
