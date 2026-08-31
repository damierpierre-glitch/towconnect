import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { roleHome } from '@/lib/roleHome';
import { isStripeConfigured, listPaymentMethods } from '@/lib/actions/payments';
import { PaymentMethodsManager } from './PaymentMethodsManager';

export default async function PaymentMethodsPage() {
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

  const configured = isStripeConfigured();
  const methods = configured ? await listPaymentMethods() : [];

  return <PaymentMethodsManager configured={configured} initialMethods={methods} />;
}
