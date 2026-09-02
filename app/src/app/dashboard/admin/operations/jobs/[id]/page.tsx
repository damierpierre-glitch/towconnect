import { notFound } from 'next/navigation';
import { explainDispatch, getJobDetail } from '@/lib/actions/operations';
import { requireOpsPage } from '../../opsGuard';
import { JobDetailView } from './JobDetailView';
import type { DispatchCandidateRow } from '@/lib/supabase/types';

export default async function OperationsJobDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const capabilities = await requireOpsPage(['operations']);
  const { id } = await params;

  let detail;
  try {
    detail = await getJobDetail(id);
  } catch {
    notFound();
  }

  // The explain view is the same query dispatch uses. It can legitimately fail
  // for a request the engine can no longer evaluate (a deleted driver, a
  // cancelled job), and that must not take the whole page down.
  let candidates: DispatchCandidateRow[] = [];
  try {
    candidates = await explainDispatch(id);
  } catch {
    candidates = [];
  }

  return <JobDetailView capabilities={capabilities} detail={detail} candidates={candidates} />;
}
