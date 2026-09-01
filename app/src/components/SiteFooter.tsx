'use client';

import Link from 'next/link';
import { useLanguage } from '@/lib/i18n/LanguageProvider';
import { BrandMark } from './BrandMark';

export function SiteFooter() {
  const { t } = useLanguage();

  return (
    <footer className="hairline-top mt-auto border-t border-night-4 bg-night-2">
      <div className="max-w-5xl mx-auto px-5 sm:px-6 py-10 flex flex-col sm:flex-row sm:items-end gap-6 sm:justify-between">
        <div>
          <BrandMark size="md" className="block mb-2.5" />
          <p className="text-sm text-text-2">{t('footer_tagline')}</p>
          <p className="text-sm text-muted mt-1">{t('footer_area')}</p>
        </div>
        <div className="flex flex-col sm:items-end gap-2">
          <div className="flex gap-5 text-sm">
            <Link href="/login" className="text-text-2 hover:text-orange transition-colors">
              {t('nav_login')}
            </Link>
            <Link href="/signup" className="text-text-2 hover:text-orange transition-colors">
              {t('nav_signup')}
            </Link>
          </div>
          {/* Static year on purpose: a client-side new Date() here would
              hydrate differently from the server render around midnight. */}
          <p className="text-xs text-muted">© 2026 TowConnect. {t('footer_rights')}</p>
        </div>
      </div>
    </footer>
  );
}
