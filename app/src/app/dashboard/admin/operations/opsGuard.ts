import 'server-only';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { roleHome } from '@/lib/roleHome';
import { getMyCapabilities } from '@/lib/actions/operations';
import type { AdminCapability } from '@/lib/supabase/types';

/**
 * The page-level gate for every command centre route.
 *
 * This is a redirect, not a protection: the database refuses the underlying
 * reads whatever this returns (0041/0042). Its job is to send somebody
 * somewhere useful instead of showing them an empty screen full of errors.
 */
export async function requireOpsPage(
  needs: AdminCapability[] = []
): Promise<Awaited<ReturnType<typeof getMyCapabilities>>> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single();
  if (!profile || profile.role !== 'admin') redirect(roleHome(profile?.role ?? 'user'));

  const capabilities = await getMyCapabilities();
  if (needs.length) {
    const held: Record<AdminCapability, boolean> = {
      super_admin: capabilities.superAdmin,
      operations: capabilities.operations,
      finance: capabilities.finance,
      support: capabilities.support,
    };
    if (!needs.some((n) => held[n])) redirect('/dashboard/admin/operations');
  }
  return capabilities;
}
