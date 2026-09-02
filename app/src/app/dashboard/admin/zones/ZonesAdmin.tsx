'use client';

import { useState } from 'react';
import { useLanguage } from '@/lib/i18n/LanguageProvider';
import { useToast } from '@/components/ToastProvider';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { formatDate, formatDateTime } from '@/lib/formatDate';
import { ZoneGeometryMap } from '@/components/ZoneGeometryMap';
import {
  linkProviderToCompany,
  markZoneVerified,
  setProviderAuthorizationStatus,
  setZoneActive,
  type ZoneAuditEntry,
  type ZoneWithProviders,
} from '@/lib/actions/zones';
import { errorMessageKey } from '@/lib/errors';

interface CompanyOption {
  id: string;
  name: string;
  display_name: string | null;
}

// The admin view of the regulatory layer. Its job is to make three things
// impossible to miss: what the rule is, where it came from, and when someone
// last checked that it is still true.
export function ZonesAdmin({
  zones,
  audit,
  companies,
}: {
  zones: ZoneWithProviders[];
  audit: ZoneAuditEntry[];
  companies: CompanyOption[];
}) {
  const { t, lang } = useLanguage();
  const { showToast } = useToast();
  const [busy, setBusy] = useState(false);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      showToast('⚠️', t(errorMessageKey(e)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8">
      <header className="mb-6">
        <h1 className="font-display text-2xl font-bold">{t('adm_zones')}</h1>
        <p className="text-sm text-muted mt-1">
          {lang === 'fr'
            ? "Une zone ne peut pas être activée tant qu'elle n'a pas de limite géospatiale vérifiée. Toute modification est journalisée."
            : 'A zone cannot be activated until it has a verified geospatial boundary. Every change is logged.'}
        </p>
      </header>

      <div className="flex flex-col gap-4">
        {zones.map((z) => {
          const activatable = z.geometry_confidence !== 'none';
          return (
            <Card key={z.id}>
              <div className="flex flex-wrap items-start gap-2 mb-3">
                <div className="min-w-0 flex-1">
                  <h2 className="font-display font-bold text-[15px] break-words">{z.official_name}</h2>
                  <p className="text-xs text-muted mt-0.5">
                    {z.province} · {z.jurisdiction}
                  </p>
                </div>
                <Badge tone={z.active ? 'green' : 'yellow'}>
                  {z.active ? t('adm_zone_active') : t('adm_zone_inactive')}
                </Badge>
              </div>

              <dl className="grid sm:grid-cols-2 gap-x-6 gap-y-1.5 text-xs mb-3">
                <div className="flex gap-2">
                  <dt className="text-muted shrink-0">{t('adm_dispatch_mode')} :</dt>
                  <dd className="text-text-2 break-words">{z.dispatch_mode}</dd>
                </div>
                <div className="flex gap-2">
                  <dt className="text-muted shrink-0">Geometry :</dt>
                  <dd className={z.geometry_confidence === 'none' ? 'text-red' : 'text-text-2'}>
                    {z.geometry_confidence}
                  </dd>
                </div>
                <div className="flex gap-2">
                  <dt className="text-muted shrink-0">{t('zone_source_label')} :</dt>
                  <dd className="min-w-0">
                    <a
                      href={z.source_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-orange hover:text-orange-light break-all"
                    >
                      {z.source_title}
                    </a>
                  </dd>
                </div>
                <div className="flex gap-2">
                  <dt className="text-muted shrink-0">{t('zone_verified_label')} :</dt>
                  <dd className="text-text-2">
                    {formatDate(z.last_verified_at)}
                    {' · '}
                    {lang === 'fr' ? 'en vigueur' : 'effective'} {z.effective_from}
                  </dd>
                </div>
              </dl>

              {z.geometry_note ? (
                <p className="text-xs text-text-2 bg-night-3 border border-night-4 rounded-xl p-3 mb-3 leading-relaxed">
                  {z.geometry_note}
                </p>
              ) : null}

              {!activatable ? (
                <p className="text-xs text-yellow mb-3">{t('adm_zone_no_geometry')}</p>
              ) : (
                <div className="mb-4">
                  <ZoneGeometryMap zoneId={z.id} active={z.active} />
                </div>
              )}

              <div className="flex flex-wrap gap-2 mb-4">
                <Button
                  size="md"
                  variant={z.active ? 'secondary' : 'primary'}
                  disabled={busy || (!z.active && !activatable)}
                  onClick={() => run(() => setZoneActive(z.id, !z.active))}
                >
                  {z.active ? t('adm_zone_deactivate') : t('adm_zone_activate')}
                </Button>
                <Button
                  size="md"
                  variant="secondary"
                  disabled={busy}
                  onClick={() => run(() => markZoneVerified(z.id))}
                >
                  {t('adm_zone_mark_verified')}
                </Button>
              </div>

              <h3 className="font-display font-bold text-xs uppercase tracking-wide text-muted mb-2">
                {t('adm_providers')} ({z.providers.length})
              </h3>
              {z.providers.length === 0 ? (
                <p className="text-xs text-muted">{t('adm_no_providers')}</p>
              ) : (
                <ul className="flex flex-col gap-1.5">
                  {z.providers.map((p) => (
                    <li
                      key={p.id}
                      className="bg-night-3 border border-night-4 rounded-xl p-3 flex flex-wrap items-center gap-2"
                    >
                      <span className="text-sm">{p.official_operator_name}</span>
                      <Badge tone={p.authorization_status === 'authorized' ? 'green' : 'yellow'}>
                        {p.authorization_status}
                      </Badge>
                      {p.company_id ? null : (
                        <span className="text-[11px] text-muted">{t('adm_not_onboarded')}</span>
                      )}
                      <div className="ml-auto flex items-center gap-2">
                        <select
                          defaultValue={p.company_id ?? ''}
                          disabled={busy}
                          onChange={(e) =>
                            run(() => linkProviderToCompany(p.id, e.target.value || null))
                          }
                          className="bg-night-2 border border-night-4 rounded-lg px-2.5 py-1.5 text-xs text-text max-w-[180px]"
                        >
                          <option value="">—</option>
                          {companies.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.display_name || c.name}
                            </option>
                          ))}
                        </select>
                        {p.authorization_status === 'authorized' ? (
                          <Button
                            size="md"
                            variant="secondary"
                            disabled={busy}
                            onClick={() => run(() => setProviderAuthorizationStatus(p.id, 'suspended'))}
                          >
                            {lang === 'fr' ? 'Suspendre' : 'Suspend'}
                          </Button>
                        ) : (
                          <Button
                            size="md"
                            variant="secondary"
                            disabled={busy}
                            onClick={() => run(() => setProviderAuthorizationStatus(p.id, 'authorized'))}
                          >
                            {lang === 'fr' ? 'Autoriser' : 'Authorize'}
                          </Button>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          );
        })}
      </div>

      <Card className="mt-6">
        <h2 className="font-display font-bold text-sm mb-1">
          {lang === 'fr' ? "Journal d'audit" : 'Audit trail'}
        </h2>
        <p className="text-xs text-muted mb-3">
          {lang === 'fr'
            ? "Écrit par un trigger. Aucun rôle, administrateur compris, n'a de politique permettant d'en supprimer une ligne."
            : 'Written by a trigger. No role, admin included, has a policy that can delete a line of it.'}
        </p>
        {audit.length === 0 ? (
          <p className="text-xs text-muted">—</p>
        ) : (
          <ul className="flex flex-col gap-1 text-xs font-mono">
            {audit.map((a) => (
              <li key={a.id} className="text-text-2 flex flex-wrap gap-2">
                <span className="text-muted">{formatDateTime(a.created_at)}</span>
                <span className="text-orange">{a.action}</span>
                <span className="break-all">{a.table_name}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
