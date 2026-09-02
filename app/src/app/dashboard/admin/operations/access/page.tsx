import { listAdminAccounts } from '@/lib/actions/operations';
import { requireOpsPage } from '../opsGuard';
import { AccessControl } from './AccessControl';

export default async function AccessPage() {
  const capabilities = await requireOpsPage(['super_admin']);
  const accounts = await listAdminAccounts();
  return <AccessControl capabilities={capabilities} accounts={accounts} />;
}
