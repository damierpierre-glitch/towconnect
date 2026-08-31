'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Elements, PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js';
import { useLanguage } from '@/lib/i18n/LanguageProvider';
import { useToast } from '@/components/ToastProvider';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { getStripeClient } from '@/lib/stripe/client';
import {
  createSetupIntent,
  listPaymentMethods,
  removePaymentMethod,
  setDefaultPaymentMethod,
  type SavedPaymentMethod,
} from '@/lib/actions/payments';

export function PaymentMethodsManager({
  configured,
  initialMethods,
}: {
  configured: boolean;
  initialMethods: SavedPaymentMethod[];
}) {
  const { t, lang } = useLanguage();
  const { showToast } = useToast();
  const [methods, setMethods] = useState(initialMethods);
  const [adding, setAdding] = useState(initialMethods.length === 0);
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function refresh() {
    const fresh = await listPaymentMethods();
    setMethods(fresh);
  }

  async function startAdd() {
    try {
      const { clientSecret: secret } = await createSetupIntent();
      setClientSecret(secret);
      setAdding(true);
    } catch {
      showToast('⚠️', t('error_generic'));
    }
  }

  async function handleSetDefault(id: string) {
    setBusyId(id);
    try {
      await setDefaultPaymentMethod(id);
      await refresh();
    } catch {
      showToast('⚠️', t('error_generic'));
    } finally {
      setBusyId(null);
    }
  }

  async function handleRemove(id: string) {
    setBusyId(id);
    try {
      await removePaymentMethod(id);
      setMethods((prev) => prev.filter((m) => m.id !== id));
    } catch {
      showToast('⚠️', t('error_generic'));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="max-w-2xl mx-auto px-6 py-8">
      <div className="flex justify-between items-start mb-6 flex-wrap gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold">{t('pm_title')}</h1>
          <p className="text-text-2 text-sm mt-1">{t('pm_sub')}</p>
        </div>
        <Link href="/request" className="text-sm text-orange font-medium">
          {lang === 'fr' ? '← Retour à la demande' : '← Back to request'}
        </Link>
      </div>

      {!configured ? (
        <Card>
          <p className="text-sm text-muted text-center py-2">{t('pm_unavailable')}</p>
        </Card>
      ) : (
        <>
          <div className="flex flex-col gap-3 mb-4">
            {methods.map((m) => (
              <Card key={m.id} className={m.isDefault ? 'border-orange' : ''}>
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-display font-bold uppercase">{m.brand}</span>
                      <span className="text-text-2">•••• {m.last4}</span>
                      {m.isDefault ? <Badge tone="orange">⭐ {t('pm_default')}</Badge> : null}
                    </div>
                    <p className="text-xs text-muted">
                      {lang === 'fr' ? 'Expire' : 'Expires'} {String(m.expMonth).padStart(2, '0')}/{m.expYear}
                    </p>
                  </div>
                  <div className="flex gap-2 flex-wrap">
                    {!m.isDefault ? (
                      <Button
                        variant="secondary"
                        className="!px-3 !py-1.5 text-xs"
                        disabled={busyId === m.id}
                        onClick={() => handleSetDefault(m.id)}
                      >
                        {t('pm_set_default')}
                      </Button>
                    ) : null}
                    <Button
                      variant="red"
                      className="!px-3 !py-1.5 text-xs"
                      disabled={busyId === m.id}
                      onClick={() => handleRemove(m.id)}
                    >
                      {t('pm_remove')}
                    </Button>
                  </div>
                </div>
              </Card>
            ))}

            {methods.length === 0 && !adding ? (
              <Card>
                <p className="text-sm text-muted text-center py-2">{t('pm_empty')}</p>
              </Card>
            ) : null}
          </div>

          {adding && clientSecret ? (
            <Card orange>
              <AddCardForm
                clientSecret={clientSecret}
                showCancel={methods.length > 0}
                onCancel={() => {
                  setAdding(false);
                  setClientSecret(null);
                }}
                onSaved={async () => {
                  setAdding(false);
                  setClientSecret(null);
                  await refresh();
                }}
              />
            </Card>
          ) : (
            <Button variant="secondary" full onClick={startAdd}>
              {t('pm_add')}
            </Button>
          )}
        </>
      )}
    </div>
  );
}

function AddCardForm({
  clientSecret,
  showCancel,
  onCancel,
  onSaved,
}: {
  clientSecret: string;
  showCancel: boolean;
  onCancel: () => void;
  onSaved: () => void;
}) {
  return (
    <Elements stripe={getStripeClient()} options={{ clientSecret }}>
      <AddCardFormInner showCancel={showCancel} onCancel={onCancel} onSaved={onSaved} />
    </Elements>
  );
}

function AddCardFormInner({
  showCancel,
  onCancel,
  onSaved,
}: {
  showCancel: boolean;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const { t } = useLanguage();
  const { showToast } = useToast();
  const stripe = useStripe();
  const elements = useElements();
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!stripe || !elements) return;
    setSaving(true);
    const { error } = await stripe.confirmSetup({ elements, redirect: 'if_required' });
    setSaving(false);
    if (error) {
      showToast('⚠️', error.message ?? t('error_generic'));
      return;
    }
    onSaved();
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <PaymentElement />
      <div className="flex gap-2">
        {showCancel ? (
          <Button type="button" variant="secondary" className="flex-1" onClick={onCancel}>
            {t('pm_cancel')}
          </Button>
        ) : null}
        <Button type="submit" className="flex-[2]" disabled={!stripe || saving}>
          {saving ? '…' : t('pm_save')}
        </Button>
      </div>
    </form>
  );
}
