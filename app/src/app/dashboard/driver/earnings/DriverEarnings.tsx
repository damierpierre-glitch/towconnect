'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useLanguage } from '@/lib/i18n/LanguageProvider';
import { problemLabel } from '@/lib/constants';
import { formatDate } from '@/lib/formatDate';
import { Card, StatCard } from '@/components/ui/Card';
import type { LedgerEntryType, ProviderLedgerEntry, TowRequest } from '@/lib/supabase/types';

const DAY_MS = 24 * 60 * 60 * 1000;

// Payouts are a company-level movement and never carry a driver_id, so they
// cannot appear here. Listed explicitly anyway: "everything except payouts"
// would silently start counting whatever type gets added next.
const EARNING_TYPES: LedgerEntryType[] = ['earning', 'supplement', 'adjustment', 'refund_reversal'];

const TYPE_LABEL: Record<LedgerEntryType, { fr: string; en: string }> = {
  earning: { fr: 'Course complétée', en: 'Completed job' },
  supplement: { fr: 'Supplément approuvé', en: 'Approved supplement' },
  adjustment: { fr: 'Ajustement', en: 'Adjustment' },
  refund_reversal: { fr: 'Remboursement client', en: 'Customer refund' },
  payout: { fr: 'Versement', en: 'Payout' },
  payout_reversal: { fr: 'Versement annulé', en: 'Payout reversed' },
};

export function DriverEarnings({
  entries,
  requests,
  completed,
}: {
  entries: ProviderLedgerEntry[];
  requests: TowRequest[];
  completed: TowRequest[];
}) {
  const { t, lang } = useLanguage();

  // Lazy initializer, not a render-time call — a snapshot taken once when this
  // component mounts is all "last 7/30 days" needs.
  const [now] = useState(() => Date.now());

  const requestById = useMemo(() => new Map(requests.map((r) => [r.id, r])), [requests]);

  const earnings = useMemo(
    () => entries.filter((e) => EARNING_TYPES.includes(e.entry_type)),
    [entries]
  );

  const sumSince = (ms: number) =>
    earnings
      .filter((e) => now - new Date(e.created_at).getTime() < ms)
      .reduce((sum, e) => sum + Number(e.amount), 0);
  const countSince = (ms: number) =>
    new Set(
      earnings
        .filter((e) => now - new Date(e.created_at).getTime() < ms && e.request_id)
        .map((e) => e.request_id)
    ).size;

  const todayKey = new Date(now).toISOString().slice(0, 10);
  const today = earnings.filter((e) => e.created_at.slice(0, 10) === todayKey);
  const todaySum = today.reduce((sum, e) => sum + Number(e.amount), 0);

  const pending = earnings
    .filter((e) => !e.available_at || new Date(e.available_at).getTime() > now)
    .reduce((sum, e) => sum + Number(e.amount), 0);
  const available = earnings
    .filter((e) => e.available_at && new Date(e.available_at).getTime() <= now)
    .reduce((sum, e) => sum + Number(e.amount), 0);
  const lifetime = earnings.reduce((sum, e) => sum + Number(e.amount), 0);

  // Completed jobs the ledger says nothing about. Not an error — it is what
  // "accepted before any commission was configured" looks like.
  const creditedRequestIds = new Set(earnings.map((e) => e.request_id));
  const uncredited = completed.filter((r) => !creditedRequestIds.has(r.id));

  const money = (n: number) => `$${n.toFixed(2)}`;

  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
      <div className="flex justify-between items-start mb-6 flex-wrap gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold">{lang === 'fr' ? 'Mes revenus' : 'My earnings'}</h1>
          <p className="text-text-2 text-sm mt-1">
            {lang === 'fr'
              ? 'Ce que vous avez réellement gagné, pas le prix payé par le client.'
              : 'What you actually earned — not the price the customer paid.'}
          </p>
        </div>
        <Link href="/dashboard/driver" className="text-sm text-orange font-medium">
          {lang === 'fr' ? '← Retour' : '← Back'}
        </Link>
      </div>

      {earnings.length === 0 ? (
        <Card className="mb-6 !bg-night-3">
          <p className="text-xs text-text-2">
            {lang === 'fr'
              ? "Aucun montant n'apparaît encore ici. Une rémunération est enregistrée à la complétion d'une course, et seulement si une configuration économique était active au moment où vous l'avez acceptée."
              : 'Nothing appears here yet. Compensation is recorded when a job is completed, and only if an economic configuration was active when you accepted it.'}
          </p>
        </Card>
      ) : null}

      <div className="grid grid-cols-2 gap-3 mb-4">
        <StatCard
          label={lang === 'fr' ? "Aujourd'hui" : 'Today'}
          value={money(todaySum)}
          change={`${today.length} ${lang === 'fr' ? 'mouvement(s)' : 'movement(s)'}`}
        />
        <StatCard
          label={lang === 'fr' ? '7 derniers jours' : 'Last 7 days'}
          value={money(sumSince(7 * DAY_MS))}
          change={`${countSince(7 * DAY_MS)} ${lang === 'fr' ? 'course(s)' : 'job(s)'}`}
        />
        <StatCard
          label={lang === 'fr' ? '30 derniers jours' : 'Last 30 days'}
          value={money(sumSince(30 * DAY_MS))}
          change={`${countSince(30 * DAY_MS)} ${lang === 'fr' ? 'course(s)' : 'job(s)'}`}
        />
        <StatCard
          label={lang === 'fr' ? 'Total (historique)' : 'All-time'}
          value={money(lifetime)}
          change={`${countSince(Number.MAX_SAFE_INTEGER)} ${lang === 'fr' ? 'course(s)' : 'job(s)'}`}
        />
      </div>

      <div className="grid grid-cols-2 gap-3 mb-6">
        <StatCard
          label={t('fin_pending')}
          value={money(pending)}
          change={lang === 'fr' ? 'paiement non encore encaissé' : 'payment not captured yet'}
        />
        <StatCard
          label={t('fin_available')}
          value={money(available)}
          change={lang === 'fr' ? 'prêt à être versé' : 'ready to be paid out'}
          changeTone="up"
        />
      </div>

      <Card className="mb-6">
        <h3 className="font-display text-base font-bold mb-1">
          {lang === 'fr' ? 'Détail des mouvements' : 'Movement detail'}
        </h3>
        <p className="text-xs text-muted mb-4">
          {lang === 'fr'
            ? 'Chaque ligne est une écriture. Une correction est une nouvelle ligne, jamais une modification.'
            : 'Each line is one entry. A correction is a new line, never an edit.'}
        </p>
        {earnings.length === 0 ? (
          <p className="text-sm text-muted text-center py-2">
            {lang === 'fr' ? 'Aucun mouvement.' : 'No movements.'}
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {earnings.slice(0, 20).map((e) => {
              const request = e.request_id ? requestById.get(e.request_id) : undefined;
              const amount = Number(e.amount);
              const held = !e.available_at || new Date(e.available_at).getTime() > now;
              return (
                <div
                  key={e.id}
                  className="flex items-center justify-between gap-3 py-1.5 border-b border-steel/50 last:border-none"
                >
                  <div className="min-w-0">
                    <div className="text-sm font-medium truncate">
                      {request ? problemLabel(request.problem_type, lang) : TYPE_LABEL[e.entry_type][lang]}
                    </div>
                    <div className="text-xs text-muted">
                      {formatDate(e.created_at)} · {TYPE_LABEL[e.entry_type][lang]}
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

      {uncredited.length > 0 ? (
        <Card className="mb-6 !bg-night-3">
          <h3 className="font-display text-sm font-bold mb-1">
            {lang === 'fr' ? 'Courses sans montant enregistré' : 'Jobs with no recorded amount'}
          </h3>
          <p className="text-xs text-text-2 mb-3">
            {lang === 'fr'
              ? "Ces courses ont été acceptées avant qu'une configuration économique soit active. Aucun montant n'a été figé, et TowConnect n'en invente pas rétroactivement."
              : 'These jobs were accepted before an economic configuration was active. No amount was frozen, and TowConnect does not invent one after the fact.'}
          </p>
          <div className="flex flex-col gap-1.5">
            {uncredited.slice(0, 8).map((r) => (
              <div key={r.id} className="flex items-center justify-between gap-3 text-sm">
                <span className="truncate">{problemLabel(r.problem_type, lang)}</span>
                <span className="text-xs text-muted shrink-0">{formatDate(r.created_at)}</span>
              </div>
            ))}
          </div>
        </Card>
      ) : null}

      <div className="text-center">
        <Link href="/dashboard/driver/history" className="text-sm text-orange font-medium">
          {lang === 'fr' ? 'Historique complet →' : 'Full history →'}
        </Link>
      </div>
    </div>
  );
}
