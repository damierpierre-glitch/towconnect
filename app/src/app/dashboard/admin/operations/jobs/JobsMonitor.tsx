'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import { useLanguage } from '@/lib/i18n/LanguageProvider';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { problemLabel } from '@/lib/constants';
import { toMoney } from '@/lib/pricing';
import { OperationsNav, type Capabilities } from '../OperationsNav';
import type { JobRow } from '@/lib/actions/operations';

// The active job list.
//
// ORDERED BY URGENCY, NOT BY DATE
// "Newest first" is the wrong order here. The request that has waited longest
// with nobody assigned is the one that needs somebody, and it is the OLDEST
// row — so unmatched jobs come first, and within each group the longest wait
// is at the top. The server does the ordering (listJobs) so the rule lives in
// one place.

const STATUS_TONE: Record<string, 'green' | 'yellow' | 'red' | 'blue' | 'orange'> = {
  pending: 'orange',
  matched: 'blue',
  en_route: 'blue',
  arrived: 'yellow',
  in_progress: 'yellow',
  completed: 'green',
  cancelled: 'red',
  expired: 'red',
};

function age(seconds: number, lang: string): string {
  if (seconds < 60) return lang === 'fr' ? `${seconds} s` : `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return lang === 'fr' ? `${minutes} min` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.floor(hours / 24)} ${lang === 'fr' ? 'j' : 'd'}`;
}

export function JobsMonitor({ capabilities, jobs }: { capabilities: Capabilities; jobs: JobRow[] }) {
  const { lang } = useLanguage();
  const router = useRouter();
  const params = useSearchParams();
  const [company, setCompany] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const statusFilter = params.get('status');
  const regulatedOnly = params.get('regulated') === '1';

  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(params.toString());
    if (value === null) next.delete(key);
    else next.set(key, value);
    router.push(`/dashboard/admin/operations/jobs?${next.toString()}`);
  };

  const companies = useMemo(
    () => Array.from(new Set(jobs.map((j) => j.companyName).filter((c): c is string => Boolean(c)))).sort(),
    [jobs]
  );
  const problems = useMemo(() => Array.from(new Set(jobs.map((j) => j.problem_type))).sort(), [jobs]);

  const visible = jobs.filter(
    (j) => (!company || j.companyName === company) && (!problem || j.problem_type === problem)
  );

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8">
      <header className="mb-5">
        <h1 className="font-display text-2xl font-bold">
          {lang === 'fr' ? 'Interventions' : 'Active jobs'}
        </h1>
        <p className="text-sm text-muted mt-1">
          {lang === 'fr'
            ? 'Triées par urgence opérationnelle : sans chauffeur d’abord, puis la plus longue attente en tête.'
            : 'Ordered by operational urgency: unassigned first, then longest waiting at the top.'}
        </p>
      </header>

      <OperationsNav capabilities={capabilities} />

      <div className="flex gap-2 flex-wrap mb-4">
        {[
          { key: null, fr: 'Actives', en: 'Active' },
          { key: 'pending', fr: 'En attente', en: 'Pending' },
          { key: 'matched,en_route,arrived,in_progress', fr: 'En cours', en: 'Underway' },
          { key: 'completed', fr: 'Terminées', en: 'Completed' },
          { key: 'cancelled,expired', fr: 'Annulées', en: 'Cancelled' },
        ].map((option) => (
          <button
            key={option.key ?? 'all'}
            onClick={() => setParam('status', option.key)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium ${
              (statusFilter ?? null) === option.key
                ? 'bg-orange-dark text-white'
                : 'bg-night-3 text-text-2 border border-steel'
            }`}
          >
            {lang === 'fr' ? option.fr : option.en}
          </button>
        ))}
        <button
          onClick={() => setParam('regulated', regulatedOnly ? null : '1')}
          className={`px-3 py-1.5 rounded-lg text-xs font-medium ${
            regulatedOnly ? 'bg-orange-dark text-white' : 'bg-night-3 text-text-2 border border-steel'
          }`}
        >
          {lang === 'fr' ? 'Zone réglementée' : 'Regulated zone'}
        </button>
        {companies.length > 1 ? (
          <select
            value={company ?? ''}
            onChange={(e) => setCompany(e.target.value || null)}
            className="px-3 py-1.5 rounded-lg text-xs bg-night-3 border border-steel text-text-2"
          >
            <option value="">{lang === 'fr' ? 'Toutes les compagnies' : 'All companies'}</option>
            {companies.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        ) : null}
        {problems.length > 1 ? (
          <select
            value={problem ?? ''}
            onChange={(e) => setProblem(e.target.value || null)}
            className="px-3 py-1.5 rounded-lg text-xs bg-night-3 border border-steel text-text-2"
          >
            <option value="">{lang === 'fr' ? 'Tous les services' : 'All services'}</option>
            {problems.map((p) => (
              <option key={p} value={p}>
                {problemLabel(p, lang)}
              </option>
            ))}
          </select>
        ) : null}
      </div>

      <Card className="!p-0 overflow-hidden">
        {visible.length === 0 ? (
          <p className="text-sm text-muted p-6">
            {lang === 'fr' ? 'Aucune intervention avec ces filtres.' : 'No jobs match these filters.'}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[820px]">
              <thead>
                <tr className="text-xs uppercase tracking-wide text-muted text-left border-b border-steel">
                  <th className="py-3 px-4">{lang === 'fr' ? 'Âge' : 'Age'}</th>
                  <th className="py-3 px-4">{lang === 'fr' ? 'Statut' : 'Status'}</th>
                  <th className="py-3 px-4">{lang === 'fr' ? 'Service' : 'Service'}</th>
                  <th className="py-3 px-4">{lang === 'fr' ? 'Lieu' : 'Location'}</th>
                  <th className="py-3 px-4">{lang === 'fr' ? 'Chauffeur' : 'Driver'}</th>
                  <th className="py-3 px-4">{lang === 'fr' ? 'Compagnie' : 'Company'}</th>
                  <th className="py-3 px-4 text-right">{lang === 'fr' ? 'Prix' : 'Price'}</th>
                  <th className="py-3 px-4" />
                </tr>
              </thead>
              <tbody>
                {visible.map((job) => (
                  <tr key={job.id} className="border-b border-steel/40 last:border-none hover:bg-night-3/50">
                    <td className="py-2.5 px-4 tabular-nums font-medium">
                      {age(job.ageSeconds, lang)}
                    </td>
                    <td className="py-2.5 px-4">
                      <div className="flex items-center gap-1.5">
                        <Badge tone={STATUS_TONE[job.status] ?? 'blue'} dot={false}>
                          {job.status}
                        </Badge>
                        {job.regulated_zone_id ? (
                          <span title={lang === 'fr' ? 'Zone réglementée' : 'Regulated zone'}>⚠️</span>
                        ) : null}
                        {job.hasOpenIncident ? (
                          <span title={lang === 'fr' ? 'Incident ouvert' : 'Open incident'}>🚩</span>
                        ) : null}
                      </div>
                    </td>
                    <td className="py-2.5 px-4">{problemLabel(job.problem_type, lang)}</td>
                    <td className="py-2.5 px-4 max-w-[220px] truncate">{job.location_text}</td>
                    <td className="py-2.5 px-4">{job.driverName ?? '—'}</td>
                    <td className="py-2.5 px-4">{job.companyName ?? '—'}</td>
                    <td className="py-2.5 px-4 text-right tabular-nums">
                      ${toMoney(job.price_estimate).toFixed(2)}
                    </td>
                    <td className="py-2.5 px-4 text-right">
                      <Link
                        href={`/dashboard/admin/operations/jobs/${job.id}`}
                        className="text-xs text-orange font-medium"
                      >
                        {lang === 'fr' ? 'Détail →' : 'Detail →'}
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <p className="text-xs text-muted mt-3">
        {visible.length} {lang === 'fr' ? 'intervention(s)' : 'job(s)'}
      </p>
    </div>
  );
}
