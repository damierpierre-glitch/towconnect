import {
  getCoverageReport,
  getGoNoGo,
  getPartnerReadiness,
  getPilotConfig,
  getReadinessItems,
  listPartnerLinks,
} from '@/lib/actions/pilot';
import { requireOpsPage } from '../opsGuard';
import { PilotConsole } from './PilotConsole';
import type {
  CoverageReportRow,
  GoNoGoCriterion,
  PartnerLink,
  PartnerReadiness,
  PilotConfig,
  ReadinessItem,
} from '@/lib/supabase/types';

export default async function PilotPage() {
  const capabilities = await requireOpsPage(['operations']);

  // Each read is guarded separately in the database. They are gathered
  // individually rather than in one Promise.all so that one unreadable
  // section does not blank the launch checklist.
  let config: PilotConfig | null = null;
  let goNoGo: GoNoGoCriterion[] = [];
  let readiness: ReadinessItem[] = [];
  let coverage: CoverageReportRow[] = [];
  let partners: PartnerReadiness[] = [];
  let links: PartnerLink[] = [];

  try {
    config = await getPilotConfig();
  } catch {
    /* rendered as absent */
  }
  try {
    goNoGo = await getGoNoGo();
  } catch {
    /* rendered as absent */
  }
  try {
    readiness = await getReadinessItems();
  } catch {
    /* rendered as absent */
  }
  try {
    coverage = await getCoverageReport();
  } catch {
    /* rendered as absent */
  }
  try {
    partners = await getPartnerReadiness();
  } catch {
    /* rendered as absent */
  }
  try {
    links = await listPartnerLinks();
  } catch {
    /* rendered as absent */
  }

  return (
    <PilotConsole
      capabilities={capabilities}
      config={config}
      goNoGo={goNoGo}
      readiness={readiness}
      coverage={coverage}
      partners={partners}
      links={links}
    />
  );
}
