'use client';

import { useState } from 'react';
import { useLanguage } from '@/lib/i18n/LanguageProvider';
import { useToast } from '@/components/ToastProvider';
import { Card, StatCard } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { formatDate } from '@/lib/formatDate';
import { refreshConnectStatus, startConnectOnboarding, type ConnectAvailability } from '@/lib/actions/connect';
import type {
  Company,
  LedgerEntryType,
  ProviderBalances,
  ProviderLedgerEntry,
  ProviderPayout,
} from '@/lib/supabase/types';
import { errorMessageKey } from '@/lib/errors';

const TYPE_LABEL: Record<LedgerEntryType, { fr: string; en: string }> = {
  earning: { fr: 'Course complétée', en: 'Completed job' },
  supplement: { fr: 'Supplément approuvé', en: 'Approved supplement' },
  adjustment: { fr: 'Ajustement', en: 'Adjustment' },
  refund_reversal: { fr: 'Remboursement client', en: 'Customer refund' },
  payout: { fr: 'Versement', en: 'Payout' },
  payout_reversal: { fr: 'Versement annulé', en: 'Payout reversed' },
};

// The company's own money. Owner and admin only — the tab is not rendered for
// a dispatcher, and the RLS policies behind every query say the same thing, so
// hiding it here is a courtesy rather than the protection.
export function BusinessFinance({
  company,
  balances,
  entries,
  payouts,
  connect,
}: {
  company: Company;
  balances: ProviderBalances;
  entries: ProviderLedgerEntry[];
  payouts: ProviderPayout[];
  connect: ConnectAvailability;
}) {
  const { t, lang } = useLanguage();
  const { showToast } = useToast();
  const [busy, setBusy] = useState(false);
  // One snapshot, taken on mount. Reading the clock during render makes the
  // render impure and would let the server and the client disagree about
  // which entries are still held.
  const [now] = useState(() => Date.now());

  const money = (v: number | string) => `$${Number(v).toFixed(2)}`;
  const onboarded = company.connect_status === 'enabled';

  async function beginOnboarding() {
    setBusy(true);
    try {
      const { url } = await startConnectOnboarding(company.id);
      window.location.href = url;
    } catch (e) {
      showToast('⚠️', t(errorMessageKey(e)));
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard
          label={t('fin_pending')}
          value={money(balances.pending)}
          change={lang === 'fr' ? 'paiement non encaissé' : 'payment not captured'}
        />
        <StatCard
          label={t('fin_available')}
          value={money(balances.available)}
          changeTone="up"
          change={lang === 'fr' ? 'prêt à verser' : 'ready to pay out'}
        />
        <StatCard label={t('fin_paid_out')} value={money(balances.paid_total)} />
        <StatCard label={t('fin_lifetime')} value={money(balances.lifetime_earned)} />
      </div>

      {/* ------------------------------------------------------------- Connect */}
      <Card>
        <div className="flex items-start justify-between gap-3 flex-wrap mb-3">
          <div>
            <h3 className="font-display text-base font-bold">{t('fin_payout_account')}</h3>
            <p className="text-xs text-muted mt-1">{t('fin_no_bank_data')}</p>
          </div>
          <Badge tone={onboarded ? 'green' : company.connect_status === 'restricted' ? 'yellow' : 'blue'}>
            {company.connect_status}
          </Badge>
        </div>

        {!connect.available ? (
          <p className="text-sm text-text-2">
            {connect.reason === 'live_mode_refused'
              ? lang === 'fr'
                ? "L'intégration Stripe n'est pas en mode test. L'inscription est refusée tant que ce n'est pas le cas."
                : 'The Stripe integration is not in test mode. Onboarding is refused until it is.'
              : lang === 'fr'
                ? "Stripe n'est pas configuré sur cet environnement."
                : 'Stripe is not configured in this environment.'}
          </p>
        ) : (
          <div className="flex flex-wrap gap-3 items-center">
            <Button disabled={busy} onClick={beginOnboarding}>
              {company.stripe_account_id ? t('fin_continue_stripe') : t('fin_setup_payouts')}
            </Button>
            {company.stripe_account_id ? (
              <Button
                variant="secondary"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await refreshConnectStatus(company.id);
                    showToast('✅', lang === 'fr' ? 'Statut actualisé.' : 'Status refreshed.');
                  } catch (e) {
                    showToast('⚠️', t(errorMessageKey(e)));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {t('fin_refresh_status')}
              </Button>
            ) : null}
            <span className="text-xs text-text-2">
              {company.connect_payouts_enabled ? t('fin_payouts_enabled') : t('fin_payouts_not_enabled')}
            </span>
          </div>
        )}

        {company.connect_requirements_due?.length ? (
          <div className="mt-4 rounded-xl bg-night-3 border border-steel p-3.5">
            <p className="text-xs font-semibold text-text-2 mb-1.5">
              {lang === 'fr' ? 'Stripe attend encore' : 'Stripe is still waiting for'}
            </p>
            <ul className="text-xs text-muted flex flex-col gap-1">
              {company.connect_requirements_due.map((r) => (
                <li key={r}>· {r}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {company.connect_disabled_reason ? (
          <p className="text-xs text-red mt-3">{company.connect_disabled_reason}</p>
        ) : null}
      </Card>

      {/* -------------------------------------------------------------- ledger */}
      <Card>
        <h3 className="font-display text-base font-bold mb-1">{t('fin_ledger')}</h3>
        <p className="text-xs text-muted mb-4">
          {lang === 'fr'
            ? "Chaque ligne est une écriture définitive. Les soldes ci-dessus en sont dérivés — il n'existe aucun solde stocké qui pourrait les contredire."
            : 'Each line is a final entry. The balances above are derived from them — there is no stored balance that could contradict them.'}
        </p>
        {entries.length === 0 ? (
          <p className="text-sm text-muted">{t('fin_no_movements')}</p>
        ) : (
          <div className="flex flex-col gap-2">
            {entries.slice(0, 25).map((e) => {
              const amount = Number(e.amount);
              const held = !e.available_at || new Date(e.available_at).getTime() > now;
              return (
                <div
                  key={e.id}
                  className="flex items-center justify-between gap-3 py-1.5 border-b border-steel/50 last:border-none"
                >
                  <div className="min-w-0">
                    <div className="text-sm">{TYPE_LABEL[e.entry_type][lang]}</div>
                    <div className="text-xs text-muted">
                      {formatDate(e.created_at)}
                      {held ? ` · ${lang === 'fr' ? 'en attente' : 'pending'}` : ''}
                    </div>
                  </div>
                  <div
                    className={`font-display font-bold shrink-0 ${amount < 0 ? 'text-red' : held ? 'text-text-2' : 'text-green'}`}
                  >
                    {amount < 0 ? '−' : ''}${Math.abs(amount).toFixed(2)}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {/* ------------------------------------------------------------- payouts */}
      <Card>
        <h3 className="font-display text-base font-bold mb-4">{t('fin_payouts')}</h3>
        {payouts.length === 0 ? (
          <p className="text-sm text-muted">
            {lang === 'fr'
              ? "Aucun versement. Rien n'est versé automatiquement : un versement est préparé par TowConnect, puis envoyé."
              : 'No payouts. Nothing is paid out automatically — a payout is prepared by TowConnect, then sent.'}
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {payouts.map((p) => (
              <div
                key={p.id}
                className="flex items-center justify-between gap-3 py-1.5 border-b border-steel/50 last:border-none"
              >
                <div>
                  <div className="text-sm font-medium">${Number(p.amount).toFixed(2)}</div>
                  <div className="text-xs text-muted">{formatDate(p.created_at)}</div>
                </div>
                <Badge tone={p.state === 'paid' ? 'green' : p.state === 'reversed' ? 'red' : 'yellow'}>
                  {p.state}
                </Badge>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
