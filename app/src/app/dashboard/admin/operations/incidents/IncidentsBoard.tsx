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
import {
  acknowledgeRiskFlag,
  openIncident,
  refreshRiskSignals,
  setIncidentStatus,
} from '@/lib/actions/operations';
import { OperationsNav, type Capabilities } from '../OperationsNav';
import type {
  IncidentSeverity,
  IncidentStatus,
  IncidentType,
  OperationalIncident,
  RiskFlag,
} from '@/lib/supabase/types';
import { errorMessageKey } from '@/lib/errors';

// Incidents and risk signals.
//
// DELIBERATELY NOT AN ITSM
// Four statuses, one severity, one optional assignee. No SLAs, no priorities,
// no escalation chains — none of those have been decided, and a field nobody
// fills in is worse than no field at all.
//
// A RISK FLAG IS NOT A VERDICT
// Nothing here bans anybody, and no signal is a score. Each flag carries the
// numbers it was derived from so the person reading it can disagree with it.

const STATUS_TONE: Record<IncidentStatus, 'red' | 'yellow' | 'green' | 'blue'> = {
  open: 'red',
  investigating: 'yellow',
  resolved: 'green',
  dismissed: 'blue',
};

const SEVERITY_TONE: Record<IncidentSeverity, 'red' | 'orange' | 'yellow' | 'blue'> = {
  critical: 'red',
  high: 'orange',
  medium: 'yellow',
  low: 'blue',
};

const FLAG_LABEL: Record<string, { fr: string; en: string }> = {
  repeated_refunds: { fr: 'Remboursements répétés', en: 'Repeated refunds' },
  repeated_cancellations: { fr: 'Annulations répétées', en: 'Repeated cancellations' },
  repeated_payment_failures: { fr: 'Paiements échoués répétés', en: 'Repeated payment failures' },
  shared_payment_method: { fr: 'Moyen de paiement partagé', en: 'Shared payment method' },
  driver_behaviour_anomaly: { fr: 'Comportement chauffeur anormal', en: 'Driver behaviour anomaly' },
};

export function IncidentsBoard({
  capabilities,
  incidents,
  flags,
}: {
  capabilities: Capabilities;
  incidents: OperationalIncident[];
  flags: RiskFlag[];
}) {
  const { lang, t } = useLanguage();
  const { showToast } = useToast();
  const [busy, setBusy] = useState(false);
  const [statusFilter, setStatusFilter] = useState<IncidentStatus | 'all'>('open');
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({
    type: 'technical_issue' as IncidentType,
    severity: 'medium' as IncidentSeverity,
    title: '',
    description: '',
  });
  const [resolutionFor, setResolutionFor] = useState<string | null>(null);
  const [resolutionNote, setResolutionNote] = useState('');

  const visible =
    statusFilter === 'all'
      ? incidents
      : statusFilter === 'open'
        ? incidents.filter((i) => i.status === 'open' || i.status === 'investigating')
        : incidents.filter((i) => i.status === statusFilter);

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
      <header className="mb-5 flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="font-display text-2xl font-bold">
            {lang === 'fr' ? 'Incidents' : 'Incidents'}
          </h1>
          <p className="text-sm text-muted mt-1">
            {lang === 'fr'
              ? 'Ce qui nécessite une intervention humaine, et ce qui en est advenu.'
              : 'What needed a human, and what came of it.'}
          </p>
        </div>
        {capabilities.operations ? (
          <Button variant="secondary" onClick={() => setCreating((v) => !v)}>
            {creating ? (lang === 'fr' ? 'Annuler' : 'Cancel') : lang === 'fr' ? 'Nouvel incident' : 'New incident'}
          </Button>
        ) : null}
      </header>

      <OperationsNav capabilities={capabilities} />

      {creating && capabilities.operations ? (
        <Card className="mb-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
            <div>
              <Label>{lang === 'fr' ? 'Type' : 'Type'}</Label>
              <Select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as IncidentType })}>
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
                value={form.severity}
                onChange={(e) => setForm({ ...form, severity: e.target.value as IncidentSeverity })}
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
            <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          </div>
          <div className="mb-4">
            <Label>{lang === 'fr' ? 'Description' : 'Description'}</Label>
            <Textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </div>
          <Button
            disabled={busy || !form.title.trim()}
            onClick={() =>
              run(
                () =>
                  openIncident({
                    type: form.type,
                    severity: form.severity,
                    title: form.title,
                    description: form.description || null,
                  }),
                lang === 'fr' ? 'Incident ouvert.' : 'Incident opened.'
              ).then(() => {
                setForm({ ...form, title: '', description: '' });
                setCreating(false);
              })
            }
          >
            {lang === 'fr' ? 'Ouvrir' : 'Open'}
          </Button>
        </Card>
      ) : null}

      <div className="flex gap-2 flex-wrap mb-4">
        {(['open', 'resolved', 'dismissed', 'all'] as const).map((key) => (
          <button
            key={key}
            onClick={() => setStatusFilter(key as IncidentStatus | 'all')}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium ${
              statusFilter === key ? 'bg-orange-dark text-white' : 'bg-night-3 text-text-2 border border-steel'
            }`}
          >
            {key === 'open' ? (lang === 'fr' ? 'Ouverts' : 'Open') : key}
          </button>
        ))}
      </div>

      <Card className="mb-6">
        {visible.length === 0 ? (
          <p className="text-sm text-muted">
            {lang === 'fr' ? 'Aucun incident dans cette vue.' : 'No incidents in this view.'}
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {visible.map((incident) => (
              <div key={incident.id} className="py-2.5 border-b border-steel/40 last:border-none">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge tone={SEVERITY_TONE[incident.severity]} dot={false}>
                        {incident.severity}
                      </Badge>
                      <span className="text-sm font-medium">{incident.title}</span>
                      <Badge tone={STATUS_TONE[incident.status]}>{incident.status}</Badge>
                    </div>
                    <div className="text-xs text-muted mt-1">
                      {incident.type} · {formatDateTime(incident.created_at)}
                      {incident.resolved_at ? ` · ${lang === 'fr' ? 'clos' : 'closed'} ${formatDateTime(incident.resolved_at)}` : ''}
                    </div>
                    {incident.description ? (
                      <p className="text-xs text-text-2 mt-1.5">{incident.description}</p>
                    ) : null}
                    {incident.resolution_note ? (
                      <p className="text-xs text-green mt-1.5">{incident.resolution_note}</p>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {incident.request_id ? (
                      <Link
                        href={`/dashboard/admin/operations/jobs/${incident.request_id}`}
                        className="text-xs text-orange"
                      >
                        {lang === 'fr' ? 'Course →' : 'Job →'}
                      </Link>
                    ) : null}
                    {capabilities.operations && (incident.status === 'open' || incident.status === 'investigating') ? (
                      <>
                        {incident.status === 'open' ? (
                          <Button
                            variant="secondary"
                            className="!px-2.5 !py-1 !text-xs"
                            disabled={busy}
                            onClick={() =>
                              run(
                                () => setIncidentStatus(incident.id, 'investigating'),
                                lang === 'fr' ? 'En investigation.' : 'Investigating.'
                              )
                            }
                          >
                            {lang === 'fr' ? 'Investiguer' : 'Investigate'}
                          </Button>
                        ) : null}
                        <Button
                          variant="green"
                          className="!px-2.5 !py-1 !text-xs"
                          disabled={busy}
                          onClick={() => {
                            setResolutionFor(incident.id);
                            setResolutionNote('');
                          }}
                        >
                          {lang === 'fr' ? 'Résoudre' : 'Resolve'}
                        </Button>
                      </>
                    ) : null}
                  </div>
                </div>

                {resolutionFor === incident.id ? (
                  <div className="mt-3 bg-night-3 border border-steel rounded-xl p-3.5">
                    <Label>{lang === 'fr' ? 'Ce qui a été fait' : 'What was done'}</Label>
                    <Textarea value={resolutionNote} onChange={(e) => setResolutionNote(e.target.value)} />
                    <div className="flex gap-2 mt-3">
                      <Button
                        variant="green"
                        className="!px-3 !py-1.5 !text-xs"
                        disabled={busy || !resolutionNote.trim()}
                        onClick={() =>
                          run(
                            () => setIncidentStatus(incident.id, 'resolved', resolutionNote),
                            lang === 'fr' ? 'Incident résolu.' : 'Incident resolved.'
                          ).then(() => setResolutionFor(null))
                        }
                      >
                        {lang === 'fr' ? 'Résolu' : 'Resolved'}
                      </Button>
                      <Button
                        variant="secondary"
                        className="!px-3 !py-1.5 !text-xs"
                        disabled={busy || !resolutionNote.trim()}
                        onClick={() =>
                          run(
                            () => setIncidentStatus(incident.id, 'dismissed', resolutionNote),
                            lang === 'fr' ? 'Incident écarté.' : 'Incident dismissed.'
                          ).then(() => setResolutionFor(null))
                        }
                      >
                        {lang === 'fr' ? 'Écarter' : 'Dismiss'}
                      </Button>
                      <Button
                        variant="secondary"
                        className="!px-3 !py-1.5 !text-xs"
                        onClick={() => setResolutionFor(null)}
                      >
                        {lang === 'fr' ? 'Annuler' : 'Cancel'}
                      </Button>
                    </div>
                    <p className="text-xs text-muted mt-2">
                      {lang === 'fr'
                        ? 'Le changement de statut est journalisé automatiquement, avec son auteur.'
                        : 'The status change is logged automatically, with who made it.'}
                    </p>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </Card>

      {capabilities.operations ? (
        <Card>
          <div className="flex items-start justify-between gap-3 flex-wrap mb-1">
            <h2 className="font-display text-base font-bold">
              {lang === 'fr' ? 'Signaux de risque' : 'Risk signals'}
            </h2>
            <Button
              variant="secondary"
              className="!px-3 !py-1.5 !text-xs"
              disabled={busy}
              onClick={() =>
                run(refreshRiskSignals, lang === 'fr' ? 'Signaux recalculés.' : 'Signals recomputed.')
              }
            >
              {lang === 'fr' ? 'Recalculer' : 'Recompute'}
            </Button>
          </div>
          <p className="text-xs text-muted mb-4">
            {lang === 'fr'
              ? 'Des observations comptées, pas un score. Rien ici ne bannit personne : chaque signal est une raison de regarder, et il porte les chiffres dont il est tiré.'
              : 'Counted observations, not a score. Nothing here bans anybody: each signal is a reason to look, and it carries the numbers it came from.'}
          </p>
          {flags.length === 0 ? (
            <p className="text-sm text-muted">
              {lang === 'fr' ? 'Aucun signal ouvert.' : 'No open signals.'}
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {flags.map((flag) => (
                <div
                  key={flag.id}
                  className="flex items-center justify-between gap-3 py-2 border-b border-steel/40 last:border-none"
                >
                  <div className="min-w-0">
                    <div className="text-sm font-medium">
                      {FLAG_LABEL[flag.kind]?.[lang === 'fr' ? 'fr' : 'en'] ?? flag.kind}
                    </div>
                    <div className="text-xs text-muted">
                      {JSON.stringify(flag.observation)} · {formatDateTime(flag.created_at)}
                    </div>
                  </div>
                  <Button
                    variant="secondary"
                    className="!px-2.5 !py-1 !text-xs shrink-0"
                    disabled={busy}
                    onClick={() =>
                      run(
                        () => acknowledgeRiskFlag(flag.id),
                        lang === 'fr' ? 'Signal pris en compte.' : 'Signal acknowledged.'
                      )
                    }
                  >
                    {lang === 'fr' ? 'Vu' : 'Acknowledge'}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </Card>
      ) : null}
    </div>
  );
}
