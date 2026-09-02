'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useLanguage } from '@/lib/i18n/LanguageProvider';
import { signOut } from '@/lib/actions/auth';
import { BrandMark } from './BrandMark';
import type { UserRole } from '@/lib/supabase/types';

interface NavBarProps {
  role: UserRole | null;
  hasCompany?: boolean;
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
// Added in Phase 6. Rendered only for a user who actually belongs to a
// company, so a solo driver's bar is unchanged.
const businessLink: SubLink = {
  href: '/dashboard/business',
  icon: '🏢',
  fr: 'Entreprise',
  en: 'Business',
};

const adminSubLinks: SubLink[] = [
  // Phase 8. First in the list because it is the screen an operator on shift
  // opens: everything else here is a place you go when you already know what
  // you are looking for.
  { href: '/dashboard/admin/operations', icon: '🎛️', fr: 'Opérations', en: 'Operations' },
  { href: '/dashboard/admin/zones', icon: '⚠️', fr: 'Zones', en: 'Zones' },
  // Phase 7. Two separate screens on purpose: deciding the economics and
  // watching the money are different jobs, and putting the commission form
  // next to a refund button invites the wrong one to be clicked.
  { href: '/dashboard/admin/economics', icon: '⚖️', fr: 'Économie', en: 'Economics' },
  { href: '/dashboard/admin/finance', icon: '💵', fr: 'Finance', en: 'Finance' },
];

const driverSubLinks: SubLink[] = [
  { href: '/dashboard/driver/profile', icon: '🪪', fr: 'Profil', en: 'Profile' },
  { href: '/dashboard/driver/documents', icon: '📄', fr: 'Documents', en: 'Documents' },
  { href: '/dashboard/driver/earnings', icon: '💰', fr: 'Revenus', en: 'Earnings' },
  { href: '/dashboard/driver/history', icon: '🧾', fr: 'Historique', en: 'History' },
  { href: '/dashboard/driver/performance', icon: '📈', fr: 'Performance', en: 'Performance' },
];

export function NavBar({ role, hasCompany = false }: NavBarProps) {
  const { t, lang, toggleLang } = useLanguage();
  const pathname = usePathname();
  const tab = role ? tabsByRole[role] : null;
  const baseSubLinks =
    role === 'user' ? userSubLinks : role === 'driver' ? driverSubLinks : role === 'admin' ? adminSubLinks : [];
  const subLinks = hasCompany ? [...baseSubLinks, businessLink] : baseSubLinks;
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <nav className="sticky top-0 z-[100] border-b border-night-4 bg-night/85 backdrop-blur-xl supports-[backdrop-filter]:bg-night/70">
      <div className="flex items-center justify-between gap-2 sm:gap-3 px-3.5 sm:px-7 py-3.5">
        {/* The mark used to be a 🚛 emoji in an orange tile — a different
            drawing on every OS, and a stand-in logo the brand never chose.
            BrandMark is the single place the real asset gets installed. */}
        <Link href="/" className="flex items-center shrink-0" aria-label="TowConnect">
          <BrandMark size="sm" />
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

        <div className="flex items-center gap-2 sm:gap-3">
          <button
            onClick={toggleLang}
            className="px-2 sm:px-3.5 py-1.5 rounded-lg border border-night-4 text-text-2 text-sm whitespace-nowrap hover:border-orange hover:text-orange transition-colors"
          >
            {/* Syne is a wide face — the wordmark alone is ~10x its font size.
                Below 360px the globe is the first thing that has to go for the
                bar to stay on one line. */}
            <span className="hidden min-[360px]:inline">🌐 </span>
            {lang === 'fr' ? 'EN' : 'FR'}
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
              {/* Hidden below 380px only: at that width the logo, the language
                  toggle and two auth actions cannot all sit on one line, and
                  the signup button is the one worth keeping. */}
              <Link
                href="/login"
                className="hidden min-[380px]:inline text-sm text-text-2 hover:text-orange transition-colors"
              >
                {t('nav_login')}
              </Link>
              <Link
                href="/signup"
                className="px-2.5 min-[360px]:px-3 sm:px-4 py-2 rounded-lg bg-orange text-white text-sm font-semibold whitespace-nowrap hover:bg-orange-dark transition-colors"
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
