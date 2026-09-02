'use client';

import { useLanguage } from '@/lib/i18n/LanguageProvider';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { formatDateTime } from '@/lib/formatDate';
import { OperationsNav, type Capabilities } from '../OperationsNav';
import type { FunnelStep, OpsAlert, SystemHealthComponent } from '@/lib/supabase/types';

// Is the platform working, and is anybody being asked to do something?
//
// THREE STATES, AND THE THIRD ONE MATTERS MOST
// A component that could not be read renders as `unknown`, in its own colour,
// with the reason. A health board that shows green because it failed to ask
// the question is worse than no health board: it converts an outage into a
// reassurance.
//
// The funnel sits underneath rather than on its own screen because the two
// questions are asked by the same person on the same morning: is it up, and
// is anybody getting through it.

const COMPONENT_LABEL: Record<string, { fr: string; en: string }> = {
  database: { fr: 'Base de données', en: 'Database' },
  scheduler: { fr: 'Planificateur (pg_cron)', en: 'Scheduler (pg_cron)' },
  stripe_webhook: { fr: 'Webhook Stripe', en: 'Stripe webhook' },
  dispatch: { fr: 'Répartition', en: 'Dispatch' },
  realtime: { fr: 'Temps réel', en: 'Realtime' },
  finance_reconciliation: { fr: 'Réconciliation financière', en: 'Finance reconciliation' },
  admin_access: { fr: 'Accès administrateur', en: 'Administrative access' },
};

const STEP_LABEL: Record<string, { fr: string; en: string }> = {
  landing_viewed: { fr: "Page d'accueil vue", en: 'Landing viewed' },
  auth_completed: { fr: 'Compte connecté', en: 'Signed in' },
  location_obtained: { fr: 'Position obtenue', en: 'Location obtained' },
  vehicle_selected: { fr: 'Véhicule choisi', en: 'Vehicle selected' },
  situation_selected: { fr: 'Situation choisie', en: 'Situation selected' },
  estimate_shown: { fr: 'Estimation affichée', en: 'Estimate shown' },
  checkout_started: { fr: 'Confirmation lancée', en: 'Checkout started' },
  payment_authorized: { fr: 'Paiement autorisé', en: 'Payment authorized' },
  request_created: { fr: 'Demande créée', en: 'Request created' },
  request_matched: { fr: 'Chauffeur assigné', en: 'Driver matched' },
  driver_arrived: { fr: 'Chauffeur arrivé', en: 'Driver arrived' },
  request_completed: { fr: 'Intervention terminée', en: 'Job completed' },
};

function stateTone(state: string): 'green' | 'red' | 'yellow' {
  if (state === 'ok') return 'green';
  if (state === 'attention') return 'red';
  return 'yellow';
}

function severityTone(severity: string): 'red' | 'orange' | 'yellow' {
  if (severity === 'critical') return 'red';
  if (severity === 'high') return 'orange';
  return 'yellow';
}

export function HealthBoard({
  capabilities,
  health,
  healthError,
  alerts,
  funnel,
  periodDays,
}: {
  capabilities: Capabilities;
  health: SystemHealthComponent[];
  healthError: string | null;
  alerts: OpsAlert[];
  funnel: FunnelStep[];
  periodDays: number;
}) {
  const { lang } = useLanguage();
  const fr = lang === 'fr';
  const label = (map: Record<string, { fr: string; en: string }>, key: string) =>
    map[key] ? (fr ? map[key].fr : map[key].en) : key;

  const funnelHasData = funnel.some((f) => f.sessions > 0);

  return (
    <div className="max-w-5xl mx-auto px-5 sm:px-6 py-8">
      <h1 className="font-display text-2xl font-bold mb-1">
        {fr ? 'État de la plateforme' : 'Platform health'}
      </h1>
      <p className="text-sm text-muted mb-5">
        {fr
          ? "Ce qui fonctionne, ce qui demande une action, et ce qui n'a pas pu être mesuré."
          : 'What is working, what needs action, and what could not be measured.'}
      </p>

      <OperationsNav capabilities={capabilities} />

      {/* ------------------------------------------------------------ alerts */}
      <section aria-labelledby="alerts-heading" className="mb-8">
        <h2 id="alerts-heading" className="font-display text-lg font-bold mb-3">
          {fr ? 'Alertes' : 'Alerts'}
        </h2>
        {alerts.length === 0 ? (
          <Card>
            <p className="text-sm text-text-2">
              {fr
                ? 'Aucune alerte. Chaque alerte de cette liste exige une action — une liste vide est le résultat attendu.'
                : 'No alerts. Every alert in this list demands an action — an empty list is the expected result.'}
            </p>
          </Card>
        ) : (
          <ul className="flex flex-col gap-3">
            {alerts.map((a) => (
              <li key={a.key}>
                <Card>
                  <div className="flex flex-wrap items-center gap-2 mb-1.5">
                    <Badge tone={severityTone(a.severity)}>{a.severity}</Badge>
                    <h3 className="font-semibold text-sm">{a.title}</h3>
                  </div>
                  <p className="text-sm text-text-2 mb-2">{a.detail}</p>
                  <p className="text-xs text-muted">
                    <span className="font-semibold">{fr ? 'À faire : ' : 'To do: '}</span>
                    {a.action}
                  </p>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ------------------------------------------------------ components */}
      <section aria-labelledby="components-heading" className="mb-8">
        <h2 id="components-heading" className="font-display text-lg font-bold mb-3">
          {fr ? 'Composants' : 'Components'}
        </h2>
        {healthError ? (
          <Card>
            <p className="text-sm text-yellow">{healthError}</p>
          </Card>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">
                {fr ? 'État de chaque composant de la plateforme' : 'State of each platform component'}
              </caption>
              <thead>
                <tr className="text-left text-xs text-muted">
                  <th scope="col" className="py-2 pr-3 font-medium">
                    {fr ? 'Composant' : 'Component'}
                  </th>
                  <th scope="col" className="py-2 pr-3 font-medium">
                    {fr ? 'État' : 'State'}
                  </th>
                  <th scope="col" className="py-2 pr-3 font-medium">
                    {fr ? 'Détail' : 'Detail'}
                  </th>
                  <th scope="col" className="py-2 font-medium">
                    {fr ? 'Mesuré' : 'Measured'}
                  </th>
                </tr>
              </thead>
              <tbody>
                {health.map((h) => (
                  <tr key={h.component} className="border-t border-night-4 align-top">
                    <th scope="row" className="py-2.5 pr-3 font-medium text-left">
                      {label(COMPONENT_LABEL, h.component)}
                    </th>
                    <td className="py-2.5 pr-3">
                      <Badge tone={stateTone(h.state)}>
                        {h.state === 'unknown' ? (fr ? 'inconnu' : 'unknown') : h.state}
                      </Badge>
                    </td>
                    <td className="py-2.5 pr-3 text-text-2">{h.detail}</td>
                    <td className="py-2.5 text-muted whitespace-nowrap">
                      {formatDateTime(h.measured_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ------------------------------------------------------------ funnel */}
      <section aria-labelledby="funnel-heading">
        <h2 id="funnel-heading" className="font-display text-lg font-bold mb-1">
          {fr ? 'Entonnoir' : 'Funnel'}
        </h2>
        <p className="text-sm text-muted mb-3">
          {fr
            ? `Les ${periodDays} derniers jours. Une conversion vide signifie que l'étape précédente n'a jamais eu lieu — pas 0 %.`
            : `The last ${periodDays} days. A blank conversion means the previous step never happened — not 0%.`}
        </p>
        {!funnelHasData ? (
          <Card>
            <p className="text-sm text-text-2">
              {fr
                ? "Aucun événement enregistré sur la période. C'est le résultat attendu avant le premier vrai visiteur : rien n'est inventé pour remplir le tableau."
                : 'No events recorded in this period. That is the expected result before the first real visitor: nothing is invented to fill the table.'}
            </p>
          </Card>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">
                {fr ? "Étapes de l'entonnoir d'acquisition" : 'Acquisition funnel steps'}
              </caption>
              <thead>
                <tr className="text-left text-xs text-muted">
                  <th scope="col" className="py-2 pr-3 font-medium">
                    {fr ? 'Étape' : 'Step'}
                  </th>
                  <th scope="col" className="py-2 pr-3 font-medium text-right">
                    {fr ? 'Sessions' : 'Sessions'}
                  </th>
                  <th scope="col" className="py-2 pr-3 font-medium text-right">
                    {fr ? 'Événements' : 'Events'}
                  </th>
                  <th scope="col" className="py-2 font-medium text-right">
                    {fr ? 'Depuis étape précédente' : 'From previous step'}
                  </th>
                </tr>
              </thead>
              <tbody>
                {funnel.map((f) => (
                  <tr key={f.step} className="border-t border-night-4">
                    <th scope="row" className="py-2.5 pr-3 font-medium text-left">
                      {label(STEP_LABEL, f.name)}
                    </th>
                    <td className="py-2.5 pr-3 text-right tabular-nums">{f.sessions}</td>
                    <td className="py-2.5 pr-3 text-right tabular-nums text-muted">{f.events}</td>
                    <td className="py-2.5 text-right tabular-nums">
                      {f.conversion_from_previous == null ? (
                        <span className="text-muted">—</span>
                      ) : (
                        `${Number(f.conversion_from_previous).toFixed(1)} %`
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
