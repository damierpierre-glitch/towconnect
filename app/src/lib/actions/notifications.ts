'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import type {
  AppNotification,
  NotificationCategory,
  NotificationPreference,
  NotificationType,
} from '@/lib/supabase/types';

// Notifications.
//
// WRITTEN WHERE THE FACT HAPPENS, NOT WHERE SOMEBODY REMEMBERED TO CALL
// Most of them come from triggers on `requests`, `messages`,
// `request_supplements` and `refunds` (0046) — the same reasoning as
// request_events: a trigger on the table catches every path to a state,
// including the ones the application forgot. This file is what READS them,
// plus the handful of events that only trusted server code can know about.
//
// A notification stores a type and a payload, never a finished sentence. A
// rider and a driver read the same event in their own language, which is
// impossible once the text is baked in.

export async function listNotifications(limit = 50): Promise<AppNotification[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('notifications')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data ?? [];
}

export async function countUnread(): Promise<number> {
  const supabase = await createClient();
  const { count, error } = await supabase
    .from('notifications')
    .select('id', { count: 'exact', head: true })
    .is('read_at', null);
  if (error) throw error;
  return count ?? 0;
}

export async function markNotificationRead(id: number): Promise<void> {
  const supabase = await createClient();
  // RLS scopes this to the caller's own row; the filter is a convenience.
  const { error } = await supabase
    .from('notifications')
    .update({ read_at: new Date().toISOString() })
    .eq('id', id)
    .is('read_at', null);
  if (error) throw error;
  revalidatePath('/notifications');
}

export async function markAllNotificationsRead(): Promise<void> {
  const supabase = await createClient();
  const { error } = await supabase
    .from('notifications')
    .update({ read_at: new Date().toISOString() })
    .is('read_at', null);
  if (error) throw error;
  revalidatePath('/notifications');
}

// ---------------------------------------------------------------- preferences

export async function getNotificationPreferences(): Promise<NotificationPreference[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.from('notification_preferences').select('*');
  if (error) throw error;
  return data ?? [];
}

export async function setNotificationPreference(
  category: NotificationCategory,
  inApp: boolean
): Promise<void> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');

  const { error } = await supabase
    .from('notification_preferences')
    .upsert(
      { profile_id: user.id, category, in_app: inApp, updated_at: new Date().toISOString() },
      { onConflict: 'profile_id,category' }
    );
  // The trigger in 0046 raises for a critical category; surface that sentence
  // rather than a Postgres error code.
  if (error) {
    throw new Error(
      /cannot be switched off/i.test(error.message)
        ? 'Notifications about an active job and its payment cannot be switched off.'
        : error.message
    );
  }
  revalidatePath('/notifications');
}

// ---------------------------------------------------------------- emitting

/**
 * Emit an event only trusted server code can know about.
 *
 * Everything with a database fact behind it is emitted by a trigger instead.
 * This exists for the two cases where there is no row to hang a trigger on:
 * a payment that needs the customer to come back and authenticate, and any
 * future event that lives outside the tables.
 */
export async function emitNotification(input: {
  recipientId: string;
  type: NotificationType;
  category: NotificationCategory;
  requestId?: string | null;
  payload?: Record<string, unknown>;
}): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin.rpc('notify_user' as never, {
    p_recipient: input.recipientId,
    p_type: input.type,
    p_category: input.category,
    p_request_id: input.requestId ?? null,
    p_payload: input.payload ?? {},
  } as never);
  if (error) throw error;
}
