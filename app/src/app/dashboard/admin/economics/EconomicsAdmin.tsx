'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useLanguage } from '@/lib/i18n/LanguageProvider';
import { useToast } from '@/components/ToastProvider';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Input, Label, Textarea } from '@/components/ui/Field';
import { formatDateTime } from '@/lib/formatDate';
import {
  SIMULATION_AMOUNTS,
  simulate,
  type EconomicConfig,
  type EconomicWarning,
} from '@/lib/economics';
import {
  activatePricingConfig,
  archivePricingConfig,
  createPricingDraft,
  type AuditEntry,
} from '@/lib/actions/economics';
import type { PricingConfig } from '@/lib/supabase/types';
import { errorMessageKey } from '@/lib/errors';

// The screen where TowConnect's economics are decided.
//
// TWO RULES SHAPE EVERY CHOICE HERE
//  * Nothing is pre-filled. There is no default commission, no suggested rate,
//    no placeholder percentage — a number in a box reads as a recommendation,
//    and nobody has made this decision yet.
//  * The simulator runs on the DRAFT, before it is saved and long before it is
//    activated, so the consequence of a rate is visible while it is still a
//    question. Activating is then its own separate, logged action.

type FormState = {
  label: string;
  commissionPercent: string;
  commissionFixed: string;
  commissionMin: string;
  commissionMax: string;
  providerMinimum: string;
  paymentProcessingPercent: string;
  paymentProcessingFixed: string;
  cancellationFeeCustomer: string;
  cancellationCompensationProvider: string;
  notes: string;
};

const EMPTY_FORM: FormState = {
  label: '',
  commissionPercent: '',
  commissionFixed: '',
  commissionMin: '',
  commissionMax: '',
  providerMinimum: '',
  paymentProcessingPercent: '',
  paymentProcessingFixed: '',
  cancellationFeeCustomer: '',
  cancellationCompensationProvider: '',
  notes: '',
};

// '' means "not set", which is NOT zero. A blank commission floor must stay
// absent, because a zero floor is a decision and a blank one is not.
const num = (v: string): number | null => {
  const trimmed = v.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
};

const WARNING_TEXT: Record<EconomicWarning, { fr: string; en: string }> = {
  margin_negative: {
    fr: 'La marge TowConnect est négative à ce montant.',
    en: 'TowConnect’s margin is negative at this amount.',
  },
  provider_below_minimum_raised_margin_negative: {
    fr: 'Le minimum partenaire rend la marge négative.',
    en: 'The provider minimum makes the margin negative.',
  },
  provider_receives_nothing: {
    fr: 'Le partenaire ne reçoit rien à ce montant.',
    en: 'The provider receives nothing at this amount.',
  },
  commission_exceeds_customer_price: {
    fr: 'La commission dépasse le prix payé par le client.',
    en: 'The commission exceeds the price the customer pays.',
  },
  processing_cost_not_configured: {
    fr: 'Le coût de traitement du paiement n’est pas configuré.',
    en: 'The payment processing cost is not configured.',
  },
  commission_capped: { fr: 'Commission plafonnée.', en: 'Commission capped.' },
  commission_floored: { fr: 'Commission relevée au plancher.', en: 'Commission raised to the floor.' },
  provider_minimum_applied: { fr: 'Minimum partenaire appliqué.', en: 'Provider minimum applied.' },
};

export function EconomicsAdmin({ configs, audit }: { configs: PricingConfig[]; audit: AuditEntry[] }) {
  const { lang, t } = useLanguage();
  const { showToast } = useToast();
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [customAmount, setCustomAmount] = useState('');

  const active = configs.find((c) => c.status === 'active') ?? null;

  const draftConfig: EconomicConfig = useMemo(
    () => ({
      commissionPercent: num(form.commissionPercent),
      commissionFixed: num(form.commissionFixed),
      commissionMin: num(form.commissionMin),
      commissionMax: num(form.commissionMax),
      providerMinimum: num(form.providerMinimum),
      paymentProcessingPercent: num(form.paymentProcessingPercent),
      paymentProcessingFixed: num(form.paymentProcessingFixed),
    }),
    [form]
  );

  const amounts = useMemo(() => {
    const extra = num(customAmount);
    if (extra == null || extra <= 0) return SIMULATION_AMOUNTS;
    return [...SIMULATION_AMOUNTS, extra].sort((a, b) => a - b);
  }, [customAmount]);

  // Pure arithmetic from lib/economics — the same function the server uses to
  // freeze a real job. Running it here means the table cannot drift from what
  // will actually happen.
  const rows = useMemo(() => simulate(draftConfig, amounts), [draftConfig, amounts]);
  const configured = rows.some((r) => r.status === 'computed');

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

  const set = (key: keyof FormState) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  const money = (n: number | null) => (n == null ? '—' : `$${n.toFixed(2)}`);

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8">
      <header className="mb-6">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h1 className="font-display text-2xl font-bold">
              {lang === 'fr' ? 'Économie de la plateforme' : 'Platform economics'}
            </h1>
            <p className="text-sm text-muted mt-1">
              {lang === 'fr'
                ? "Rien n'est pré-rempli ici. Aucun taux de commission n'a été décidé, et un chiffre suggéré se lirait comme une recommandation."
                : 'Nothing is pre-filled here. No commission rate has been decided, and a suggested figure would read as a recommendation.'}
            </p>
          </div>
          <Link href="/dashboard/admin" className="text-sm text-orange font-medium">
            {lang === 'fr' ? '← Retour' : '← Back'}
          </Link>
        </div>
      </header>

      {/* ---------------------------------------------- active configuration */}
      <Card className="mb-6">
        <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
          <h2 className="font-display text-base font-bold">
            {lang === 'fr' ? 'Configuration active' : 'Active configuration'}
          </h2>
          {active ? (
            <Badge tone="green">
              v{active.version} · {active.label}
            </Badge>
          ) : (
            <Badge tone="yellow">{lang === 'fr' ? 'Aucune' : 'None'}</Badge>
          )}
        </div>
        {active ? (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
            <Readout
              label={lang === 'fr' ? 'Commission' : 'Commission'}
              value={
                active.commission_percent != null ? `${Number(active.commission_percent).toFixed(2)} %` : '—'
              }
            />
            <Readout
              label={lang === 'fr' ? 'Commission fixe' : 'Fixed commission'}
              value={active.commission_fixed != null ? `$${Number(active.commission_fixed).toFixed(2)}` : '—'}
            />
            <Readout
              label={lang === 'fr' ? 'Minimum partenaire' : 'Provider minimum'}
              value={active.provider_minimum != null ? `$${Number(active.provider_minimum).toFixed(2)}` : '—'}
            />
            <Readout
              label={lang === 'fr' ? 'Activée le' : 'Activated'}
              value={formatDateTime(active.activated_at)}
            />
          </div>
        ) : (
          <p className="text-sm text-text-2">
            {lang === 'fr'
              ? "Aucune configuration n'est active. Les courses acceptées maintenant ne figent aucune rémunération partenaire, et les écrans affichent « non configuré » plutôt qu'un zéro."
              : 'No configuration is active. Jobs accepted right now freeze no provider compensation, and the screens show “not configured” rather than a zero.'}
          </p>
        )}
      </Card>

      {/* ------------------------------------------------------- the simulator */}
      <Card className="mb-6">
        <h2 className="font-display text-base font-bold mb-1">
          {lang === 'fr' ? 'Simulateur' : 'Simulator'}
        </h2>
        <p className="text-xs text-muted mb-4">
          {lang === 'fr'
            ? "Modifiez les valeurs ci-dessous : le tableau se recalcule immédiatement, avant tout enregistrement. C'est la même arithmétique que celle qui figera une vraie course."
            : 'Change the values below and the table recomputes immediately, before anything is saved. It is the same arithmetic that will freeze a real job.'}
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-5">
          <div>
            <Label>{lang === 'fr' ? 'Nom de la version' : 'Version label'}</Label>
            <Input value={form.label} onChange={set('label')} placeholder={lang === 'fr' ? 'ex. Lancement' : 'e.g. Launch'} />
          </div>
          <div>
            <Label>{lang === 'fr' ? 'Commission (%)' : 'Commission (%)'}</Label>
            <Input inputMode="decimal" value={form.commissionPercent} onChange={set('commissionPercent')} placeholder="—" />
          </div>
          <div>
            <Label>{lang === 'fr' ? 'Commission fixe ($)' : 'Fixed commission ($)'}</Label>
            <Input inputMode="decimal" value={form.commissionFixed} onChange={set('commissionFixed')} placeholder="—" />
          </div>
          <div>
            <Label>{lang === 'fr' ? 'Plancher commission ($)' : 'Commission floor ($)'}</Label>
            <Input inputMode="decimal" value={form.commissionMin} onChange={set('commissionMin')} placeholder="—" />
          </div>
          <div>
            <Label>{lang === 'fr' ? 'Plafond commission ($)' : 'Commission cap ($)'}</Label>
            <Input inputMode="decimal" value={form.commissionMax} onChange={set('commissionMax')} placeholder="—" />
          </div>
          <div>
            <Label>{lang === 'fr' ? 'Minimum partenaire ($)' : 'Provider minimum ($)'}</Label>
            <Input inputMode="decimal" value={form.providerMinimum} onChange={set('providerMinimum')} placeholder="—" />
          </div>
          <div>
            <Label>{lang === 'fr' ? 'Frais de traitement (%)' : 'Processing fee (%)'}</Label>
            <Input
              inputMode="decimal"
              value={form.paymentProcessingPercent}
              onChange={set('paymentProcessingPercent')}
              placeholder="—"
            />
          </div>
          <div>
            <Label>{lang === 'fr' ? 'Frais de traitement fixe ($)' : 'Fixed processing fee ($)'}</Label>
            <Input
              inputMode="decimal"
              value={form.paymentProcessingFixed}
              onChange={set('paymentProcessingFixed')}
              placeholder="—"
            />
          </div>
          <div>
            <Label>{lang === 'fr' ? 'Montant personnalisé ($)' : 'Custom amount ($)'}</Label>
            <Input inputMode="decimal" value={customAmount} onChange={(e) => setCustomAmount(e.target.value)} placeholder="—" />
          </div>
          <div>
            <Label>{lang === 'fr' ? 'Frais d’annulation client ($)' : 'Customer cancellation fee ($)'}</Label>
            <Input
              inputMode="decimal"
              value={form.cancellationFeeCustomer}
              onChange={set('cancellationFeeCustomer')}
              placeholder="—"
            />
          </div>
          <div>
            <Label>{lang === 'fr' ? 'Compensation annulation partenaire ($)' : 'Provider cancellation compensation ($)'}</Label>
            <Input
              inputMode="decimal"
              value={form.cancellationCompensationProvider}
              onChange={set('cancellationCompensationProvider')}
              placeholder="—"
            />
          </div>
        </div>

        <div className="mb-5">
          <Label>{lang === 'fr' ? 'Notes (pourquoi ces chiffres)' : 'Notes (why these numbers)'}</Label>
          <Textarea value={form.notes} onChange={set('notes')} />
        </div>

        <div className="overflow-x-auto -mx-6 px-6">
          <table className="w-full text-sm min-w-[560px]">
            <thead>
              <tr className="text-xs uppercase tracking-wide text-muted text-left">
                <th className="py-2 pr-3">{lang === 'fr' ? 'Prix client' : 'Customer price'}</th>
                <th className="py-2 pr-3">{lang === 'fr' ? 'Partenaire' : 'Provider'}</th>
                <th className="py-2 pr-3">{lang === 'fr' ? 'Traitement' : 'Processing'}</th>
                <th className="py-2 pr-3">{lang === 'fr' ? 'Marge TowConnect' : 'TowConnect margin'}</th>
                <th className="py-2">%</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.amount} className="border-t border-steel/50">
                  <td className="py-2 pr-3 font-semibold">${r.amount.toFixed(2)}</td>
                  <td className="py-2 pr-3 text-green">{money(r.providerCompensation)}</td>
                  <td className="py-2 pr-3 text-text-2">{money(r.paymentProcessingCost)}</td>
                  <td className={`py-2 pr-3 ${(r.towconnectMargin ?? 0) < 0 ? 'text-red' : ''}`}>
                    {money(r.towconnectMargin)}
                  </td>
                  <td className="py-2 text-text-2">
                    {r.towconnectMarginPercent == null ? '—' : `${r.towconnectMarginPercent.toFixed(1)} %`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {!configured ? (
          <p className="text-xs text-yellow mt-4">
            {lang === 'fr'
              ? "Aucune commission saisie : le tableau ne peut rien calculer et affiche « — » plutôt qu'un zéro."
              : 'No commission entered: the table can compute nothing and shows “—” rather than a zero.'}
          </p>
        ) : null}

        {(() => {
          const warnings = Array.from(new Set(rows.flatMap((r) => r.warnings)));
          if (!warnings.length) return null;
          return (
            <div className="mt-4 rounded-xl bg-night-3 border border-steel p-4">
              <p className="text-xs font-semibold text-text-2 mb-2">
                {lang === 'fr' ? 'À regarder avant d’activer' : 'Worth looking at before activating'}
              </p>
              <ul className="text-xs text-text-2 flex flex-col gap-1">
                {warnings.map((w) => (
                  <li key={w}>· {WARNING_TEXT[w][lang]}</li>
                ))}
              </ul>
            </div>
          );
        })()}

        <div className="mt-5 flex gap-3 flex-wrap">
          <Button
            disabled={busy || !configured}
            onClick={() =>
              run(
                () =>
                  createPricingDraft({
                    label: form.label,
                    commissionPercent: num(form.commissionPercent),
                    commissionFixed: num(form.commissionFixed),
                    commissionMin: num(form.commissionMin),
                    commissionMax: num(form.commissionMax),
                    providerMinimum: num(form.providerMinimum),
                    paymentProcessingPercent: num(form.paymentProcessingPercent),
                    paymentProcessingFixed: num(form.paymentProcessingFixed),
                    cancellationFeeCustomer: num(form.cancellationFeeCustomer),
                    cancellationCompensationProvider: num(form.cancellationCompensationProvider),
                    notes: form.notes.trim() || null,
                  }),
                lang === 'fr' ? 'Brouillon enregistré.' : 'Draft saved.'
              )
            }
          >
            {lang === 'fr' ? 'Enregistrer comme brouillon' : 'Save as draft'}
          </Button>
          <Button variant="secondary" disabled={busy} onClick={() => setForm(EMPTY_FORM)}>
            {lang === 'fr' ? 'Effacer' : 'Clear'}
          </Button>
        </div>
        <p className="text-xs text-muted mt-3">
          {lang === 'fr'
            ? "Enregistrer n'active rien. L'activation est une action distincte, ci-dessous, et elle est journalisée."
            : 'Saving activates nothing. Activation is a separate action below, and it is logged.'}
        </p>
      </Card>

      {/* ------------------------------------------------------------ versions */}
      <Card className="mb-6">
        <h2 className="font-display text-base font-bold mb-4">
          {lang === 'fr' ? 'Versions' : 'Versions'}
        </h2>
        {configs.length === 0 ? (
          <p className="text-sm text-muted">{lang === 'fr' ? 'Aucune version.' : 'No versions yet.'}</p>
        ) : (
          <div className="flex flex-col gap-2">
            {configs.map((c) => (
              <div
                key={c.id}
                className="flex items-center justify-between gap-3 py-2.5 border-b border-steel/50 last:border-none flex-wrap"
              >
                <div className="min-w-0">
                  <div className="text-sm font-medium">
                    v{c.version} · {c.label}
                  </div>
                  <div className="text-xs text-muted">
                    {c.commission_percent != null ? `${Number(c.commission_percent).toFixed(2)} %` : '—'}
                    {c.commission_fixed != null ? ` + $${Number(c.commission_fixed).toFixed(2)}` : ''} ·{' '}
                    {formatDateTime(c.created_at)}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Badge tone={c.status === 'active' ? 'green' : c.status === 'draft' ? 'yellow' : 'blue'}>
                    {c.status}
                  </Badge>
                  {c.status !== 'active' ? (
                    <Button
                      size="md"
                      className="!px-3 !py-1.5 !text-xs"
                      disabled={busy}
                      onClick={() =>
                        run(
                          () => activatePricingConfig(c.id),
                          lang === 'fr' ? 'Configuration activée.' : 'Configuration activated.'
                        )
                      }
                    >
                      {lang === 'fr' ? 'Activer' : 'Activate'}
                    </Button>
                  ) : null}
                  {c.status === 'draft' ? (
                    <Button
                      variant="secondary"
                      className="!px-3 !py-1.5 !text-xs"
                      disabled={busy}
                      onClick={() =>
                        run(
                          () => archivePricingConfig(c.id),
                          lang === 'fr' ? 'Version archivée.' : 'Version archived.'
                        )
                      }
                    >
                      {lang === 'fr' ? 'Archiver' : 'Archive'}
                    </Button>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* --------------------------------------------------------------- audit */}
      <Card>
        <h2 className="font-display text-base font-bold mb-1">
          {lang === 'fr' ? 'Journal' : 'Audit trail'}
        </h2>
        <p className="text-xs text-muted mb-4">
          {lang === 'fr'
            ? 'Écrit par un déclencheur en base. Personne ne peut y supprimer une ligne.'
            : 'Written by a database trigger. Nobody can delete a line from it.'}
        </p>
        {audit.length === 0 ? (
          <p className="text-sm text-muted">{lang === 'fr' ? 'Rien encore.' : 'Nothing yet.'}</p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {audit.map((a) => (
              <div key={a.id} className="flex justify-between gap-3 text-xs">
                <span className="text-text-2">{a.action}</span>
                <span className="text-muted shrink-0">{formatDateTime(a.created_at)}</span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

function Readout({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-muted">{label}</div>
      <div className="font-display font-bold">{value}</div>
    </div>
  );
}
