'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useLanguage } from '@/lib/i18n/LanguageProvider';

export interface Capabilities {
  operations: boolean;
  finance: boolean;
  support: boolean;
  superAdmin: boolean;
  scoped: boolean;
}

// The command centre's own navigation.
//
// A link is hidden when the capability behind it is missing — not to protect
// anything (the database refuses regardless) but because an operator should
// not be offered a door that will not open.
export function OperationsNav({ capabilities }: { capabilities: Capabilities }) {
  const { lang } = useLanguage();
  const pathname = usePathname();

  const links: { href: string; fr: string; en: string; show: boolean }[] = [
    { href: '/dashboard/admin/operations', fr: 'Centre', en: 'Command', show: true },
    { href: '/dashboard/admin/operations/map', fr: 'Carte', en: 'Map', show: capabilities.operations || capabilities.support },
    { href: '/dashboard/admin/operations/jobs', fr: 'Interventions', en: 'Jobs', show: capabilities.operations },
    { href: '/dashboard/admin/operations/dispatch', fr: 'Répartition', en: 'Dispatch', show: capabilities.operations },
    { href: '/dashboard/admin/operations/incidents', fr: 'Incidents', en: 'Incidents', show: capabilities.operations || capabilities.support },
    { href: '/dashboard/admin/operations/directory', fr: 'Flotte', en: 'Fleet', show: capabilities.operations },
    { href: '/dashboard/admin/operations/zones', fr: 'Zones', en: 'Zones', show: capabilities.operations },
    { href: '/dashboard/admin/operations/support', fr: 'Support', en: 'Support', show: capabilities.support || capabilities.operations },
    { href: '/dashboard/admin/operations/access', fr: 'Accès', en: 'Access', show: capabilities.superAdmin },
  ];

  return (
    <nav className="flex gap-1.5 overflow-x-auto pb-2 mb-5 -mx-1 px-1">
      {links
        .filter((l) => l.show)
        .map((l) => {
          const active = l.href === '/dashboard/admin/operations' ? pathname === l.href : pathname.startsWith(l.href);
          return (
            <Link
              key={l.href}
              href={l.href}
              className={`px-3.5 py-2 rounded-lg text-sm font-medium whitespace-nowrap transition-colors ${
                active ? 'bg-orange text-white' : 'bg-night-2 text-text-2 border border-night-4 hover:text-orange'
              }`}
            >
              {lang === 'fr' ? l.fr : l.en}
            </Link>
          );
        })}
    </nav>
  );
}
