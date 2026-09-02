'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useLanguage } from '@/lib/i18n/LanguageProvider';
import { useToast } from '@/components/ToastProvider';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { formatDateTime } from '@/lib/formatDate';
import {
  markAllNotificationsRead,
  markNotificationRead,
  setNotificationPreference,
} from '@/lib/actions/notifications';
import { isCriticalCategory } from '@/lib/notificationCategories';
import type {
  AppNotification,
  NotificationCategory,
  NotificationPreference,
} from '@/lib/supabase/types';
import { errorMessageKey } from '@/lib/errors';

// The notification centre.
//
// Text is rendered here, from a type and a payload — never stored as a
// finished sentence. The same event reaches a rider and a driver, and each
// reads it in their own language.

// Labels and the reason a category cannot be switched off. Whether it is
// critical comes from the shared list, so this screen and the database cannot
// disagree about which switches exist.
const CATEGORY_META: Record<
  NotificationCategory,
  { fr: string; en: string; why: { fr: string; en: string } }
> = {
  job_progress: {
    fr: 'Progression de l’intervention',
    en: 'Rescue progress',
    why: {
      fr: 'Ne peut pas être désactivé : ce sont les messages qui vous disent que quelqu’un arrive.',
      en: 'Cannot be switched off: these are the messages telling you somebody is coming.',
    },
  },
  payment: {
    fr: 'Paiement',
    en: 'Payment',
    why: {
      fr: 'Ne peut pas être désactivé : un paiement à confirmer bloque l’intervention.',
      en: 'Cannot be switched off: a payment awaiting you holds up the rescue.',
    },
  },
  messages: { fr: 'Messages', en: 'Messages', why: { fr: '', en: '' } },
  account: { fr: 'Compte', en: 'Account', why: { fr: '', en: '' } },
};

function render(n: AppNotification, lang: 'fr' | 'en'): { icon: string; title: string; body: string | null } {
  const p = n.payload as { driver_first_name?: string; amount?: number | string; type_key?: string };
  const name = p.driver_first_name ?? (lang === 'fr' ? 'Votre remorqueur' : 'Your tow operator');
  const amount = p.amount == null ? null : `$${Number(p.amount).toFixed(2)}`;

  switch (n.type) {
    case 'driver_found':
      return {
        icon: '🚚',
        title: lang === 'fr' ? 'Un remorqueur a accepté' : 'A tow operator accepted',
        body: lang === 'fr' ? `${name} prend en charge votre demande.` : `${name} is taking your request.`,
      };
    case 'driver_en_route':
      return {
        icon: '🛣️',
        title: lang === 'fr' ? 'En route' : 'On the way',
        body: lang === 'fr' ? `${name} est parti vers vous.` : `${name} has set off towards you.`,
      };
    case 'driver_arrived':
      return {
        icon: '📍',
        title: lang === 'fr' ? 'Arrivé sur place' : 'Arrived',
        body: lang === 'fr' ? `${name} est sur place.` : `${name} is at your location.`,
      };
    case 'job_in_progress':
      return {
        icon: '🔧',
        title: lang === 'fr' ? 'Intervention en cours' : 'Work in progress',
        body: null,
      };
    case 'job_completed':
      return {
        icon: '✅',
        title: lang === 'fr' ? 'Intervention terminée' : 'Rescue finished',
        body: lang === 'fr' ? 'Votre reçu est disponible.' : 'Your receipt is available.',
      };
    case 'job_cancelled':
      return {
        icon: '✖️',
        title: lang === 'fr' ? 'Course annulée' : 'Job cancelled',
        body: null,
      };
    case 'message_received':
      return {
        icon: '💬',
        title: lang === 'fr' ? 'Nouveau message' : 'New message',
        body: null,
      };
    case 'supplement_proposed':
      return {
        icon: '➕',
        title: lang === 'fr' ? 'Supplément proposé' : 'Supplement proposed',
        body: amount
          ? lang === 'fr'
            ? `${amount} — à approuver avant tout prélèvement.`
            : `${amount} — nothing is charged until you approve it.`
          : null,
      };
    case 'supplement_needs_authentication':
      return {
        icon: '🔐',
        title: lang === 'fr' ? 'Votre banque demande une confirmation' : 'Your bank needs you to confirm',
        body: amount
          ? lang === 'fr'
            ? `Le supplément de ${amount} n’est pas encore facturé.`
            : `The ${amount} supplement has not been charged yet.`
          : null,
      };
    case 'payment_action_required':
      return {
        icon: '💳',
        title: lang === 'fr' ? 'Paiement à compléter' : 'Payment needs completing',
        body: null,
      };
    case 'refund_issued':
      return {
        icon: '↩️',
        title: lang === 'fr' ? 'Remboursement émis' : 'Refund issued',
        body: amount ?? null,
      };
    default:
      return { icon: '🔔', title: n.type, body: null };
  }
}

export function NotificationCentre({
  notifications,
  preferences,
}: {
  notifications: AppNotification[];
  preferences: NotificationPreference[];
}) {
  const { lang, t } = useLanguage();
  const { showToast } = useToast();
  const [busy, setBusy] = useState(false);
  const [readIds, setReadIds] = useState<Set<number>>(new Set());
  const [showSettings, setShowSettings] = useState(false);

  const prefFor = (category: NotificationCategory) =>
    preferences.find((p) => p.category === category)?.in_app ?? true;

  const isRead = (n: AppNotification) => n.read_at != null || readIds.has(n.id);
  const unread = notifications.filter((n) => !isRead(n));

  async function run(fn: () => Promise<unknown>, done?: string) {
    setBusy(true);
    try {
      await fn();
      if (done) showToast('✅', done);
    } catch (e) {
      showToast('⚠️', t(errorMessageKey(e)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 py-8">
      <header className="mb-5 flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="font-display text-2xl font-bold">
            {lang === 'fr' ? 'Notifications' : 'Notifications'}
          </h1>
          <p className="text-sm text-muted mt-1">
            {unread.length === 0
              ? lang === 'fr'
                ? 'Tout est lu.'
                : 'All caught up.'
              : `${unread.length} ${lang === 'fr' ? 'non lue(s)' : 'unread'}`}
          </p>
        </div>
        <div className="flex gap-2">
          {unread.length > 0 ? (
            <Button
              variant="secondary"
              className="!px-3 !py-1.5 !text-xs"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  await markAllNotificationsRead();
                  setReadIds(new Set(notifications.map((n) => n.id)));
                })
              }
            >
              {lang === 'fr' ? 'Tout marquer lu' : 'Mark all read'}
            </Button>
          ) : null}
          <Button
            variant="secondary"
            className="!px-3 !py-1.5 !text-xs"
            onClick={() => setShowSettings((v) => !v)}
          >
            {lang === 'fr' ? 'Préférences' : 'Preferences'}
          </Button>
        </div>
      </header>

      {showSettings ? (
        <Card className="mb-5">
          <h2 className="font-display text-sm font-bold mb-3">
            {lang === 'fr' ? 'Ce que vous recevez' : 'What you receive'}
          </h2>
          <div className="flex flex-col gap-3">
            {(Object.keys(CATEGORY_META) as NotificationCategory[]).map((category) => {
              const meta = CATEGORY_META[category];
              const critical = isCriticalCategory(category);
              return (
                <div key={category} className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm">{lang === 'fr' ? meta.fr : meta.en}</div>
                    {critical ? (
                      <div className="text-xs text-muted mt-0.5">{meta.why[lang]}</div>
                    ) : null}
                  </div>
                  <label className="flex items-center gap-2 shrink-0">
                    <input
                      type="checkbox"
                      checked={critical ? true : prefFor(category)}
                      disabled={critical || busy}
                      onChange={(e) =>
                        run(
                          () => setNotificationPreference(category, e.target.checked),
                          lang === 'fr' ? 'Préférence enregistrée.' : 'Preference saved.'
                        )
                      }
                      className="w-4 h-4 accent-orange"
                    />
                    <span className="text-xs text-text-2">
                      {critical
                        ? lang === 'fr'
                          ? 'toujours'
                          : 'always'
                        : lang === 'fr'
                          ? 'dans l’app'
                          : 'in-app'}
                    </span>
                  </label>
                </div>
              );
            })}
          </div>
          <p className="text-xs text-muted mt-4">
            {lang === 'fr'
              ? 'Le refus des catégories critiques est appliqué par la base de données, pas par cet écran.'
              : 'The refusal on critical categories is enforced by the database, not by this screen.'}
          </p>
        </Card>
      ) : null}

      {notifications.length === 0 ? (
        <Card>
          <p className="text-sm text-muted text-center py-4">
            {lang === 'fr'
              ? 'Aucune notification. Vous en recevrez une dès qu’un remorqueur acceptera votre demande.'
              : 'No notifications. You will get one as soon as a tow operator accepts your request.'}
          </p>
        </Card>
      ) : (
        <Card className="!p-0 overflow-hidden">
          <div className="flex flex-col">
            {notifications.map((n) => {
              const view = render(n, lang);
              const read = isRead(n);
              const inner = (
                <div
                  className={`flex items-start gap-3 px-5 py-4 border-b border-steel/40 last:border-none ${
                    read ? '' : 'bg-night-3/60'
                  }`}
                >
                  <span className="text-lg shrink-0">{view.icon}</span>
                  <div className="min-w-0 flex-1">
                    <div className={`text-sm ${read ? 'text-text-2' : 'font-semibold'}`}>{view.title}</div>
                    {view.body ? <div className="text-xs text-muted mt-0.5">{view.body}</div> : null}
                    <div className="text-[11px] text-muted mt-1">{formatDateTime(n.created_at)}</div>
                  </div>
                  {!read ? <span className="w-2 h-2 rounded-full bg-orange shrink-0 mt-1.5" /> : null}
                </div>
              );

              return (
                <div
                  key={n.id}
                  onClick={() => {
                    if (read) return;
                    void run(async () => {
                      await markNotificationRead(n.id);
                      setReadIds((prev) => new Set(prev).add(n.id));
                    });
                  }}
                  className="cursor-pointer"
                >
                  {n.request_id ? (
                    <Link href={n.type === 'job_completed' ? `/history/${n.request_id}` : '/request'}>
                      {inner}
                    </Link>
                  ) : (
                    inner
                  )}
                </div>
              );
            })}
          </div>
        </Card>
      )}
    </div>
  );
}
