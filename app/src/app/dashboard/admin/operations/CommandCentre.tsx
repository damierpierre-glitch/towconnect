'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useLanguage } from '@/lib/i18n/LanguageProvider';
import { Card, StatCard } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { formatDateTime } from '@/lib/formatDate';
import { OperationsNav, type Capabilities } from './OperationsNav';
import type { AttentionItem, OpsKpis, ReconciliationException } from '@/lib/supabase/types';
import type { OperationsSnapshot } from '@/lib/actions/operations';

// The screen answers one question: what needs me right now?
//
// Everything on it is either a thing to act on or the count of such things.
// There is no "requests all time", no revenue curve, no engagement number —
// an operator on shift cannot do anything with those, and a dashboard that
// mixes them teaches people to stop reading it.

const SEVERITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

const KIND_LABEL: Record<string, { fr: string; en: string }> = {
  request_pending_too_long: { fr: 'Demande sans réponse', en: 'Request unanswered' },
  no_candidate_found: { fr: 'Aucun chauffeur possible', en: 'No driver could be offered' },
  assigned_driver_stale: { fr: 'Chauffeur silencieux', en: 'Assigned driver has gone quiet' },
  regulated_capacity_wait: { fr: 'Attente en zone réglementée', en: 'Regulated zone capacity wait' },
  payment_failed: { fr: 'Paiement échoué', en: 'Payment failed' },
  payment_unresolved: { fr: 'Paiement non résolu', en: 'Payment unresolved' },
  supplement_uncollected: { fr: 'Supplément non encaissé', en: 'Supplement uncollected' },
  refund_unresolved: { fr: 'Remboursement à traiter', en: 'Refund needs attention' },
  payout_awaiting_action: { fr: 'Versement en attente', en: 'Payout awaiting action' },
  connect_payouts_disabled: { fr: 'Versements Stripe bloqués', en: 'Stripe payouts disabled' },
  open_incident: { fr: 'Incident ouvert', en: 'Open incident' },
};

function severityTone(severity: string): 'red' | 'orange' | 'yellow' | 'blue' {
  if (severity === 'critical') return 'red';
  if (severity === 'high') return 'orange';
  if (severity === 'medium') return 'yellow';
  return 'blue';
}

function ago(iso: string | null, lang: string): string {
  if (!iso) return '—';
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return lang === 'fr' ? `${seconds} s` : `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return lang === 'fr' ? `${minutes} min` : `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return lang === 'fr' ? `${hours} h` : `${hours}h`;
  return `${Math.round(hours / 24)} ${lang === 'fr' ? 'j' : 'd'}`;
}

export function CommandCentre({
  capabilities,
  queue,
  snapshot,
  kpis,
  exceptions,
  hasSnapshot,
}: {
  capabilities: Capabilities;
  queue: AttentionItem[];
  snapshot: OperationsSnapshot;
  kpis: OpsKpis | null;
  exceptions: ReconciliationException[];
  hasSnapshot: boolean;
}) {
  const { lang } = useLanguage();
  const [filter, setFilter] = useState<string | null>(null);

  // One clock, taken on mount. Reading Date.now() during render would make the
  // server and the client disagree about how old everything is.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  const sorted = useMemo(
    () =>
      [...queue].sort((a, b) => {
        const bySeverity = (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9);
        if (bySeverity !== 0) return bySeverity;
        return new Date(a.since ?? 0).getTime() - new Date(b.since ?? 0).getTime();
      }),
    [queue]
  );

  const kinds = useMemo(() => Array.from(new Set(queue.map((q) => q.kind))).sort(), [queue]);
  const visible = filter ? sorted.filter((q) => q.kind === filter) : sorted;

  const num = (v: number | string | null) => (v == null ? null : Number(v));
  const pct = (v: number | string | null) => {
    const n = num(v);
    return n == null ? '—' : `${n.toFixed(1)} %`;
  };
  const secs = (v: number | string | null) => {
    const n = num(v);
    if (n == null) return '—';
    return n < 90 ? `${Math.round(n)} s` : `${(n / 60).toFixed(1)} min`;
  };

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8">
      <header className="mb-5">
        <h1 className="font-display text-2xl font-bold">
          {lang === 'fr' ? 'Centre de contrôle' : 'Command centre'}
        </h1>
        <p className="text-sm text-muted mt-1">
          {lang === 'fr'
            ? "Ce qui nécessite une intervention humaine maintenant. Rien d'autre."
            : 'What needs a human right now. Nothing else.'}
        </p>
        {!capabilities.scoped ? (
          <p className="text-xs text-yellow mt-2">
            {lang === 'fr'
              ? "Aucune capacité n'est attribuée à votre compte, il n'a donc aucun accès privilégié. Un super administrateur doit vous en accorder une."
              : 'No capability is assigned to your account, so it holds no privileged access. A super administrator needs to grant you one.'}
          </p>
        ) : null}
      </header>

      <OperationsNav capabilities={capabilities} />

      {hasSnapshot ? (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-3">
            <StatCard label={lang === 'fr' ? 'Interventions actives' : 'Active jobs'} value={String(snapshot.activeRequests)} />
            <StatCard
              label={lang === 'fr' ? 'En attente de matching' : 'Awaiting match'}
              value={String(snapshot.pendingRequests)}
              changeTone={snapshot.pendingRequests > 0 ? 'down' : 'muted'}
            />
            <StatCard label={lang === 'fr' ? 'Offres ouvertes' : 'Open offers'} value={String(snapshot.openOffers)} />
            <StatCard
              label={lang === 'fr' ? 'Chauffeurs en ligne' : 'Drivers online'}
              value={String(snapshot.driversOnline)}
              changeTone="up"
            />
            <StatCard
              label={lang === 'fr' ? 'Chauffeurs silencieux' : 'Drivers stale'}
              value={String(snapshot.driversStale)}
              changeTone={snapshot.driversStale > 0 ? 'down' : 'muted'}
              change={lang === 'fr' ? 'battement > 2 min' : 'heartbeat > 2 min'}
            />
            <StatCard
              label={lang === 'fr' ? 'Courses réglementées' : 'Regulated jobs'}
              value={String(snapshot.regulatedActive)}
            />
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-6">
            <StatCard
              label={lang === 'fr' ? 'Paiements à traiter' : 'Payments to handle'}
              value={String(snapshot.paymentsNeedingAttention)}
              changeTone={snapshot.paymentsNeedingAttention > 0 ? 'down' : 'muted'}
            />
            <StatCard label={lang === 'fr' ? 'Remboursements' : 'Refunds in flight'} value={String(snapshot.refundsInFlight)} />
            <StatCard
              label={lang === 'fr' ? 'Suppléments non encaissés' : 'Uncollected supplements'}
              value={String(snapshot.supplementsUncollected)}
            />
            <StatCard label={lang === 'fr' ? 'Versements en attente' : 'Payouts awaiting'} value={String(snapshot.payoutsAwaiting)} />
            <StatCard
              label={lang === 'fr' ? 'Incidents ouverts' : 'Open incidents'}
              value={String(snapshot.openIncidents)}
              changeTone={snapshot.openIncidents > 0 ? 'down' : 'muted'}
            />
          </div>
        </>
      ) : null}

      {/* ------------------------------------------------- the attention queue */}
      <Card className="mb-6">
        <div className="flex items-start justify-between gap-3 flex-wrap mb-1">
          <h2 className="font-display text-base font-bold">
            {lang === 'fr' ? "File d'attention" : 'Attention queue'}
          </h2>
          <Badge tone={visible.length === 0 ? 'green' : severityTone(visible[0]?.severity ?? 'low')}>
            {visible.length} {lang === 'fr' ? 'élément(s)' : 'item(s)'}
          </Badge>
        </div>
        <p className="text-xs text-muted mb-4">
          {lang === 'fr'
            ? 'Chaque ligne indique d’où vient son seuil. « derived » reprend une règle déjà appliquée par le système ; « engineering » est un défaut d’ingénierie, pas un engagement de service.'
            : 'Every row says where its threshold came from. “derived” mirrors a rule the system already enforces; “engineering” is an engineering default, not a service commitment.'}
        </p>

        {kinds.length > 1 ? (
          <div className="flex gap-1.5 flex-wrap mb-4">
            <button
              onClick={() => setFilter(null)}
              className={`px-2.5 py-1 rounded-lg text-xs font-medium ${
                filter === null ? 'bg-orange-dark text-white' : 'bg-night-3 text-text-2 border border-steel'
              }`}
            >
              {lang === 'fr' ? 'Tout' : 'All'}
            </button>
            {kinds.map((k) => (
              <button
                key={k}
                onClick={() => setFilter(k)}
                className={`px-2.5 py-1 rounded-lg text-xs font-medium ${
                  filter === k ? 'bg-orange-dark text-white' : 'bg-night-3 text-text-2 border border-steel'
                }`}
              >
                {KIND_LABEL[k]?.[lang === 'fr' ? 'fr' : 'en'] ?? k}
              </button>
            ))}
          </div>
        ) : null}

        {visible.length === 0 ? (
          <p className="text-sm text-muted py-2">
            {lang === 'fr'
              ? 'Rien ne demande votre attention. C’est un résultat, pas une page vide.'
              : 'Nothing needs you. That is a result, not an empty page.'}
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {visible.map((item, index) => (
              <div
                key={`${item.kind}-${item.subject_id}-${index}`}
                className="flex items-start justify-between gap-3 py-2.5 border-b border-steel/50 last:border-none flex-wrap"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Badge tone={severityTone(item.severity)} dot={false}>
                      {item.severity}
                    </Badge>
                    <span className="text-sm font-medium">
                      {KIND_LABEL[item.kind]?.[lang === 'fr' ? 'fr' : 'en'] ?? item.title}
                    </span>
                    {item.threshold_origin === 'engineering' ? (
                      <span className="text-[10px] uppercase tracking-wide text-muted border border-steel rounded px-1.5 py-0.5">
                        {lang === 'fr' ? 'seuil ingénierie' : 'engineering threshold'}
                      </span>
                    ) : null}
                  </div>
                  <div className="text-xs text-muted mt-1 truncate">{item.detail ?? '—'}</div>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <span className="text-xs text-text-2 tabular-nums">{ago(item.since, lang)}</span>
                  {item.request_id ? (
                    <Link
                      href={`/dashboard/admin/operations/jobs/${item.request_id}`}
                      className="text-xs text-orange font-medium"
                    >
                      {lang === 'fr' ? 'Ouvrir →' : 'Open →'}
                    </Link>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* ------------------------------------------------------- reconciliation */}
      {capabilities.operations || capabilities.finance ? (
        <Card className="mb-6">
          <div className="flex items-center justify-between gap-3 mb-1 flex-wrap">
            <h2 className="font-display text-base font-bold">
              {lang === 'fr' ? 'Réconciliation financière' : 'Financial reconciliation'}
            </h2>
            <Badge tone={exceptions.length === 0 ? 'green' : 'red'}>
              {exceptions.length === 0
                ? lang === 'fr'
                  ? 'Tout concorde'
                  : 'Everything reconciles'
                : `${exceptions.length} ${lang === 'fr' ? 'exception(s)' : 'exception(s)'}`}
            </Badge>
          </div>
          <p className="text-xs text-muted mb-3">
            {lang === 'fr'
              ? 'Les mêmes invariants que `npm run verify:finance`, lus en direct. Deux réponses à « est-ce que l’argent concorde » finiraient par diverger.'
              : 'The same invariants as `npm run verify:finance`, read live. Two answers to “does the money add up” would eventually disagree.'}
          </p>
          {exceptions.length > 0 ? (
            <div className="flex flex-col gap-1.5">
              {exceptions.slice(0, 12).map((e, i) => (
                <div key={i} className="flex justify-between gap-3 text-xs">
                  <span className="text-red font-medium shrink-0">{e.kind}</span>
                  <span className="text-text-2 truncate">{e.detail}</span>
                  {e.request_id ? (
                    <Link
                      href={`/dashboard/admin/operations/jobs/${e.request_id}`}
                      className="text-orange shrink-0"
                    >
                      →
                    </Link>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
        </Card>
      ) : null}

      {/* ------------------------------------------------------------- the KPIs */}
      {kpis ? (
        <Card>
          <h2 className="font-display text-base font-bold mb-1">
            {lang === 'fr' ? 'Indicateurs — 30 derniers jours' : 'Indicators — last 30 days'}
          </h2>
          <p className="text-xs text-muted mb-4">
            {lang === 'fr'
              ? 'Chaque définition est fixée dans ops_kpis(). Les délais viennent de request_events : ils n’existent que pour les courses dont les changements de statut y ont été enregistrés, et rien n’est reconstitué.'
              : 'Every definition is fixed in ops_kpis(). Timings come from request_events, so they exist only for requests whose status changes were recorded there — nothing is reconstructed.'}
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
            <Metric label={lang === 'fr' ? 'Demandes créées' : 'Requests created'} value={String(kpis.requests_created)} />
            <Metric
              label={lang === 'fr' ? 'Délai médian de matching' : 'Median time to match'}
              value={secs(kpis.median_time_to_match_seconds)}
            />
            <Metric
              label={lang === 'fr' ? "Délai médian jusqu'à l'arrivée" : 'Median time to arrival'}
              value={secs(kpis.median_time_to_arrival_seconds)}
            />
            <Metric label={lang === 'fr' ? 'Taux de matching' : 'Match rate'} value={pct(kpis.match_rate)} />
            <Metric label={lang === 'fr' ? "Taux d'acceptation" : 'Acceptance rate'} value={pct(kpis.acceptance_rate)} />
            <Metric label={lang === 'fr' ? 'Taux de complétion' : 'Completion rate'} value={pct(kpis.completion_rate)} />
            <Metric label={lang === 'fr' ? "Taux d'annulation" : 'Cancellation rate'} value={pct(kpis.cancellation_rate)} />
            <Metric label={lang === 'fr' ? 'Paiements échoués' : 'Failed payment rate'} value={pct(kpis.failed_payment_rate)} />
            <Metric
              label={lang === 'fr' ? 'Courses réglementées' : 'Regulated requests'}
              value={String(kpis.regulated_requests)}
            />
            <Metric
              label={lang === 'fr' ? 'Ayant nécessité un humain' : 'Needed a human'}
              value={String(kpis.requests_needing_human)}
            />
            <Metric label={lang === 'fr' ? 'Offres émises' : 'Offers made'} value={String(kpis.offers_made)} />
            <Metric label={lang === 'fr' ? 'Offres acceptées' : 'Offers accepted'} value={String(kpis.offers_accepted)} />
          </div>
          <p className="text-xs text-muted mt-4">
            {lang === 'fr'
              ? 'Un taux affiché « — » signifie que le dénominateur est vide. Ce n’est pas zéro.'
              : 'A rate shown as “—” means the denominator is empty. That is not zero.'}
          </p>
        </Card>
      ) : null}

      <p className="text-xs text-muted mt-6 text-center">
        {lang === 'fr' ? 'Actualisé' : 'As of'} {formatDateTime(new Date().toISOString())}
      </p>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-night-3 border border-steel rounded-xl p-3.5">
      <div className="text-[11px] uppercase tracking-wide text-muted">{label}</div>
      <div className="font-display text-lg font-bold mt-1">{value}</div>
    </div>
  );
}
