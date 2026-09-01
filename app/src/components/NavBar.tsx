'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useLanguage } from '@/lib/i18n/LanguageProvider';
import { signOut } from '@/lib/actions/auth';
import type { UserRole } from '@/lib/supabase/types';

interface NavBarProps {
  role: UserRole | null;
}

const tabsByRole: Record<UserRole, { href: string; key: 'nav_user' | 'nav_driver' | 'nav_admin'; icon: string }> = {
  user: { href: '/request', key: 'nav_user', icon: '👤' },
  driver: { href: '/dashboard/driver', key: 'nav_driver', icon: '🚛' },
  admin: { href: '/dashboard/admin', key: 'nav_admin', icon: '📊' },
};

interface SubLink {
  href: string;
  icon: string;
  fr: string;
  en: string;
}

const userSubLinks: SubLink[] = [
  { href: '/vehicles', icon: '🚗', fr: 'Mes véhicules', en: 'My vehicles' },
  { href: '/history', icon: '🧾', fr: 'Historique', en: 'History' },
  { href: '/payment-methods', icon: '💳', fr: 'Paiement', en: 'Payment' },
];

// Phase 5 added several driver sub-pages (profile, documents, earnings,
// history, performance) — a driver reaching them only by typing a URL isn't
// acceptable for the exact audience this phase targets: someone in a truck,
// on a phone, one hand free. This list is what both the desktop bar and the
// mobile menu below render from, so the two never drift apart.
const driverSubLinks: SubLink[] = [
  { href: '/dashboard/driver/profile', icon: '🪪', fr: 'Profil', en: 'Profile' },
  { href: '/dashboard/driver/documents', icon: '📄', fr: 'Documents', en: 'Documents' },
  { href: '/dashboard/driver/earnings', icon: '💰', fr: 'Revenus', en: 'Earnings' },
  { href: '/dashboard/driver/history', icon: '🧾', fr: 'Historique', en: 'History' },
  { href: '/dashboard/driver/performance', icon: '📈', fr: 'Performance', en: 'Performance' },
];

export function NavBar({ role }: NavBarProps) {
  const { t, lang, toggleLang } = useLanguage();
  const pathname = usePathname();
  const tab = role ? tabsByRole[role] : null;
  const subLinks = role === 'user' ? userSubLinks : role === 'driver' ? driverSubLinks : [];
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <nav className="bg-night-2 border-b border-steel sticky top-0 z-[100]">
      <div className="flex items-center justify-between px-4 sm:px-7 py-4">
        <Link href="/" className="flex items-center gap-2.5">
          <div className="w-9 h-9 bg-orange rounded-lg flex items-center justify-center text-lg">
            🚛
          </div>
          <div className="font-display font-extrabold text-lg">
            Tow<span className="text-orange">Connect</span>
          </div>
        </Link>

        <div className="hidden md:flex items-center gap-1">
          {tab ? (
            <Link
              href={tab.href}
              className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium ${
                pathname.startsWith(tab.href) && !subLinks.some((s) => pathname.startsWith(s.href))
                  ? 'bg-orange text-white'
                  : 'text-muted'
              }`}
            >
              {tab.icon} {t(tab.key)}
            </Link>
          ) : null}
          {subLinks.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium ${
                pathname.startsWith(l.href) ? 'bg-orange text-white' : 'text-muted'
              }`}
            >
              {l.icon} {lang === 'fr' ? l.fr : l.en}
            </Link>
          ))}
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={toggleLang}
            className="px-3.5 py-1.5 rounded-lg border border-steel text-text-2 text-sm hover:border-orange hover:text-orange transition-colors"
          >
            🌐 {lang === 'fr' ? 'EN' : 'FR'}
          </button>
          {role ? (
            <>
              {/* Everything above is `hidden md:flex` — on a phone this
                  button is the only way to reach anything but the current
                  page, so it stays visible whenever there's somewhere to go. */}
              {(tab || subLinks.length > 0) && (
                <button
                  onClick={() => setMenuOpen((v) => !v)}
                  aria-label={lang === 'fr' ? 'Menu' : 'Menu'}
                  aria-expanded={menuOpen}
                  className="md:hidden w-10 h-10 flex items-center justify-center rounded-lg border border-steel text-text-2"
                >
                  {menuOpen ? '✕' : '☰'}
                </button>
              )}
              <form action={signOut} className="hidden sm:block">
                <button className="text-sm text-text-2 hover:text-orange transition-colors">
                  {t('nav_logout')}
                </button>
              </form>
            </>
          ) : (
            <>
              <Link href="/login" className="text-sm text-text-2 hover:text-orange">
                {t('nav_login')}
              </Link>
              <Link
                href="/signup"
                className="px-4 py-2 rounded-lg bg-orange text-white text-sm font-semibold"
              >
                {t('nav_signup')}
              </Link>
            </>
          )}
        </div>
      </div>

      {menuOpen && role ? (
        <div className="md:hidden border-t border-steel px-4 py-3 flex flex-col gap-1">
          {tab ? (
            <Link
              href={tab.href}
              onClick={() => setMenuOpen(false)}
              className={`flex items-center gap-2 px-3 py-3 rounded-lg text-sm font-medium ${
                pathname.startsWith(tab.href) && !subLinks.some((s) => pathname.startsWith(s.href))
                  ? 'bg-orange text-white'
                  : 'text-text-2'
              }`}
            >
              {tab.icon} {t(tab.key)}
            </Link>
          ) : null}
          {subLinks.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              onClick={() => setMenuOpen(false)}
              className={`flex items-center gap-2 px-3 py-3 rounded-lg text-sm font-medium ${
                pathname.startsWith(l.href) ? 'bg-orange text-white' : 'text-text-2'
              }`}
            >
              {l.icon} {lang === 'fr' ? l.fr : l.en}
            </Link>
          ))}
          <form action={signOut} className="sm:hidden mt-1 border-t border-steel pt-3">
            <button className="px-3 py-2 text-sm text-text-2 hover:text-orange transition-colors">
              {t('nav_logout')}
            </button>
          </form>
        </div>
      ) : null}
    </nav>
  );
}
