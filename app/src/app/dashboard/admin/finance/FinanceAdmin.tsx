'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useLanguage } from '@/lib/i18n/LanguageProvider';
import { useToast } from '@/components/ToastProvider';
import { Card, StatCard } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Input, Label } from '@/components/ui/Field';
import { formatDateTime } from '@/lib/formatDate';
import { issueRefund, preparePayout, setPayoutState, type AdminFinanceOverview } from '@/lib/actions/finance';
import type { ConnectAvailability } from '@/lib/actions/connect';
import { errorMessageKey } from '@/lib/errors';

// The platform's finance view. Read-mostly on purpose: the only two things it
// can DO are issue a refund and prepare a payout, and both are deliberate,
// audited, admin-only actions rather than side effects of looking at a screen.
export function FinanceAdmin({
  overview,
  connect,
}: {
  overview: AdminFinanceOverview;
  connect: ConnectAvailability;
}) {
  const { t, lang } = useLanguage();
  const { showToast } = useToast();
  const [busy, setBusy] = useState(false);
  const [refundForm, setRefundForm] = useState({ requestId: '', amount: '', reason: '' });
  const [payoutAmounts, setPayoutAmounts] = useState<Record<string, string>>({});

  const money = (n: number) => `$${n.toFixed(2)}`;

  async function run(fn: () => Promise<unknown>, done: string) {
    setBusy(true);
    try {
      await fn();
      showToast('✅', done);
    } catch (e) {
      showToast('⚠️', t(errorMessageKey(e)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8">
      <header className="mb-6 flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="font-display text-2xl font-bold">{lang === 'fr' ? 'Finance' : 'Finance'}</h1>
          <p className="text-sm text-muted mt-1">{t('fin_sandbox')}</p>
        </div>
        <div className="flex items-center gap-2">
          <Badge tone={connect.sandbox ? 'green' : 'red'}>
            {connect.sandbox ? (lang === 'fr' ? 'Stripe test' : 'Stripe test mode') : lang === 'fr' ? 'Non sandbox' : 'Not sandbox'}
          </Badge>
          <Link href="/dashboard/admin" className="text-sm text-orange font-medium">
            {lang === 'fr' ? '← Retour' : '← Back'}
          </Link>
        </div>
      </header>

      {!connect.sandbox ? (
        <Card className="mb-6 border-red">
          <p className="text-sm text-red">
            {lang === 'fr'
              ? "Les clés Stripe configurées ne sont pas des clés de test. Toutes les actions financières de cet écran sont refusées tant que ce n'est pas le cas."
              : 'The configured Stripe keys are not test keys. Every financial action on this screen is refused until they are.'}
          </p>
        </Card>
      ) : null}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        <StatCard label={lang === 'fr' ? 'Encaissé (clients)' : 'Customer total'} value={money(overview.customerTotal)} />
        <StatCard label={lang === 'fr' ? 'Dû aux partenaires' : 'Provider total'} value={money(overview.providerTotal)} />
        <StatCard label={lang === 'fr' ? 'Coût de traitement' : 'Processing cost'} value={money(overview.processingTotal)} />
        <StatCard
          label={lang === 'fr' ? 'Marge TowConnect' : 'TowConnect margin'}
          value={money(overview.marginTotal)}
          changeTone={overview.marginTotal < 0 ? 'down' : 'up'}
          change={`${overview.jobsWithEconomics} ${lang === 'fr' ? 'course(s)' : 'job(s)'}`}
        />
      </div>

      {overview.jobsWithoutEconomics > 0 ? (
        <Card className="mb-6 !bg-night-3">
          <p className="text-xs text-text-2">
            {lang === 'fr'
              ? `${overview.jobsWithoutEconomics} course(s) complétée(s) n'ont aucune économie figée : elles ont été acceptées avant qu'une configuration soit active. Elles sont exclues des totaux ci-dessus plutôt que comptées comme des zéros.`
              : `${overview.jobsWithoutEconomics} completed job(s) have no frozen economics — they were accepted before any configuration was active. They are excluded from the totals above rather than counted as zeros.`}
          </p>
        </Card>
      ) : null}

      {/* ----------------------------------------------------------- companies */}
      <Card className="mb-6">
        <h2 className="font-display text-base font-bold mb-1">
          {lang === 'fr' ? 'Soldes partenaires' : 'Provider balances'}
        </h2>
        <p className="text-xs text-muted mb-4">
          {lang === 'fr'
            ? "Chaque solde est dérivé du grand livre. Préparer un versement n'envoie aucun argent : c'est une écriture, en attente."
            : 'Every balance is derived from the ledger. Preparing a payout sends no money — it records an entry, pending.'}
        </p>
        {overview.companies.length === 0 ? (
          <p className="text-sm text-muted">{lang === 'fr' ? 'Aucune entreprise.' : 'No companies.'}</p>
        ) : (
          <div className="overflow-x-auto -mx-6 px-6">
            <table className="w-full text-sm min-w-[640px]">
              <thead>
                <tr className="text-xs uppercase tracking-wide text-muted text-left">
                  <th className="py-2 pr-3">{lang === 'fr' ? 'Entreprise' : 'Company'}</th>
                  <th className="py-2 pr-3">Connect</th>
                  <th className="py-2 pr-3">{lang === 'fr' ? 'En attente' : 'Pending'}</th>
                  <th className="py-2 pr-3">{lang === 'fr' ? 'Disponible' : 'Available'}</th>
                  <th className="py-2 pr-3">{lang === 'fr' ? 'Versé' : 'Paid'}</th>
                  <th className="py-2">{lang === 'fr' ? 'Versement' : 'Payout'}</th>
                </tr>
              </thead>
              <tbody>
                {overview.companies.map((c) => (
                  <tr key={c.id} className="border-t border-steel/50">
                    <td className="py-2 pr-3 font-medium">{c.name}</td>
                    <td className="py-2 pr-3">
                      <Badge tone={c.payoutsEnabled ? 'green' : 'yellow'} dot={false}>
                        {c.connectStatus}
                      </Badge>
                    </td>
                    <td className="py-2 pr-3 text-text-2">{money(c.pending)}</td>
                    <td className="py-2 pr-3 text-green">{money(c.available)}</td>
                    <td className="py-2 pr-3 text-text-2">{money(c.paidTotal)}</td>
                    <td className="py-2">
                      <div className="flex items-center gap-2">
                        <input
                          className="w-24 px-2 py-1.5 bg-night-3 border border-steel rounded-lg text-sm outline-none focus:border-orange"
                          inputMode="decimal"
                          placeholder="—"
                          value={payoutAmounts[c.id] ?? ''}
                          onChange={(e) => setPayoutAmounts((p) => ({ ...p, [c.id]: e.target.value }))}
                        />
                        <Button
                          className="!px-3 !py-1.5 !text-xs"
                          disabled={busy || c.available <= 0}
                          onClick={() =>
                            run(
                              () => preparePayout(c.id, Number(payoutAmounts[c.id] ?? '0')),
                              lang === 'fr' ? 'Versement préparé.' : 'Payout prepared.'
                            )
                          }
                        >
                          {lang === 'fr' ? 'Préparer' : 'Prepare'}
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* ------------------------------------------------------------- payouts */}
      <Card className="mb-6">
        <h2 className="font-display text-base font-bold mb-4">{t('fin_payouts')}</h2>
        {overview.payouts.length === 0 ? (
          <p className="text-sm text-muted">{lang === 'fr' ? 'Aucun versement.' : 'No payouts.'}</p>
        ) : (
          <div className="flex flex-col gap-2">
            {overview.payouts.map((p) => (
              <div
                key={p.id}
                className="flex items-center justify-between gap-3 py-2 border-b border-steel/50 last:border-none flex-wrap"
              >
                <div>
                  <div className="text-sm font-medium">${Number(p.amount).toFixed(2)}</div>
                  <div className="text-xs text-muted">{formatDateTime(p.created_at)}</div>
                </div>
                <div className="flex items-center gap-2">
                  <Badge tone={p.state === 'paid' ? 'green' : p.state === 'reversed' ? 'red' : 'yellow'}>
                    {p.state}
                  </Badge>
                  {p.state !== 'paid' && p.state !== 'reversed' ? (
                    <>
                      <Button
                        className="!px-3 !py-1.5 !text-xs"
                        variant="green"
                        disabled={busy}
                        onClick={() =>
                          run(
                            () => setPayoutState(p.id, 'paid'),
                            lang === 'fr' ? 'Versement marqué payé.' : 'Payout marked paid.'
                          )
                        }
                      >
                        {lang === 'fr' ? 'Marquer payé' : 'Mark paid'}
                      </Button>
                      <Button
                        className="!px-3 !py-1.5 !text-xs"
                        variant="secondary"
                        disabled={busy}
                        onClick={() =>
                          run(
                            () => setPayoutState(p.id, 'reversed', 'Reversed by an admin'),
                            lang === 'fr' ? 'Versement annulé.' : 'Payout reversed.'
                          )
                        }
                      >
                        {lang === 'fr' ? 'Annuler' : 'Reverse'}
                      </Button>
                    </>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* ------------------------------------------------------------- refunds */}
      <Card>
        <h2 className="font-display text-base font-bold mb-1">{t('fin_refunds')}</h2>
        <p className="text-xs text-muted mb-4">
          {lang === 'fr'
            ? "Un remboursement exige une raison, et la part partenaire correspondante est reprise par une écriture négative — jamais en modifiant l'écriture d'origine."
            : 'A refund requires a reason, and the matching provider share is taken back by a negative entry — never by editing the original one.'}
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
          <div>
            <Label>{lang === 'fr' ? 'ID de la demande' : 'Request ID'}</Label>
            <Input
              value={refundForm.requestId}
              onChange={(e) => setRefundForm((f) => ({ ...f, requestId: e.target.value }))}
              placeholder="uuid"
            />
          </div>
          <div>
            <Label>{lang === 'fr' ? 'Montant ($)' : 'Amount ($)'}</Label>
            <Input
              inputMode="decimal"
              value={refundForm.amount}
              onChange={(e) => setRefundForm((f) => ({ ...f, amount: e.target.value }))}
              placeholder="—"
            />
          </div>
          <div>
            <Label>{t('fin_refund_reason')}</Label>
            <Input
              value={refundForm.reason}
              onChange={(e) => setRefundForm((f) => ({ ...f, reason: e.target.value }))}
            />
          </div>
        </div>
        <Button
          variant="red"
          disabled={busy || !connect.sandbox || !refundForm.requestId || !refundForm.reason.trim()}
          onClick={() =>
            run(
              () =>
                issueRefund({
                  requestId: refundForm.requestId.trim(),
                  amount: Number(refundForm.amount),
                  reason: refundForm.reason,
                }),
              lang === 'fr' ? 'Remboursement émis.' : 'Refund issued.'
            )
          }
        >
          {t('fin_refund_issue')}
        </Button>

        <div className="mt-5 flex flex-col gap-2">
          {overview.refunds.length === 0 ? (
            <p className="text-sm text-muted">{lang === 'fr' ? 'Aucun remboursement.' : 'No refunds.'}</p>
          ) : (
            overview.refunds.map((r) => (
              <div
                key={r.id}
                className="flex items-center justify-between gap-3 py-2 border-b border-steel/50 last:border-none"
              >
                <div className="min-w-0">
                  <div className="text-sm font-medium">${Number(r.amount).toFixed(2)}</div>
                  <div className="text-xs text-muted truncate">{r.reason}</div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Badge tone={r.status === 'succeeded' ? 'green' : r.status === 'failed' ? 'red' : 'yellow'}>
                    {r.status}
                  </Badge>
                  <span className="text-xs text-muted">{formatDateTime(r.created_at)}</span>
                </div>
              </div>
            ))
          )}
          <p className="text-xs text-muted mt-2">
            {lang === 'fr'
              ? `Total remboursé : ${money(overview.refundedTotal)}`
              : `Total refunded: ${money(overview.refundedTotal)}`}
          </p>
        </div>
      </Card>
    </div>
  );
}
