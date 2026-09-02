import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { getNotificationPreferences, listNotifications } from '@/lib/actions/notifications';
import { NotificationCentre } from './NotificationCentre';

export default async function NotificationsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  // Both reads are scoped by RLS to the caller — a notification belongs to
  // exactly one person and there is no admin policy over this table.
  const [notifications, preferences] = await Promise.all([
    listNotifications(),
    getNotificationPreferences(),
  ]);

  return <NotificationCentre notifications={notifications} preferences={preferences} />;
}
