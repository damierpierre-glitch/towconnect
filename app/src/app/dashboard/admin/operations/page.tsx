import { getAttentionQueue, getOperationsSnapshot, getOpsKpis, getReconciliationExceptions } from '@/lib/actions/operations';
import { requireOpsPage } from './opsGuard';
import { CommandCentre } from './CommandCentre';
import type { AttentionItem, OpsKpis, ReconciliationException } from '@/lib/supabase/types';
import type { OperationsSnapshot } from '@/lib/actions/operations';

export default async function OperationsHomePage() {
  const capabilities = await requireOpsPage();

  // Each read is capability-gated in the database, so an admin scoped to
  // support gets the queue and nothing else. Failing softly per section beats
  // failing the whole page: a support agent should still see their queue.
  const soft = async <T,>(fn: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await fn();
    } catch {
      return fallback;
    }
  };

  const emptySnapshot: OperationsSnapshot = {
    activeRequests: 0,
    pendingRequests: 0,
    openOffers: 0,
    driversOnline: 0,
    driversStale: 0,
    regulatedActive: 0,
    paymentsNeedingAttention: 0,
    refundsInFlight: 0,
    supplementsUncollected: 0,
    payoutsAwaiting: 0,
    openIncidents: 0,
  };

  const [queue, snapshot, kpis, exceptions] = await Promise.all([
    soft<AttentionItem[]>(getAttentionQueue, []),
    soft<OperationsSnapshot>(getOperationsSnapshot, emptySnapshot),
    soft<OpsKpis | null>(() => getOpsKpis(30), null),
    soft<ReconciliationException[]>(getReconciliationExceptions, []),
  ]);

  return (
    <CommandCentre
      capabilities={capabilities}
      queue={queue}
      snapshot={snapshot}
      kpis={kpis}
      exceptions={exceptions}
      hasSnapshot={capabilities.operations}
    />
  );
}
