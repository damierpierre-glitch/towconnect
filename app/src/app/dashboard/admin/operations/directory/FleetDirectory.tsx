'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useLanguage } from '@/lib/i18n/LanguageProvider';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { formatDateTime } from '@/lib/formatDate';
import { OperationsNav, type Capabilities } from '../OperationsNav';
import type { CompanyHealthRow, DriverOpsRow } from '@/lib/supabase/types';

// Companies and drivers, as an operator needs them: can they work, and can
// they be paid.
//
// PRESENCE HAS THREE STATES, NOT TWO
// A driver whose app is open but whose heartbeat has lapsed is neither online
// nor offline. Treating them as online is exactly how a job gets dispatched
// nowhere, so "stale" is its own state everywhere it appears.

export function FleetDirectory({
  capabilities,
  companies,
  drivers,
}: {
  capabilities: Capabilities;
  companies: CompanyHealthRow[];
  drivers: DriverOpsRow[];
}) {
  const { lang } = useLanguage();
  const [tab, setTab] = useState<'companies' | 'drivers'>('companies');
  const [companyFilter, setCompanyFilter] = useState<string | null>(null);

  const companyName = new Map(companies.map((c) => [c.id, c.name]));
  const visibleDrivers = companyFilter ? drivers.filter((d) => d.companyId === companyFilter) : drivers;

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8">
      <header className="mb-5">
        <h1 className="font-display text-2xl font-bold">{lang === 'fr' ? 'Flotte' : 'Fleet'}</h1>
        <p className="text-sm text-muted mt-1">
          {lang === 'fr'
            ? 'Compagnies et chauffeurs : capables de travailler, et capables d’être payés.'
            : 'Companies and drivers: able to work, and able to be paid.'}
        </p>
      </header>

      <OperationsNav capabilities={capabilities} />

      <div className="flex gap-2 mb-4">
        {(['companies', 'drivers'] as const).map((key) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`px-3.5 py-1.5 rounded-lg text-xs font-medium ${
              tab === key ? 'bg-orange-dark text-white' : 'bg-night-3 text-text-2 border border-steel'
            }`}
          >
            {key === 'companies'
              ? `${lang === 'fr' ? 'Compagnies' : 'Companies'} (${companies.length})`
              : `${lang === 'fr' ? 'Chauffeurs' : 'Drivers'} (${drivers.length})`}
          </button>
        ))}
      </div>

      {tab === 'companies' ? (
        <Card className="!p-0 overflow-hidden">
          {companies.length === 0 ? (
            <p className="text-sm text-muted p-6">
              {lang === 'fr' ? 'Aucune compagnie enregistrée.' : 'No companies registered.'}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[880px]">
                <thead>
                  <tr className="text-xs uppercase tracking-wide text-muted text-left border-b border-steel">
                    <th className="py-3 px-4">{lang === 'fr' ? 'Compagnie' : 'Company'}</th>
                    <th className="py-3 px-4">{lang === 'fr' ? 'Statut' : 'Status'}</th>
                    <th className="py-3 px-4 text-right">{lang === 'fr' ? 'Chauffeurs' : 'Drivers'}</th>
                    <th className="py-3 px-4 text-right">{lang === 'fr' ? 'En ligne' : 'Online'}</th>
                    <th className="py-3 px-4 text-right">{lang === 'fr' ? 'Véhicules' : 'Vehicles'}</th>
                    <th className="py-3 px-4 text-right">{lang === 'fr' ? 'Zones' : 'Zones'}</th>
                    <th className="py-3 px-4">Connect</th>
                    <th className="py-3 px-4 text-right">{lang === 'fr' ? 'Complétion' : 'Completion'}</th>
                    <th className="py-3 px-4 text-right">{lang === 'fr' ? 'Incidents' : 'Incidents'}</th>
                  </tr>
                </thead>
                <tbody>
                  {companies.map((c) => (
                    <tr key={c.id} className="border-b border-steel/40 last:border-none">
                      <td className="py-2.5 px-4 font-medium">
                        <button
                          onClick={() => {
                            setCompanyFilter(c.id);
                            setTab('drivers');
                          }}
                          className="hover:text-orange text-left"
                        >
                          {c.name}
                        </button>
                        {c.province ? <span className="text-xs text-muted ml-1.5">{c.province}</span> : null}
                      </td>
                      <td className="py-2.5 px-4">
                        <Badge tone={c.status === 'active' ? 'green' : 'yellow'} dot={false}>
                          {c.status}
                        </Badge>
                      </td>
                      <td className="py-2.5 px-4 text-right tabular-nums">
                        {c.driversApproved}/{c.drivers}
                      </td>
                      <td className={`py-2.5 px-4 text-right tabular-nums ${c.driversOnline > 0 ? 'text-green' : ''}`}>
                        {c.driversOnline}
                      </td>
                      <td className="py-2.5 px-4 text-right tabular-nums">{c.vehicles}</td>
                      <td className="py-2.5 px-4 text-right tabular-nums">{c.zoneAuthorizations}</td>
                      <td className="py-2.5 px-4">
                        <Badge tone={c.payoutReady ? 'green' : 'yellow'} dot={false}>
                          {c.connectStatus}
                        </Badge>
                      </td>
                      <td className="py-2.5 px-4 text-right tabular-nums">
                        {/* NULL, not 0 %: "no jobs yet" is not "never completes one". */}
                        {c.completionRate == null ? '—' : `${c.completionRate.toFixed(1)} %`}
                      </td>
                      <td className={`py-2.5 px-4 text-right tabular-nums ${c.openIncidents > 0 ? 'text-red' : ''}`}>
                        {c.openIncidents}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      ) : (
        <>
          {companyFilter ? (
            <div className="mb-3 flex items-center gap-2 text-xs">
              <span className="text-text-2">
                {lang === 'fr' ? 'Filtré sur' : 'Filtered to'} {companyName.get(companyFilter) ?? companyFilter}
              </span>
              <button onClick={() => setCompanyFilter(null)} className="text-orange">
                {lang === 'fr' ? 'tout afficher' : 'show all'}
              </button>
            </div>
          ) : null}
          <Card className="!p-0 overflow-hidden">
            {visibleDrivers.length === 0 ? (
              <p className="text-sm text-muted p-6">
                {lang === 'fr' ? 'Aucun chauffeur.' : 'No drivers.'}
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm min-w-[880px]">
                  <thead>
                    <tr className="text-xs uppercase tracking-wide text-muted text-left border-b border-steel">
                      <th className="py-3 px-4">{lang === 'fr' ? 'Chauffeur' : 'Driver'}</th>
                      <th className="py-3 px-4">{lang === 'fr' ? 'Présence' : 'Presence'}</th>
                      <th className="py-3 px-4">{lang === 'fr' ? 'Battement' : 'Heartbeat'}</th>
                      <th className="py-3 px-4">{lang === 'fr' ? 'Approbation' : 'Approval'}</th>
                      <th className="py-3 px-4">{lang === 'fr' ? 'Compagnie' : 'Company'}</th>
                      <th className="py-3 px-4">{lang === 'fr' ? 'Mission' : 'Active job'}</th>
                      <th className="py-3 px-4">Documents</th>
                      <th className="py-3 px-4 text-right">{lang === 'fr' ? 'Courses' : 'Jobs'}</th>
                      <th className="py-3 px-4 text-right">{lang === 'fr' ? 'Note' : 'Rating'}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleDrivers.map((d) => (
                      <tr key={d.profileId} className="border-b border-steel/40 last:border-none">
                        <td className="py-2.5 px-4 font-medium">
                          {d.name}
                          {d.openIncidents > 0 ? <span className="ml-1.5">🚩</span> : null}
                        </td>
                        <td className="py-2.5 px-4">
                          <Badge
                            tone={d.presence === 'online' ? 'green' : d.presence === 'stale' ? 'yellow' : 'blue'}
                            dot={false}
                          >
                            {d.presence === 'stale'
                              ? lang === 'fr'
                                ? 'silencieux'
                                : 'stale'
                              : d.presence}
                          </Badge>
                        </td>
                        <td className="py-2.5 px-4 text-xs text-muted">{formatDateTime(d.lastHeartbeatAt)}</td>
                        <td className="py-2.5 px-4">
                          <Badge tone={d.approvalStatus === 'approved' ? 'green' : 'yellow'} dot={false}>
                            {d.approvalStatus}
                          </Badge>
                        </td>
                        <td className="py-2.5 px-4">
                          {d.companyId ? companyName.get(d.companyId) ?? '—' : '—'}
                        </td>
                        <td className="py-2.5 px-4">
                          {d.activeRequestId ? (
                            <Link
                              href={`/dashboard/admin/operations/jobs/${d.activeRequestId}`}
                              className="text-orange text-xs"
                            >
                              {d.activeStatus} →
                            </Link>
                          ) : (
                            '—'
                          )}
                        </td>
                        <td className="py-2.5 px-4 text-xs">
                          <span className="text-green">{d.documents.approved}✓</span>{' '}
                          <span className="text-yellow">{d.documents.pending}⧗</span>{' '}
                          <span className="text-red">{d.documents.rejected}✗</span>
                        </td>
                        <td className="py-2.5 px-4 text-right tabular-nums">{d.totalServices}</td>
                        <td className="py-2.5 px-4 text-right tabular-nums">{d.rating.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
