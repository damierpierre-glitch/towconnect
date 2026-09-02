import { requireOpsPage } from '../opsGuard';
import { LiveOperationsMap } from './LiveOperationsMap';

export default async function OperationsMapPage() {
  const capabilities = await requireOpsPage(['operations', 'support']);
  return <LiveOperationsMap capabilities={capabilities} />;
}
