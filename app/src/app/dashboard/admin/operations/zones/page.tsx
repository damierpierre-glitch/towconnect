import Link from 'next/link';
import { listZoneHealth } from '@/lib/actions/operations';
import { requireOpsPage } from '../opsGuard';
import { OperationsNav } from '../OperationsNav';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { formatDate } from '@/lib/formatDate';

// Regulated zone health.
//
// NO FRESHNESS RULE IS INVENTED HERE
// `last_verified_at` is shown as the fact it is. TowConnect has never agreed a
// staleness threshold for a regulatory source, so this page does not colour a
// date red at some made-up age — a number like that gets quoted back as policy
// within a week.
export default async function ZoneHealthPage() {
  const capabilities = await requireOpsPage(['operations']);
  const zones = await listZoneHealth();

  const active = zones.filter((z) => z.active);
  const inactive = zones.filter((z) => !z.active);
  const quebecInactive = inactive.filter((z) => z.province === 'QC');

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8">
      <header className="mb-5">
        <h1 className="font-display text-2xl font-bold">Regulated zone health</h1>
        <p className="text-sm text-muted mt-1">
          Where the law changes what dispatch may do, and how much of it is actually live.
        </p>
      </header>

      <OperationsNav capabilities={capabilities} />

      {quebecInactive.length > 0 ? (
        <Card className="mb-4 !bg-night-3">
          <h2 className="font-display text-sm font-bold mb-1">Known limitation: Québec</h2>
          <p className="text-xs text-text-2">
            {quebecInactive.length} Québec zone{quebecInactive.length === 1 ? '' : 's'} remain inactive
            because no official geospatial boundary was found. They are recorded with their sources so
            the gap is visible rather than forgotten, and dispatch treats the province as unregulated —
            which is the honest position, not an assumption that no rule exists.
          </p>
        </Card>
      ) : null}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
        <Metric label="Zones recorded" value={String(zones.length)} />
        <Metric label="Active" value={String(active.length)} />
        <Metric label="Inactive" value={String(inactive.length)} />
        <Metric
          label="Capacity waits"
          value={String(zones.reduce((sum, z) => sum + z.capacityWaits, 0))}
        />
      </div>

      <Card className="!p-0 overflow-hidden">
        {zones.length === 0 ? (
          <p className="text-sm text-muted p-6">No regulated zone is recorded.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[900px]">
              <thead>
                <tr className="text-xs uppercase tracking-wide text-muted text-left border-b border-steel">
                  <th className="py-3 px-4">Zone</th>
                  <th className="py-3 px-4">Province</th>
                  <th className="py-3 px-4">State</th>
                  <th className="py-3 px-4">Geometry</th>
                  <th className="py-3 px-4 text-right">Authorized</th>
                  <th className="py-3 px-4 text-right">Jobs</th>
                  <th className="py-3 px-4 text-right">Capacity waits</th>
                  <th className="py-3 px-4">Last verified</th>
                  <th className="py-3 px-4">Source</th>
                </tr>
              </thead>
              <tbody>
                {zones.map((z) => (
                  <tr key={z.id} className="border-b border-steel/40 last:border-none">
                    <td className="py-2.5 px-4 font-medium">
                      {z.zoneCode ? `${z.zoneCode} · ` : ''}
                      {z.officialName}
                    </td>
                    <td className="py-2.5 px-4">{z.province}</td>
                    <td className="py-2.5 px-4">
                      <Badge tone={z.active ? 'green' : 'yellow'} dot={false}>
                        {z.active ? 'active' : 'inactive'}
                      </Badge>
                    </td>
                    <td className="py-2.5 px-4">
                      <span className={z.hasGeometry ? '' : 'text-muted'}>
                        {z.hasGeometry ? z.geometryConfidence : 'none'}
                      </span>
                    </td>
                    <td className="py-2.5 px-4 text-right tabular-nums">{z.authorizedProviders}</td>
                    <td className="py-2.5 px-4 text-right tabular-nums">{z.jobsAffected}</td>
                    <td
                      className={`py-2.5 px-4 text-right tabular-nums ${z.capacityWaits > 0 ? 'text-red' : ''}`}
                    >
                      {z.capacityWaits}
                    </td>
                    <td className="py-2.5 px-4 text-xs text-muted">{formatDate(z.lastVerifiedAt)}</td>
                    <td className="py-2.5 px-4">
                      <a
                        href={z.sourceUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-xs text-orange"
                      >
                        source ↗
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <p className="text-xs text-muted mt-4">
        No staleness threshold is applied to “last verified”: none has been agreed, and inventing one
        here would turn an engineering guess into a compliance rule. Zones are activated and verified
        from{' '}
        <Link href="/dashboard/admin/zones" className="text-orange">
          the regulated zones screen
        </Link>
        .
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
