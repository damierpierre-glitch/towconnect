import type { NotificationCategory } from '@/lib/supabase/types';

// Which categories a person may switch off, and which they may not.
//
// The refusal itself lives in the database (a trigger in 0046). This list is
// how the UI knows not to offer a switch that would be rejected — and it lives
// outside the server-actions file because a 'use server' module may only
// export async functions.
export const NOTIFICATION_CATEGORIES: {
  category: NotificationCategory;
  critical: boolean;
}[] = [
  // Critical: these carry an active rescue. Somebody who silenced "your driver
  // has arrived" three months ago must not miss it tonight.
  { category: 'job_progress', critical: true },
  { category: 'payment', critical: true },
  { category: 'messages', critical: false },
  { category: 'account', critical: false },
];

export function isCriticalCategory(category: NotificationCategory): boolean {
  return NOTIFICATION_CATEGORIES.some((c) => c.category === category && c.critical);
}
