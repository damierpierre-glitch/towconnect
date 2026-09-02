'use client';

import { useCallback, useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useLanguage } from '@/lib/i18n/LanguageProvider';
import { useToast } from '@/components/ToastProvider';
import { Button } from '@/components/ui/Button';
import { toMoney } from '@/lib/pricing';
import { respondToSupplement, withdrawSupplement } from '@/lib/actions/supplements';
import type { RequestSupplement, ServiceSupplementType } from '@/lib/supabase/types';
import { errorMessageKey } from '@/lib/errors';

// Both sides of a supplement, from the same component.
//
// The customer sees every proposal and is the only party who can accept one:
// that is enforced by a trigger in 0027, not by hiding a button here. The
// driver sees what they proposed and whether it has been answered — never an
// "approve" control, because there is nothing for them to approve.
export function SupplementsPanel({
  requestId,
  role,
  basePrice,
}: {
  requestId: string;
  role: 'customer' | 'driver';
  /**
   * The fare the customer already agreed to. Passed in so the panel can show
   * what the total BECOMES if they approve — "no surprise supplement" means
   * showing the new number before the decision, not after it.
   */
  basePrice?: number;
}) {
  const { t, lang } = useLanguage();
  const { showToast } = useToast();
  const [supplements, setSupplements] = useState<RequestSupplement[]>([]);
  const [types, setTypes] = useState<ServiceSupplementType[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const supabase = createClient();
    const [{ data: rows }, { data: typeRows }] = await Promise.all([
      supabase.from('request_supplements').select('*').eq('request_id', requestId).order('created_at'),
      supabase.from('service_supplement_types').select('*').eq('active', true).order('key'),
    ]);
    setSupplements(rows ?? []);
    setTypes(typeRows ?? []);
  }, [requestId]);

  useEffect(() => {
    // Fetching the initial rows from the database and then subscribing to
    // changes is exactly what an effect is for; the setState calls inside
    // load() all happen after an await, not synchronously during render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
    const supabase = createClient();
    const channel = supabase
      .channel(`supplements-${requestId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'request_supplements', filter: `request_id=eq.${requestId}` },
        () => load()
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [requestId, load]);

  const label = (key: string) => {
    const type = types.find((x) => x.key === key);
    if (!type) return key;
    return lang === 'fr' ? type.label_fr : type.label_en;
  };

  async function respond(id: string, approve: boolean) {
    setBusyId(id);
    try {
      await respondToSupplement(id, approve);
      await load();
    } catch (e) {
      showToast('⚠️', t(errorMessageKey(e)));
    } finally {
      setBusyId(null);
    }
  }

  async function withdraw(id: string) {
    setBusyId(id);
    try {
      await withdrawSupplement(id);
      await load();
    } catch (e) {
      showToast('⚠️', t(errorMessageKey(e)));
    } finally {
      setBusyId(null);
    }
  }

  const visible = supplements.filter((s) => s.status !== 'cancelled' || role === 'driver');
  if (visible.length === 0) return null;

  // Only money that was actually charged counts towards the running total. An
  // approved supplement that could not be collected is not part of what the
  // customer owes, and showing it as such would be a bill for nothing.
  const chargedSoFar = supplements
    .filter(
      (s) =>
        s.status === 'approved' && (s.payment_state === 'settled' || s.payment_state === 'authorized')
    )
    .reduce((sum, s) => sum + toMoney(s.amount), 0);

  // What the customer is told about their money after they said yes. Phrased
  // as facts about the charge, never as an apology or a promise.
  const paymentStateNote = (state: RequestSupplement['payment_state']) => {
    if (state === 'settled') return lang === 'fr' ? 'Facturé' : 'Charged';
    if (state === 'authorized') return lang === 'fr' ? 'Ajouté à votre autorisation' : 'Added to your authorization';
    if (state === 'requires_action') {
      return lang === 'fr'
        ? 'Votre banque demande une confirmation'
        : 'Your bank is asking you to confirm';
    }
    if (state === 'uncollected' || state === 'failed') {
      return lang === 'fr' ? 'Non facturé' : 'Not charged';
    }
    return lang === 'fr' ? 'En cours' : 'In progress';
  };

  return (
    <div className="border-t border-night-4 pt-4 mt-4">
      <h4 className="font-display font-bold text-sm mb-1">{t('supp_title')}</h4>
      {role === 'customer' ? <p className="text-xs text-muted mb-3">{t('supp_explain')}</p> : null}

      <ul className="flex flex-col gap-2">
        {visible.map((s) => {
          const amount = toMoney(s.amount);
          return (
            <li key={s.id} className="bg-night-3 border border-night-4 rounded-xl p-3.5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-semibold">{label(s.type_key)}</p>
                  {s.note ? <p className="text-xs text-muted mt-0.5 break-words">{s.note}</p> : null}
                </div>
                <span className="font-display font-bold text-orange whitespace-nowrap">
                  ${amount.toFixed(2)}
                </span>
              </div>

              {/* The new total, shown before the answer rather than after. */}
              {s.status === 'proposed' && role === 'customer' && basePrice != null ? (
                <p className="text-xs text-text-2 mt-2">
                  {lang === 'fr' ? 'Nouveau total si vous acceptez' : 'New total if you accept'} :{' '}
                  <strong className="text-text">
                    ${(basePrice + chargedSoFar + amount).toFixed(2)}
                  </strong>
                  <span className="text-muted">
                    {' '}
                    ({lang === 'fr' ? 'actuellement' : 'currently'} $
                    {(basePrice + chargedSoFar).toFixed(2)})
                  </span>
                </p>
              ) : null}

              <div className="mt-2.5 flex items-center gap-2 flex-wrap">
                {s.status === 'proposed' ? (
                  role === 'customer' ? (
                    <>
                      <Button size="md" disabled={busyId === s.id} onClick={() => respond(s.id, true)}>
                        {t('supp_approve')}
                      </Button>
                      <Button
                        size="md"
                        variant="secondary"
                        disabled={busyId === s.id}
                        onClick={() => respond(s.id, false)}
                      >
                        {t('supp_decline')}
                      </Button>
                    </>
                  ) : (
                    <>
                      <span className="text-xs text-yellow">{t('supp_awaiting_client')}</span>
                      <Button
                        size="md"
                        variant="secondary"
                        disabled={busyId === s.id}
                        onClick={() => withdraw(s.id)}
                      >
                        {t('supp_withdraw')}
                      </Button>
                    </>
                  )
                ) : (
                  <span
                    className={`text-xs font-semibold ${
                      s.status === 'approved'
                        ? 'text-green'
                        : s.status === 'declined'
                          ? 'text-red'
                          : 'text-muted'
                    }`}
                  >
                    {s.status === 'approved'
                      ? t('supp_approved_badge')
                      : s.status === 'declined'
                        ? t('supp_declined_badge')
                        : t('supp_cancelled_badge')}
                  </span>
                )}
                {s.status === 'approved' ? (
                  <span
                    className={`text-xs ${
                      s.payment_state === 'settled' || s.payment_state === 'authorized'
                        ? 'text-text-2'
                        : s.payment_state === 'requires_action'
                          ? 'text-yellow'
                          : 'text-muted'
                    }`}
                  >
                    · {paymentStateNote(s.payment_state)}
                  </span>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
