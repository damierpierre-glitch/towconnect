import { listJobs } from '@/lib/actions/operations';
import { requireOpsPage } from '../opsGuard';
import { JobsMonitor } from './JobsMonitor';
import type { RequestStatus } from '@/lib/supabase/types';

export default async function OperationsJobsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; regulated?: string; older?: string }>;
}) {
  const capabilities = await requireOpsPage(['operations']);
  const params = await searchParams;

  const jobs = await listJobs({
    status: params.status ? (params.status.split(',') as RequestStatus[]) : undefined,
    regulatedOnly: params.regulated === '1',
    olderThanMinutes: params.older ? Number(params.older) : null,
  });

  return <JobsMonitor capabilities={capabilities} jobs={jobs} />;
}
