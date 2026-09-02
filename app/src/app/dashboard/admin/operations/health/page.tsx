import { getAlerts, getFunnel, getSystemHealth } from '@/lib/actions/pilot';
import { requireOpsPage } from '../opsGuard';
import { HealthBoard } from './HealthBoard';
import type { FunnelStep, OpsAlert, SystemHealthComponent } from '@/lib/supabase/types';

export default async function HealthPage() {
  const capabilities = await requireOpsPage(['operations']);

  // Each read is separately guarded in the database, and a component that
  // cannot be read must not take the whole page down with it — the page whose
  // entire purpose is telling you what is broken is the worst possible page to
  // fail closed.
  let health: SystemHealthComponent[] = [];
  let alerts: OpsAlert[] = [];
  let funnel: FunnelStep[] = [];
  let healthError: string | null = null;

  try {
    health = await getSystemHealth();
  } catch {
    healthError = 'System health could not be read.';
  }
  try {
    alerts = await getAlerts();
  } catch {
    /* Absent rather than wrong: the health list above already says what it can. */
  }

  const to = new Date();
  const from = new Date(to.getTime() - 30 * 24 * 3600 * 1000);
  try {
    funnel = await getFunnel(from.toISOString(), to.toISOString());
  } catch {
    /* Funnel needs operations or finance; a support admin simply sees none. */
  }

  return (
    <HealthBoard
      capabilities={capabilities}
      health={health}
      healthError={healthError}
      alerts={alerts}
      funnel={funnel}
      periodDays={30}
    />
  );
}
