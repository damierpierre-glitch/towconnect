import type { UserRole } from './supabase/types';

export function roleHome(role: UserRole): string {
  if (role === 'driver') return '/dashboard/driver';
  if (role === 'admin') return '/dashboard/admin';
  return '/request';
}
