import { listIncidents, listRiskFlags } from '@/lib/actions/operations';
import { requireOpsPage } from '../opsGuard';
import { IncidentsBoard } from './IncidentsBoard';
import type { RiskFlag } from '@/lib/supabase/types';

export default async function IncidentsPage() {
  const capabilities = await requireOpsPage(['operations', 'support']);
  const incidents = await listIncidents();

  // Risk flags are operations-only: the subject of a flag must never read it,
  // and support has no reason to.
  let flags: RiskFlag[] = [];
  if (capabilities.operations) {
    try {
      flags = await listRiskFlags();
    } catch {
      flags = [];
    }
  }

  return <IncidentsBoard capabilities={capabilities} incidents={incidents} flags={flags} />;
}
