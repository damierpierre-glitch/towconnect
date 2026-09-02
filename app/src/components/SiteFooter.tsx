'use client';

import Link from 'next/link';
import { useLanguage } from '@/lib/i18n/LanguageProvider';
import { BrandMark } from './BrandMark';

export function SiteFooter() {
  const { t, lang } = useLanguage();
  const fr = lang === 'fr';

  // Two columns rather than one row of links: the trust pages and the legal
  // pages answer different questions, and a visitor looking for the privacy
  // policy should not have to read past "How it works" to find it.
  const learn = [
    { href: '/comment-ca-marche', label: fr ? 'Comment ça marche' : 'How it works' },
    { href: '/securite', label: fr ? 'Sécurité' : 'Safety' },
    { href: '/a-propos', label: fr ? 'À propos' : 'About' },
    { href: '/contact', label: fr ? 'Nous joindre' : 'Contact' },
  ];

  const legal = [
    { href: '/conditions', label: fr ? "Conditions d'utilisation" : 'Terms of service' },
    { href: '/confidentialite', label: fr ? 'Confidentialité' : 'Privacy' },
    { href: '/conditions-partenaires', label: fr ? 'Conditions partenaires' : 'Partner terms' },
  ];

  return (
    <footer className="hairline-top mt-auto border-t border-night-4 bg-night-2">
      <div className="max-w-5xl mx-auto px-5 sm:px-6 py-10">
        <div className="flex flex-col sm:flex-row gap-8 sm:gap-10 sm:justify-between">
          <div className="sm:max-w-xs">
            <BrandMark size="md" className="block mb-2.5" />
            <p className="text-sm text-text-2">{t('footer_tagline')}</p>
            <p className="text-sm text-muted mt-1">{t('footer_area')}</p>
          </div>

          <nav aria-label={fr ? 'Liens du site' : 'Site links'} className="flex gap-10">
            <div>
              <h2 className="text-xs font-semibold text-text-2 uppercase tracking-wide mb-2.5">
                {fr ? 'Le service' : 'The service'}
              </h2>
              <ul className="flex flex-col gap-2">
                {learn.map((l) => (
                  <li key={l.href}>
                    <Link
                      href={l.href}
                      className="text-sm text-text-2 hover:text-orange transition-colors"
                    >
                      {l.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h2 className="text-xs font-semibold text-text-2 uppercase tracking-wide mb-2.5">
                {fr ? 'Juridique' : 'Legal'}
              </h2>
              <ul className="flex flex-col gap-2">
                {legal.map((l) => (
                  <li key={l.href}>
                    <Link
                      href={l.href}
                      className="text-sm text-text-2 hover:text-orange transition-colors"
                    >
                      {l.label}
                    </Link>
                  </li>
                ))}
              </ul>
              <ul className="flex gap-5 mt-4">
                <li>
                  <Link href="/login" className="text-sm text-text-2 hover:text-orange transition-colors">
                    {t('nav_login')}
                  </Link>
                </li>
                <li>
                  <Link href="/signup" className="text-sm text-text-2 hover:text-orange transition-colors">
                    {t('nav_signup')}
                  </Link>
                </li>
              </ul>
            </div>
          </nav>
        </div>

        {/* Static year on purpose: a client-side new Date() here would
            hydrate differently from the server render around midnight. */}
        <p className="text-xs text-muted mt-8">© 2026 TowConnect. {t('footer_rights')}</p>
      </div>
    </footer>
  );
}
