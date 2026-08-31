'use client';

import { useEffect, useState } from 'react';
import { useLanguage } from '@/lib/i18n/LanguageProvider';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { getStripeClient } from '@/lib/stripe/client';
import { resumeAfterPaymentAction } from '@/lib/actions/requests';
import type { PaymentStatus } from '@/lib/supabase/types';

// Shown only for the two payment outcomes that need the rider to do
// something before dispatch can start: an issuer-mandated authentication
// step (requires_action) or a declined authorization (failed). The far more
// common case — authorized on the first try — never routes through this
// screen at all. RequestFlow owns the retry (it needs to re-create the
// authorization and may receive a new clientSecret), this component only
// handles the 3DS challenge itself and asks the parent to retry/give up.
export function StepPayment({
  requestId,
  status,
  clientSecret,
  paymentMethodId,
  retrying,
  onResolved,
  onRetry,
  onGiveUp,
}: {
  requestId: string;
  status: PaymentStatus;
  clientSecret: string | null;
  paymentMethodId: string | null;
  retrying: boolean;
  onResolved: () => void;
  onRetry: () => void;
  onGiveUp: () => void;
}) {
  const { t } = useLanguage();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (status !== 'requires_action' || !clientSecret) return;
    let cancelled = false;

    async function confirm() {
      setConfirming(true);
      setError(false);
      const stripe = await getStripeClient();
      if (!stripe) {
        setError(true);
        setConfirming(false);
        return;
      }
      // The card must be named again: an off-session 3DS failure leaves the
      // PaymentIntent at requires_payment_method, so confirming without it
      // would error rather than show the challenge.
      const result = await stripe.confirmCardPayment(
        clientSecret!,
        paymentMethodId ? { payment_method: paymentMethodId } : undefined
      );
      if (cancelled) return;
      if (result.error) {
        setError(true);
        setConfirming(false);
        return;
      }
      // Never trust the browser result alone — re-check with our own
      // server, which re-verifies directly against Stripe.
      const resolvedStatus = await resumeAfterPaymentAction(requestId);
      if (cancelled) return;
      setConfirming(false);
      if (resolvedStatus === 'authorized') onResolved();
      else setError(true);
    }

    confirm();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, clientSecret, paymentMethodId, requestId]);

  const working = confirming || retrying;

  return (
    <Card className="text-center py-10">
      {status === 'requires_action' ? (
        <>
          <div className="text-4xl mb-3">🔐</div>
          <h3 className="font-display text-lg font-bold mb-1">{t('payment_action_title')}</h3>
          <p className="text-sm text-muted mb-6">{t('payment_action_sub')}</p>
        </>
      ) : (
        <>
          <div className="text-4xl mb-3">⚠️</div>
          <h3 className="font-display text-lg font-bold mb-1">{t('payment_failed_title')}</h3>
          <p className="text-sm text-muted mb-6">{t('payment_failed_sub')}</p>
        </>
      )}

      {error ? <p className="text-sm text-red mb-4">{t('payment_error')}</p> : null}

      <div className="flex flex-col gap-2 max-w-xs mx-auto">
        <Button full disabled={working} onClick={onRetry}>
          {working ? '…' : `💳 ${t('payment_retry')}`}
        </Button>
        <Button variant="secondary" full disabled={working} onClick={onGiveUp}>
          {t('btn_cancel')}
        </Button>
      </div>
    </Card>
  );
}
