'use client';

import { useState, useTransition } from 'react';
import { useLanguage } from '@/lib/i18n/LanguageProvider';
import { useToast } from '@/components/ToastProvider';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Input, Label } from '@/components/ui/Field';
import { errorMessageKey } from '@/lib/errors';
import { setPartnerPilotStatus, updatePilotConfig, updateReadinessItem } from '@/lib/actions/pilot';
import type {
  CoverageReportRow,
  GoNoGoCriterion,
  PartnerLink,
  PartnerPilotStatus,
  PartnerReadiness,
  PilotConfig,
  ReadinessItem,
  ReadinessStatus,
} from '@/lib/supabase/types';
import { OperationsNav, type Capabilities } from '../OperationsNav';

// The pilot, on one screen: the switch, the decision, the checklist, the
// territory and the partners.
//
// WHAT THIS SCREEN REFUSES TO DO
// It does not compute a readiness score of its own. Every state below comes
// from pilot_go_no_go() and launch_readiness_items — so the number an
// operator reads here is the number the database will still give tomorrow,
// and an item cannot be turned green from this page without evidence,
// because the database will not accept it either.

const DOMAIN_LABEL: Record<string, { fr: string; en: string }> = {
  product: { fr: 'Produit', en: 'Product' },
  customer: { fr: 'Client', en: 'Customer' },
  driver: { fr: 'Chauffeur', en: 'Driver' },
  business: { fr: 'Entreprise', en: 'Business' },
  operations: { fr: 'Opérations', en: 'Operations' },
  finance: { fr: 'Finance', en: 'Finance' },
  regulatory: { fr: 'Réglementaire', en: 'Regulatory' },
  security: { fr: 'Sécurité', en: 'Security' },
  privacy: { fr: 'Vie privée', en: 'Privacy' },
  monitoring: { fr: 'Supervision', en: 'Monitoring' },
  support: { fr: 'Support', en: 'Support' },
  data: { fr: 'Données', en: 'Data' },
  legal: { fr: 'Juridique', en: 'Legal' },
  commercial: { fr: 'Commercial', en: 'Commercial' },
};

const STATUS_LABEL: Record<ReadinessStatus, { fr: string; en: string }> = {
  not_started: { fr: 'Pas commencé', en: 'Not started' },
  in_progress: { fr: 'En cours', en: 'In progress' },
  ready: { fr: 'Prêt', en: 'Ready' },
  blocked: { fr: 'Bloqué', en: 'Blocked' },
  not_applicable: { fr: 'Hors périmètre', en: 'Out of scope' },
};

const PILOT_STATUSES: PartnerPilotStatus[] = [
  'none',
  'invited',
  'onboarding',
  'ready',
  'active',
  'paused',
];

function readinessTone(status: ReadinessStatus): 'green' | 'yellow' | 'red' | 'blue' {
  if (status === 'ready') return 'green';
  if (status === 'blocked') return 'red';
  if (status === 'in_progress') return 'yellow';
  if (status === 'not_applicable') return 'blue';
  return 'yellow';
}

function goTone(state: string): 'green' | 'red' | 'yellow' {
  if (state === 'pass') return 'green';
  if (state === 'fail') return 'red';
  return 'yellow';
}

export function PilotConsole({
  capabilities,
  config,
  goNoGo,
  readiness,
  coverage,
  partners,
  links,
}: {
  capabilities: Capabilities;
  config: PilotConfig | null;
  goNoGo: GoNoGoCriterion[];
  readiness: ReadinessItem[];
  coverage: CoverageReportRow[];
  partners: PartnerReadiness[];
  links: PartnerLink[];
}) {
  const { t, lang } = useLanguage();
  const { showToast } = useToast();
  const [pending, startTransition] = useTransition();
  const fr = lang === 'fr';
  const [pauseReason, setPauseReason] = useState('');

  const blockers = readiness.filter((r) => r.blocker && r.status !== 'ready' && r.status !== 'not_applicable');
  const passes = goNoGo.filter((g) => g.state === 'pass').length;

  function run(action: () => Promise<void>, done: string) {
    startTransition(async () => {
      try {
        await action();
        showToast('✅', done);
      } catch (e) {
        showToast('⚠️', t(errorMessageKey(e)));
      }
    });
  }

  function setMode(mode: PilotConfig['mode']) {
    if (mode === 'paused' && !pauseReason.trim()) {
      showToast(
        '✍️',
        fr
          ? 'Écrivez la raison de la pause. Une pause sans raison est une pause que personne ne lève.'
          : 'Write the reason for the pause. A pause with no reason is one nobody lifts.'
      );
      return;
    }
    run(
      () => updatePilotConfig({ mode, pausedReason: mode === 'paused' ? pauseReason : null }),
      fr ? 'Mode du pilote mis à jour.' : 'Pilot mode updated.'
    );
  }

  return (
    <div className="max-w-5xl mx-auto px-5 sm:px-6 py-8">
      <h1 className="font-display text-2xl font-bold mb-1">{fr ? 'Pilote' : 'Pilot'}</h1>
      <p className="text-sm text-muted mb-5">
        {config?.territory_label ?? 'Montréal & Rive-Sud'}
      </p>

      <OperationsNav capabilities={capabilities} />

      {/* ------------------------------------------------------------ switch */}
      <section aria-labelledby="switch-heading" className="mb-8">
        <h2 id="switch-heading" className="font-display text-lg font-bold mb-3">
          {fr ? 'Interrupteur' : 'The switch'}
        </h2>
        <Card>
          {config === null ? (
            <p className="text-sm text-yellow">
              {fr ? 'La configuration du pilote est illisible.' : 'The pilot configuration cannot be read.'}
            </p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2 mb-3">
                <Badge tone={config.mode === 'paused' ? 'red' : config.mode === 'pilot' ? 'orange' : 'green'}>
                  {config.mode}
                </Badge>
                <span className="text-sm text-text-2">
                  {config.mode === 'off'
                    ? fr
                      ? "Aucun filtrage : la plateforme se comporte comme avant le pilote."
                      : 'No gating: the platform behaves as it did before the pilot.'
                    : config.mode === 'pilot'
                      ? fr
                        ? 'Filtrage actif : territoire, heures et liste éventuelle.'
                        : 'Gating live: territory, hours and any allowlist.'
                      : fr
                        ? 'Les nouvelles demandes sont refusées. Les interventions en cours continuent.'
                        : 'New requests are refused. Jobs already running continue.'}
                </span>
              </div>

              <dl className="grid sm:grid-cols-3 gap-3 mb-4 text-sm">
                <div>
                  <dt className="text-xs text-muted">{fr ? 'Heures' : 'Hours'}</dt>
                  <dd>
                    {config.hours_start && config.hours_end
                      ? `${config.hours_start}–${config.hours_end} ${config.timezone}`
                      : fr
                        ? 'Aucune restriction énoncée'
                        : 'No restriction stated'}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted">{fr ? 'Liste blanche' : 'Allowlist'}</dt>
                  <dd>{config.allowlist_enabled ? (fr ? 'Active' : 'On') : fr ? 'Inactive' : 'Off'}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted">
                    {fr ? 'Partenaires prêts requis' : 'Ready partners required'}
                  </dt>
                  {/* null is not zero. Rendering it as 0 would turn "nobody
                      decided" into "the answer is none". */}
                  <dd>
                    {config.min_ready_partners ?? (fr ? 'Non décidé' : 'Not decided')}
                  </dd>
                </div>
              </dl>

              {config.mode === 'paused' && config.paused_reason ? (
                <p className="text-sm text-text-2 mb-4">
                  <span className="text-xs text-muted">{fr ? 'Raison : ' : 'Reason: '}</span>
                  {config.paused_reason}
                </p>
              ) : null}

              <div className="mb-3">
                <Label htmlFor="pause-reason">
                  {fr ? 'Raison de la pause' : 'Reason for pausing'}
                </Label>
                <Input
                  id="pause-reason"
                  value={pauseReason}
                  onChange={(e) => setPauseReason(e.target.value)}
                  placeholder={
                    fr ? 'Ex. : aucun chauffeur disponible ce soir' : 'e.g. no driver available tonight'
                  }
                />
              </div>

              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" disabled={pending} onClick={() => setMode('off')}>
                  {fr ? 'Sans filtrage' : 'No gating'}
                </Button>
                <Button variant="secondary" disabled={pending} onClick={() => setMode('pilot')}>
                  {fr ? 'Pilote' : 'Pilot'}
                </Button>
                <Button disabled={pending} onClick={() => setMode('paused')}>
                  {fr ? 'Mettre en pause' : 'Pause intake'}
                </Button>
              </div>
            </>
          )}
        </Card>
      </section>

      {/* ---------------------------------------------------------- go/no-go */}
      <section aria-labelledby="gonogo-heading" className="mb-8">
        <h2 id="gonogo-heading" className="font-display text-lg font-bold mb-1">
          {fr ? 'Décision go / no-go' : 'Go / no-go'}
        </h2>
        <p className="text-sm text-muted mb-3">
          {fr
            ? `${passes} critère(s) sur ${goNoGo.length} au vert. Un critère que personne n'a tranché s'affiche « à décider », jamais « au vert ».`
            : `${passes} of ${goNoGo.length} criteria pass. A criterion nobody has decided shows as undecided, never as a pass.`}
        </p>
        <ul className="flex flex-col gap-2">
          {goNoGo.map((g) => (
            <li key={g.criterion}>
              <Card>
                <div className="flex flex-wrap items-start gap-2">
                  <Badge tone={goTone(g.state)}>
                    {g.state === 'undecided' ? (fr ? 'à décider' : 'undecided') : g.state}
                  </Badge>
                  <div className="flex-1 min-w-[200px]">
                    <p className="text-sm font-medium">{g.criterion}</p>
                    <p className="text-xs text-muted mt-0.5">{g.detail}</p>
                  </div>
                </div>
              </Card>
            </li>
          ))}
        </ul>
      </section>

      {/* --------------------------------------------------------- territory */}
      <section aria-labelledby="coverage-heading" className="mb-8">
        <h2 id="coverage-heading" className="font-display text-lg font-bold mb-1">
          {fr ? 'Territoire déclaré' : 'Declared territory'}
        </h2>
        <p className="text-sm text-muted mb-3">
          {fr
            ? "Ce que nous disons desservir, à côté de la capacité qui l'atteint réellement. Les deux nombres ont le droit d'être en désaccord."
            : 'What we say we serve, beside the capacity that actually reaches it. The two are allowed to disagree.'}
        </p>
        {coverage.length === 0 ? (
          <Card>
            <p className="text-sm text-yellow">
              {fr ? 'Aucune zone déclarée.' : 'No area declared.'}
            </p>
          </Card>
        ) : (
          <ul className="flex flex-col gap-2">
            {coverage.map((c) => (
              <li key={c.area_name}>
                <Card>
                  <div className="flex flex-wrap items-center gap-2 mb-1">
                    <Badge tone={c.state === 'served' ? 'green' : 'blue'}>{c.state}</Badge>
                    <h3 className="text-sm font-semibold">{c.area_name}</h3>
                  </div>
                  <p className="text-sm text-text-2 mb-2">
                    {c.partners_ready} {fr ? 'partenaire(s) prêt(s)' : 'partner(s) ready'} ·{' '}
                    {c.partners_active} {fr ? 'actif(s)' : 'active'} · {c.drivers_dispatchable}{' '}
                    {fr ? 'chauffeur(s) conforme(s)' : 'compliant driver(s)'}
                  </p>
                  <p className="text-xs text-muted">{c.note}</p>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ---------------------------------------------------------- partners */}
      <section aria-labelledby="partners-heading" className="mb-8">
        <h2 id="partners-heading" className="font-display text-lg font-bold mb-1">
          {fr ? 'Partenaires' : 'Partners'}
        </h2>
        <p className="text-sm text-muted mb-3">
          {fr
            ? "Le statut pilote est commercial. Il n'autorise personne à opérer et ne rend aucun camion disponible."
            : 'Pilot status is commercial. It authorizes nobody to operate and makes no truck available.'}
        </p>
        {partners.length === 0 ? (
          <Card>
            <p className="text-sm text-text-2">
              {fr ? 'Aucune entreprise enregistrée.' : 'No company registered.'}
            </p>
          </Card>
        ) : (
          <ul className="flex flex-col gap-2">
            {partners.map((p) => (
              <li key={p.company_id}>
                <Card>
                  <div className="flex flex-wrap items-center gap-2 mb-2">
                    <h3 className="text-sm font-semibold">{p.company_name}</h3>
                    <Badge tone={p.pilot_status === 'active' ? 'green' : 'blue'}>{p.pilot_status}</Badge>
                    <Badge tone={p.status === 'active' ? 'green' : 'yellow'}>{p.status}</Badge>
                  </div>
                  <p className="text-sm text-text-2 mb-2">
                    {p.drivers_dispatchable}/{p.drivers_total}{' '}
                    {fr ? 'chauffeur(s) conforme(s)' : 'compliant driver(s)'} · {p.fleet_vehicles}{' '}
                    {fr ? 'véhicule(s)' : 'vehicle(s)'} · {p.service_areas}{' '}
                    {fr ? 'zone(s) de service' : 'service area(s)'}
                  </p>
                  {p.blocking_reasons.length > 0 ? (
                    <ul className="text-xs text-yellow mb-2 list-disc pl-4">
                      {p.blocking_reasons.map((r) => (
                        <li key={r}>{r}</li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-xs text-green mb-2">
                      {fr ? 'Rien ne bloque cette entreprise.' : 'Nothing blocks this company.'}
                    </p>
                  )}
                  <div className="flex flex-wrap gap-2 items-end">
                    <div>
                      <Label htmlFor={`pilot-status-${p.company_id}`}>
                        {fr ? 'Statut pilote' : 'Pilot status'}
                      </Label>
                      <select
                        id={`pilot-status-${p.company_id}`}
                        className="bg-night-2 border border-night-4 rounded-lg px-3 py-2 text-sm"
                        defaultValue={p.pilot_status}
                        disabled={pending}
                        onChange={(e) =>
                          run(
                            () =>
                              setPartnerPilotStatus({
                                companyId: p.company_id,
                                status: e.target.value as PartnerPilotStatus,
                              }),
                            fr ? 'Statut pilote mis à jour.' : 'Pilot status updated.'
                          )
                        }
                      >
                        {PILOT_STATUSES.map((s) => (
                          <option key={s} value={s}>
                            {s}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ------------------------------------------------------- attribution */}
      <section aria-labelledby="links-heading" className="mb-8">
        <h2 id="links-heading" className="font-display text-lg font-bold mb-1">
          {fr ? 'Codes partenaires' : 'Partner codes'}
        </h2>
        <p className="text-sm text-muted mb-3">
          {fr
            ? "Un code mesure d'où vient une demande. Il ne change aucun prix et ne verse rien à personne."
            : 'A code measures where a request came from. It changes no price and pays nobody.'}
        </p>
        {links.length === 0 ? (
          <Card>
            <p className="text-sm text-text-2">
              {fr
                ? 'Aucun code. Un code se termine sur une affiche ou un lien : /?p=votre-code'
                : 'No codes yet. A code ends up on a poster or a link: /?p=your-code'}
            </p>
          </Card>
        ) : (
          <ul className="flex flex-col gap-2">
            {links.map((l) => (
              <li key={l.code}>
                <Card>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={l.active ? 'green' : 'blue'}>{l.kind}</Badge>
                    <code className="text-sm">{l.code}</code>
                    <span className="text-sm text-text-2">{l.label}</span>
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* --------------------------------------------------------- checklist */}
      <section aria-labelledby="readiness-heading">
        <h2 id="readiness-heading" className="font-display text-lg font-bold mb-1">
          {fr ? 'Checklist de lancement' : 'Launch readiness'}
        </h2>
        <p className="text-sm text-muted mb-3">
          {fr
            ? `${readiness.filter((r) => r.status === 'ready').length} prêt(s) sur ${readiness.length}. ${blockers.length} bloquant(s) restant(s). Une ligne ne peut pas passer au vert sans preuve — la base de données la refuse.`
            : `${readiness.filter((r) => r.status === 'ready').length} of ${readiness.length} ready. ${blockers.length} blocker(s) outstanding. A line cannot go green without evidence — the database refuses it.`}
        </p>
        <ul className="flex flex-col gap-2">
          {readiness.map((item) => (
            <li key={item.key}>
              <Card>
                <div className="flex flex-wrap items-start gap-2">
                  <Badge tone={readinessTone(item.status)}>
                    {fr ? STATUS_LABEL[item.status].fr : STATUS_LABEL[item.status].en}
                  </Badge>
                  {item.blocker ? (
                    <Badge tone="red" dot={false}>
                      {fr ? 'bloquant' : 'blocker'}
                    </Badge>
                  ) : null}
                  <div className="flex-1 min-w-[220px]">
                    <p className="text-sm font-medium">{item.title}</p>
                    <p className="text-xs text-muted mt-0.5">
                      {fr ? DOMAIN_LABEL[item.domain]?.fr : DOMAIN_LABEL[item.domain]?.en} · {item.owner}
                    </p>
                    {item.evidence ? (
                      <p className="text-xs text-text-2 mt-1.5">
                        <span className="text-muted">{fr ? 'Preuve : ' : 'Evidence: '}</span>
                        {item.evidence}
                      </p>
                    ) : null}
                    {item.note ? <p className="text-xs text-yellow mt-1.5">{item.note}</p> : null}
                  </div>
                  <Button
                    variant="secondary"
                    disabled={pending || item.status === 'in_progress'}
                    onClick={() =>
                      run(
                        () =>
                          updateReadinessItem({
                            key: item.key,
                            status: 'in_progress',
                            evidence: item.evidence,
                            note: item.note,
                          }),
                        fr ? 'Ligne mise à jour.' : 'Item updated.'
                      )
                    }
                  >
                    {fr ? 'Marquer en cours' : 'Mark in progress'}
                  </Button>
                </div>
              </Card>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
