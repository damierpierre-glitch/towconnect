import { requireOpsPage } from '../opsGuard';
import { SupportConsole } from './SupportConsole';

export default async function SupportPage() {
  const capabilities = await requireOpsPage(['support', 'operations']);
  return <SupportConsole capabilities={capabilities} />;
}
