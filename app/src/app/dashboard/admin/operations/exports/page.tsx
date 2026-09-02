import { listAvailableExports, listExportAudit } from '@/lib/actions/exports';
import { requireOpsPage } from '../opsGuard';
import { ExportsConsole } from './ExportsConsole';
import type { ExportAuditRow } from '@/lib/actions/exports';

export default async function ExportsPage() {
  const capabilities = await requireOpsPage(['operations', 'finance', 'support', 'super_admin']);
  const datasets = await listAvailableExports();

  // Who exported what is itself sensitive, so only a super admin sees it. The
  // policy refuses the read regardless; failing softly keeps the page usable
  // for everybody else.
  let audit: ExportAuditRow[] = [];
  if (capabilities.superAdmin) {
    try {
      audit = await listExportAudit();
    } catch {
      audit = [];
    }
  }

  return <ExportsConsole capabilities={capabilities} datasets={datasets} audit={audit} />;
}
