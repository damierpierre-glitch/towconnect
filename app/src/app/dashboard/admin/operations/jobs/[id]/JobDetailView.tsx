'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useLanguage } from '@/lib/i18n/LanguageProvider';
import { useToast } from '@/components/ToastProvider';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Input, Label, Select, Textarea } from '@/components/ui/Field';
import { formatDateTime } from '@/lib/formatDate';
import { problemLabel } from '@/lib/constants';
import { toMoney } from '@/lib/pricing';
import { openIncident } from '@/lib/actions/operations';
import { OperationsNav, type Capabilities } from '../../OperationsNav';
import type { DispatchCandidateRow, IncidentSeverity, IncidentType } from '@/lib/supabase/types';
import type { JobDetail } from '@/lib/actions/operations';
import { errorMessageKey } from '@/lib/errors';

// One job, everything about it — but not all at once.
//
// The first view is the operational summary: who, where, what state, and how
// long. Everything else is behind a tab, because an operator opening this
// screen mid-incident needs the answer in the first two seconds, not a wall.

const EXCLUSION_LABEL: Record<string, { fr: string; en: string }> = {
  regulated_zone_not_authorized: { fr: 'Pas autorisé dans la zone réglementée', en: 'Not authorized in the regulated zone' },
  documents_not_in_good_standing: { fr: 'Documents non conformes', en: 'Documents not in good standing' },
  service_not_compatible: { fr: 'Équipement incompatible', en: 'Equipment not compatible' },
  outside_company_service_area: { fr: 'Hors zone de service', en: 'Outside the company service area' },
  already_on_a_job: { fr: 'Déjà en mission', en: 'Already on a job' },
  stale_heartbeat: { fr: 'Battement expiré', en: 'Stale heartbeat' },
  already_offered_this_request: { fr: 'Déjà sollicité', en: 'Already offered this request' },
};

type Tab = 'summary' | 'dispatch' | 'money' | 'timeline' | 'incidents';

export function JobDetailView({
  capabilities,
  detail,
  candidates,
}: {
  capabilities: Capabilities;
  detail: JobDetail;
  candidates: DispatchCandidateRow[];
}) {
  const { lang, t } = useLanguage();
  const { showToast } = useToast();
  const [tab, setTab] = useState<Tab>('summary');
  const [busy, setBusy] = useState(false);
  const [incidentForm, setIncidentForm] = useState({
    type: 'dispatch_failure' as IncidentType,
    severity: 'medium' as IncidentSeverity,
    title: '',
    description: '',
  });

  const r = detail.request;
  const eligible = candidates.filter((c) => c.eligible);
  const excluded = candidates.filter((c) => !c.eligible);

  const tabs: { key: Tab; fr: string; en: string }[] = [
    { key: 'summary', fr: 'Résumé', en: 'Summary' },
    { key: 'dispatch', fr: 'Répartition', en: 'Dispatch' },
    { key: 'money', fr: 'Argent', en: 'Money' },
    { key: 'timeline', fr: 'Chronologie', en: 'Timeline' },
    { key: 'incidents', fr: 'Incidents', en: 'Incidents' },
  ];

  async function submitIncident() {
    setBusy(true);
    try {
      await openIncident({
        type: incidentForm.type,
        severity: incidentForm.severity,
        title: incidentForm.title,
        description: incidentForm.description || null,
        requestId: r.id,
        driverId: r.driver_id,
      });
      showToast('✅', lang === 'fr' ? 'Incident ouvert.' : 'Incident opened.');
      setIncidentForm({ ...incidentForm, title: '', description: '' });
    } catch (e) {
      showToast('⚠️', t(errorMessageKey(e)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8">
      <header className="mb-5 flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="font-display text-2xl font-bold">
            {problemLabel(r.problem_type, lang)}{' '}
            <span className="text-muted font-mono text-base">#{r.id.slice(0, 8)}</span>
          </h1>
          <p className="text-sm text-muted mt-1">{r.location_text}</p>
        </div>
        <Link href="/dashboard/admin/operations/jobs" className="text-sm text-orange font-medium">
          {lang === 'fr' ? '← Interventions' : '← Jobs'}
        </Link>
      </header>

      <OperationsNav capabilities={capabilities} />

      <div className="flex gap-1.5 overflow-x-auto pb-2 mb-4">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-3.5 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap ${
              tab === t.key ? 'bg-orange-dark text-white' : 'bg-night-3 text-text-2 border border-steel'
            }`}
          >
            {lang === 'fr' ? t.fr : t.en}
          </button>
        ))}
      </div>

      {tab === 'summary' ? (
        <Card>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 text-sm">
            <Field label={lang === 'fr' ? 'Statut' : 'Status'} value={r.status} />
            <Field label={lang === 'fr' ? 'Créée' : 'Created'} value={formatDateTime(r.created_at)} />
            <Field label={lang === 'fr' ? 'Client' : 'Customer'} value={detail.customerName ?? '—'} />
            <Field label="Email" value={detail.customerEmail ?? '—'} />
            <Field label={lang === 'fr' ? 'Chauffeur' : 'Driver'} value={detail.driverName ?? '—'} />
            <Field label={lang === 'fr' ? 'Compagnie' : 'Company'} value={detail.companyName ?? '—'} />
            <Field label={lang === 'fr' ? 'Véhicule' : 'Vehicle'} value={r.vehicle_desc || '—'} />
            <Field label={lang === 'fr' ? 'Destination' : 'Destination'} value={r.destination_address ?? '—'} />
            <Field
              label={lang === 'fr' ? 'Prix client' : 'Customer price'}
              value={`$${toMoney(r.price_estimate).toFixed(2)}`}
            />
            <Field
              label={lang === 'fr' ? 'Zone réglementée' : 'Regulated zone'}
              value={
                detail.zone
                  ? `${detail.zone.zone_code ? `${detail.zone.zone_code} · ` : ''}${detail.zone.official_name}`
                  : lang === 'fr'
                    ? 'Aucune'
                    : 'None'
              }
            />
            <Field
              label={lang === 'fr' ? 'État réglementaire' : 'Regulated state'}
              value={r.regulated_dispatch_state ?? '—'}
            />
            <Field label={lang === 'fr' ? 'Notes' : 'Notes'} value={r.notes || '—'} />
          </div>
        </Card>
      ) : null}

      {tab === 'dispatch' ? (
        <>
          <Card className="mb-4">
            <h3 className="font-display text-base font-bold mb-1">
              {lang === 'fr' ? 'Offres émises' : 'Offers made'}
            </h3>
            <p className="text-xs text-muted mb-4">
              {lang === 'fr'
                ? 'Une offre à la fois, séquentielle. Une offre expirée n’a jamais pu être acceptée.'
                : 'One offer at a time, sequential. An expired offer could never have been accepted.'}
            </p>
            {detail.offers.length === 0 ? (
              <p className="text-sm text-muted">
                {lang === 'fr'
                  ? 'Aucune offre n’a jamais été émise pour cette demande — la répartition n’a trouvé personne.'
                  : 'No offer was ever made for this request — dispatch found nobody.'}
              </p>
            ) : (
              <div className="flex flex-col gap-2">
                {detail.offers.map((o) => (
                  <div key={o.id} className="flex justify-between gap-3 text-sm py-1.5 border-b border-steel/40 last:border-none">
                    <span>{o.driverName ?? o.driver_id.slice(0, 8)}</span>
                    <span className="text-xs text-muted">{formatDateTime(o.offered_at)}</span>
                    <Badge tone={o.status === 'accepted' ? 'green' : o.status === 'declined' ? 'red' : 'yellow'} dot={false}>
                      {o.status}
                    </Badge>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card>
            <h3 className="font-display text-base font-bold mb-1">
              {lang === 'fr' ? 'Pourquoi chaque chauffeur a été retenu ou écarté' : 'Why each driver was kept or excluded'}
            </h3>
            <p className="text-xs text-muted mb-4">
              {lang === 'fr'
                ? 'Produit par explain_dispatch_candidates(), la même requête que le moteur utilise pour choisir. Ce n’est pas une reconstitution.'
                : 'Produced by explain_dispatch_candidates() — the same query the engine uses to choose. This is not a reconstruction.'}
            </p>
            {candidates.length === 0 ? (
              <p className="text-sm text-muted">
                {lang === 'fr'
                  ? 'Aucun candidat évaluable pour cette demande.'
                  : 'No candidate could be evaluated for this request.'}
              </p>
            ) : (
              <div className="overflow-x-auto -mx-6 px-6">
                <table className="w-full text-sm min-w-[640px]">
                  <thead>
                    <tr className="text-xs uppercase tracking-wide text-muted text-left">
                      <th className="py-2 pr-3">{lang === 'fr' ? 'Chauffeur' : 'Driver'}</th>
                      <th className="py-2 pr-3">{lang === 'fr' ? 'Distance' : 'Distance'}</th>
                      <th className="py-2 pr-3">{lang === 'fr' ? 'Éligible' : 'Eligible'}</th>
                      <th className="py-2 pr-3">{lang === 'fr' ? 'Première règle échouée' : 'First failing rule'}</th>
                      <th className="py-2 text-right">Score</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...eligible, ...excluded].map((c) => (
                      <tr key={c.driver_id} className="border-t border-steel/40">
                        <td className="py-2 pr-3">
                          {c.full_name}
                          {c.preferred_partner ? (
                            <span className="ml-1.5 text-[10px] text-orange">
                              {lang === 'fr' ? 'préféré' : 'preferred'}
                            </span>
                          ) : null}
                        </td>
                        <td className="py-2 pr-3 tabular-nums">{c.distance_km?.toFixed(1)} km</td>
                        <td className="py-2 pr-3">
                          <Badge tone={c.eligible ? 'green' : 'red'} dot={false}>
                            {c.eligible ? (lang === 'fr' ? 'oui' : 'yes') : lang === 'fr' ? 'non' : 'no'}
                          </Badge>
                        </td>
                        <td className="py-2 pr-3 text-text-2">
                          {c.exclusion_reason
                            ? EXCLUSION_LABEL[c.exclusion_reason]?.[lang === 'fr' ? 'fr' : 'en'] ?? c.exclusion_reason
                            : '—'}
                        </td>
                        <td className="py-2 text-right tabular-nums">{c.score?.toFixed(3)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      ) : null}

      {tab === 'money' ? (
        <Card>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm mb-5">
            <Field
              label={lang === 'fr' ? 'Prix client' : 'Customer price'}
              value={`$${toMoney(r.price_estimate).toFixed(2)}`}
            />
            <Field
              label={lang === 'fr' ? 'Part partenaire' : 'Provider share'}
              value={r.partner_amount == null ? '—' : `$${toMoney(r.partner_amount).toFixed(2)}`}
            />
            <Field
              label={lang === 'fr' ? 'Marge TowConnect' : 'TowConnect margin'}
              value={r.commission_amount == null ? '—' : `$${toMoney(r.commission_amount).toFixed(2)}`}
            />
            <Field
              label={lang === 'fr' ? 'Coût de traitement' : 'Processing cost'}
              value={
                r.payment_processing_cost == null ? '—' : `$${toMoney(r.payment_processing_cost).toFixed(2)}`
              }
            />
          </div>
          {r.partner_amount == null ? (
            <p className="text-xs text-yellow mb-5">
              {lang === 'fr'
                ? 'Aucun montant figé : aucune configuration économique n’était active à l’acceptation. Ce n’est pas zéro.'
                : 'Nothing frozen: no economic configuration was active at acceptance. That is not zero.'}
            </p>
          ) : null}

          <Section title={lang === 'fr' ? 'Paiement' : 'Payment'}>
            {detail.payment ? (
              <div className="flex justify-between gap-3 text-sm">
                <span>${toMoney(detail.payment.amount).toFixed(2)}</span>
                <Badge tone={detail.payment.status === 'captured' ? 'green' : 'yellow'} dot={false}>
                  {detail.payment.status}
                </Badge>
                <span className="text-xs font-mono text-muted truncate">
                  {detail.payment.stripe_payment_intent_id ?? '—'}
                </span>
              </div>
            ) : (
              <p className="text-sm text-muted">{lang === 'fr' ? 'Aucun paiement.' : 'No payment.'}</p>
            )}
          </Section>

          <Section title={lang === 'fr' ? 'Suppléments' : 'Supplements'}>
            {detail.supplements.length === 0 ? (
              <p className="text-sm text-muted">{lang === 'fr' ? 'Aucun.' : 'None.'}</p>
            ) : (
              detail.supplements.map((s) => (
                <div key={s.id} className="flex justify-between gap-3 text-sm py-1">
                  <span>{s.type_key}</span>
                  <span>${toMoney(s.amount).toFixed(2)}</span>
                  <Badge tone={s.payment_state === 'uncollected' ? 'red' : 'green'} dot={false}>
                    {s.status} · {s.payment_state}
                  </Badge>
                </div>
              ))
            )}
          </Section>

          <Section title={lang === 'fr' ? 'Remboursements' : 'Refunds'}>
            {detail.refunds.length === 0 ? (
              <p className="text-sm text-muted">{lang === 'fr' ? 'Aucun.' : 'None.'}</p>
            ) : (
              detail.refunds.map((rf) => (
                <div key={rf.id} className="flex justify-between gap-3 text-sm py-1">
                  <span>${toMoney(rf.amount).toFixed(2)}</span>
                  <span className="text-xs text-muted truncate">{rf.reason}</span>
                  <Badge tone={rf.status === 'succeeded' ? 'green' : 'yellow'} dot={false}>
                    {rf.status}
                  </Badge>
                </div>
              ))
            )}
          </Section>

          <Section title={lang === 'fr' ? 'Grand livre partenaire' : 'Provider ledger'}>
            {detail.ledger.length === 0 ? (
              <p className="text-sm text-muted">{lang === 'fr' ? 'Aucune écriture.' : 'No entries.'}</p>
            ) : (
              detail.ledger.map((e) => (
                <div key={e.id} className="flex justify-between gap-3 text-sm py-1">
                  <span>{e.entry_type}</span>
                  <span className={Number(e.amount) < 0 ? 'text-red' : 'text-green'}>
                    ${Number(e.amount).toFixed(2)}
                  </span>
                  <span className="text-xs text-muted">
                    {e.available_at
                      ? lang === 'fr'
                        ? 'disponible'
                        : 'available'
                      : lang === 'fr'
                        ? 'en attente'
                        : 'pending'}
                  </span>
                </div>
              ))
            )}
          </Section>
        </Card>
      ) : null}

      {tab === 'timeline' ? (
        <Card>
          <h3 className="font-display text-base font-bold mb-1">
            {lang === 'fr' ? 'Chronologie' : 'Timeline'}
          </h3>
          <p className="text-xs text-muted mb-4">
            {lang === 'fr'
              ? 'Écrite par un déclencheur sur `requests` : elle capture chaque chemin vers un statut, y compris ceux que l’application a oubliés.'
              : 'Written by a trigger on `requests`: it captures every path to a status, including the ones the application forgot.'}
          </p>
          <div className="flex flex-col gap-2">
            {detail.timeline.map((entry, index) => (
              <div key={index} className="flex items-center gap-3 text-sm">
                <span className="w-2 h-2 rounded-full bg-orange shrink-0" />
                <span className="font-medium">{entry.status}</span>
                <span className="text-xs text-muted ml-auto">{formatDateTime(entry.created_at)}</span>
              </div>
            ))}
          </div>
        </Card>
      ) : null}

      {tab === 'incidents' ? (
        <>
          <Card className="mb-4">
            <h3 className="font-display text-base font-bold mb-3">
              {lang === 'fr' ? 'Incidents liés' : 'Linked incidents'}
            </h3>
            {detail.incidents.length === 0 ? (
              <p className="text-sm text-muted">{lang === 'fr' ? 'Aucun incident.' : 'No incidents.'}</p>
            ) : (
              detail.incidents.map((i) => (
                <div key={i.id} className="flex justify-between gap-3 py-2 border-b border-steel/40 last:border-none">
                  <div>
                    <div className="text-sm font-medium">{i.title}</div>
                    <div className="text-xs text-muted">
                      {i.type} · {formatDateTime(i.created_at)}
                    </div>
                  </div>
                  <Badge tone={i.status === 'resolved' ? 'green' : i.status === 'dismissed' ? 'blue' : 'red'}>
                    {i.status}
                  </Badge>
                </div>
              ))
            )}
          </Card>

          {capabilities.operations ? (
            <Card>
              <h3 className="font-display text-base font-bold mb-4">
                {lang === 'fr' ? 'Ouvrir un incident sur cette course' : 'Open an incident on this job'}
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
                <div>
                  <Label>{lang === 'fr' ? 'Type' : 'Type'}</Label>
                  <Select
                    value={incidentForm.type}
                    onChange={(e) => setIncidentForm({ ...incidentForm, type: e.target.value as IncidentType })}
                  >
                    <option value="dispatch_failure">dispatch_failure</option>
                    <option value="payment_issue">payment_issue</option>
                    <option value="customer_safety">customer_safety</option>
                    <option value="driver_issue">driver_issue</option>
                    <option value="regulatory_issue">regulatory_issue</option>
                    <option value="fraud_suspected">fraud_suspected</option>
                    <option value="technical_issue">technical_issue</option>
                  </Select>
                </div>
                <div>
                  <Label>{lang === 'fr' ? 'Gravité' : 'Severity'}</Label>
                  <Select
                    value={incidentForm.severity}
                    onChange={(e) =>
                      setIncidentForm({ ...incidentForm, severity: e.target.value as IncidentSeverity })
                    }
                  >
                    <option value="low">low</option>
                    <option value="medium">medium</option>
                    <option value="high">high</option>
                    <option value="critical">critical</option>
                  </Select>
                </div>
              </div>
              <div className="mb-3">
                <Label>{lang === 'fr' ? 'Titre' : 'Title'}</Label>
                <Input
                  value={incidentForm.title}
                  onChange={(e) => setIncidentForm({ ...incidentForm, title: e.target.value })}
                />
              </div>
              <div className="mb-4">
                <Label>{lang === 'fr' ? 'Description' : 'Description'}</Label>
                <Textarea
                  value={incidentForm.description}
                  onChange={(e) => setIncidentForm({ ...incidentForm, description: e.target.value })}
                />
              </div>
              <Button disabled={busy || !incidentForm.title.trim()} onClick={submitIncident}>
                {lang === 'fr' ? "Ouvrir l'incident" : 'Open incident'}
              </Button>
            </Card>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-muted">{label}</div>
      <div className="mt-0.5 break-words">{value}</div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-5 last:mb-0">
      <h4 className="text-xs uppercase tracking-wide text-muted mb-2">{title}</h4>
      {children}
    </div>
  );
}
