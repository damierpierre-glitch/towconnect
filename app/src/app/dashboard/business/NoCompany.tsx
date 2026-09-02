'use client';

import { useLanguage } from '@/lib/i18n/LanguageProvider';
import { Card } from '@/components/ui/Card';

// Deliberately not a signup form. Creating a company is still a back-office
// action (there is no INSERT policy on `companies` for a normal session, by
// design in 0020/0024): letting anyone declare themself a tow operator, in a
// product whose whole Phase 6 is about who is legally allowed to tow where,
// would be the wrong first thing to build.
export function NoCompany() {
  const { t, lang } = useLanguage();
  return (
    <div className="max-w-md mx-auto px-5 sm:px-6 py-14">
      <Card className="text-center">
        <h1 className="font-display text-xl font-bold mb-2">{t('biz_title')}</h1>
        <p className="text-sm text-text-2">{t('biz_no_company')}</p>
        <p className="text-xs text-muted mt-3">
          {lang === 'fr'
            ? "L'accès entreprise est accordé par un administrateur TowConnect."
            : 'Business access is granted by a TowConnect administrator.'}
        </p>
      </Card>
    </div>
  );
}
