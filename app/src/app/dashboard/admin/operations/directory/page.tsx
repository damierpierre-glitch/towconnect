import { listCompanyHealth, listDriverOps } from '@/lib/actions/operations';
import { requireOpsPage } from '../opsGuard';
import { FleetDirectory } from './FleetDirectory';

export default async function FleetDirectoryPage() {
  const capabilities = await requireOpsPage(['operations']);
  const [companies, drivers] = await Promise.all([listCompanyHealth(), listDriverOps()]);
  return <FleetDirectory capabilities={capabilities} companies={companies} drivers={drivers} />;
}
