import Link from 'next/link';
import { getDispatchHealth } from '@/lib/actions/operations';
import { requireOpsPage } from '../opsGuard';
import { OperationsNav } from '../OperationsNav';
import { Card } from '@/components/ui/Card';
import { formatDateTime } from '@/lib/formatDate';

// Dispatch health, in the engine's own vocabulary.
//
// Every reason on this page comes from dispatch_candidates() (0026). Nothing
// is re-derived: a second answer to "why did nobody get this job" would drift
// from the first, and the drifting one is what people would act on.
const REASON_LABEL: Record<string, string> = {
  regulated_zone_not_authorized: 'Not authorized in the regulated zone',
  documents_not_in_good_standing: 'Documents not in good standing',
  service_not_compatible: 'Equipment not compatible with the service',
  outside_company_service_area: 'Outside the company service area',
  already_on_a_job: 'Already on a job',
  stale_heartbeat: 'Heartbeat lapsed',
  already_offered_this_request: 'Already offered this request',
};

export default async function DispatchHealthPage() {
  const capabilities = await requireOpsPage(['operations']);
  const health = await getDispatchHealth();

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8">
      <header className="mb-5">
        <h1 className="font-display text-2xl font-bold">Dispatch health</h1>
        <p className="text-sm text-muted mt-1">
          Where matching is failing, and why — read from the same query the engine uses to choose a
          driver.
        </p>
      </header>

      <OperationsNav capabilities={capabilities} />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
        <Card>
          <h2 className="font-display text-base font-bold mb-1">Waiting with no offer ever made</h2>
          <p className="text-xs text-muted mb-4">
            Dispatch ran and produced nobody. These are the requests where a person has to intervene.
          </p>
          {health.pendingWithoutOffer.length === 0 ? (
            <p className="text-sm text-muted">Every waiting request has been offered to somebody.</p>
          ) : (
            <div className="flex flex-col gap-2">
              {health.pendingWithoutOffer.map((r) => (
                <div key={r.id} className="flex items-center justify-between gap-3 py-1.5 border-b border-steel/40 last:border-none">
                  <div className="min-w-0">
                    <div className="text-sm truncate">{r.location_text}</div>
                    <div className="text-xs text-muted">
                      {formatDateTime(r.created_at)}
                      {r.regulatedState && r.regulatedState !== 'not_applicable' ? ` · ${r.regulatedState}` : ''}
                    </div>
                  </div>
                  <Link href={`/dashboard/admin/operations/jobs/${r.id}`} className="text-xs text-orange shrink-0">
                    Explain →
                  </Link>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card>
          <h2 className="font-display text-base font-bold mb-1">Declined more than once</h2>
          <p className="text-xs text-muted mb-4">
            Repeated refusals on the same request. Usually a pricing, distance or equipment signal
            rather than a bug.
          </p>
          {health.repeatedlyDeclined.length === 0 ? (
            <p className="text-sm text-muted">No request was declined more than once in the last 24 hours.</p>
          ) : (
            <div className="flex flex-col gap-2">
              {health.repeatedlyDeclined.map((r) => (
                <div key={r.id} className="flex items-center justify-between gap-3 py-1.5 border-b border-steel/40 last:border-none">
                  <span className="text-sm truncate">{r.location_text}</span>
                  <span className="text-xs text-red shrink-0">{r.declines} declines</span>
                  <Link href={`/dashboard/admin/operations/jobs/${r.id}`} className="text-xs text-orange shrink-0">
                    →
                  </Link>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <h2 className="font-display text-base font-bold mb-1">First failing rule, on what is waiting now</h2>
          <p className="text-xs text-muted mb-4">
            Counted by asking the engine about the ten oldest waiting requests. The rule shown is the
            first one a driver failed, in the order the product actually states them.
          </p>
          {health.exclusionReasons.length === 0 ? (
            <p className="text-sm text-muted">Nothing is waiting, so there is nothing to explain.</p>
          ) : (
            <div className="flex flex-col gap-2">
              {health.exclusionReasons.map((r) => (
                <div key={r.reason} className="flex justify-between gap-3 text-sm">
                  <span className="text-text-2">{REASON_LABEL[r.reason] ?? r.reason}</span>
                  <span className="tabular-nums font-medium">{r.count}</span>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card>
          <h2 className="font-display text-base font-bold mb-1">Offer outcomes, last 24 hours</h2>
          <p className="text-xs text-muted mb-4">
            A timeout means the offer lapsed before the driver answered — the engine then moves to the
            next candidate on its own.
          </p>
          {health.recentOutcomes.length === 0 ? (
            <p className="text-sm text-muted">No offers were made in the last 24 hours.</p>
          ) : (
            <div className="flex flex-col gap-2 mb-4">
              {health.recentOutcomes.map((o) => (
                <div key={o.status} className="flex justify-between gap-3 text-sm">
                  <span className="text-text-2">{o.status}</span>
                  <span className="tabular-nums font-medium">{o.count}</span>
                </div>
              ))}
            </div>
          )}
          <div className="flex justify-between gap-3 text-sm pt-3 border-t border-steel/40">
            <span className="text-text-2">Drivers online but silent</span>
            <span className={`tabular-nums font-medium ${health.staleDrivers > 0 ? 'text-yellow' : ''}`}>
              {health.staleDrivers}
            </span>
          </div>
        </Card>
      </div>
    </div>
  );
}
