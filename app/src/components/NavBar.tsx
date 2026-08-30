'use client';

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

export function NavBar({ role }: NavBarProps) {
  const { t, lang, toggleLang } = useLanguage();
  const pathname = usePathname();
  const tab = role ? tabsByRole[role] : null;

  return (
    <nav className="flex items-center justify-between px-7 py-4 bg-night-2 border-b border-steel sticky top-0 z-[100]">
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
          <span
            className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium ${
              pathname.startsWith(tab.href) ? 'bg-orange text-white' : 'text-muted'
            }`}
          >
            {tab.icon} {t(tab.key)}
          </span>
        ) : null}
      </div>

      <div className="flex items-center gap-3">
        <button
          onClick={toggleLang}
          className="px-3.5 py-1.5 rounded-lg border border-steel text-text-2 text-sm hover:border-orange hover:text-orange transition-colors"
        >
          🌐 {lang === 'fr' ? 'EN' : 'FR'}
        </button>
        {role ? (
          <form action={signOut}>
            <button className="text-sm text-text-2 hover:text-orange transition-colors">
              {t('nav_logout')}
            </button>
          </form>
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
    </nav>
  );
}
