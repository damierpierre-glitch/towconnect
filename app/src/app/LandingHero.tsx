'use client';

import Link from 'next/link';
import { useLanguage } from '@/lib/i18n/LanguageProvider';
import { Card } from '@/components/ui/Card';

export function LandingHero() {
  const { t } = useLanguage();

  return (
    <div>
      <div
        className="text-center px-5 pt-16 pb-10"
        style={{
          background:
            'radial-gradient(ellipse at 50% 0%, rgba(255,92,26,0.12) 0%, transparent 70%)',
        }}
      >
        <span className="text-6xl mb-4 block">🚨</span>
        <h1 className="font-display text-3xl md:text-[42px] font-extrabold leading-tight mb-4">
          {t('hero_title_1')}
          <br />
          {t('hero_title_2')} <span className="text-orange">{t('hero_title_3')}</span>
        </h1>
        <p className="text-[17px] text-text-2 max-w-lg mx-auto mb-8 leading-relaxed">
          {t('hero_sub')}
        </p>
        <div className="flex gap-2.5 justify-center flex-wrap mb-10">
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-green/15 text-green">
            {t('badge_canada')}
          </span>
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-orange/15 text-orange">
            {t('badge_fast')}
          </span>
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-blue/15 text-blue">
            {t('badge_safe')}
          </span>
        </div>
        <div className="flex gap-3 justify-center flex-wrap">
          <Link href="/signup" className="px-8 py-4 rounded-xl bg-orange text-white font-semibold text-[17px]">
            🚨 {t('btn_emergency')}
          </Link>
          <Link
            href="/login"
            className="px-8 py-4 rounded-xl bg-night-3 text-text-2 border border-steel font-semibold text-[17px]"
          >
            {t('nav_login')}
          </Link>
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-6 pb-16">
        <div className="grid md:grid-cols-3 gap-4">
          <FeatureCard icon="💵" title={t('feat1_title')} sub={t('feat1_sub')} />
          <FeatureCard icon="📍" title={t('feat2_title')} sub={t('feat2_sub')} />
          <FeatureCard icon="🍁" title={t('feat3_title')} sub={t('feat3_sub')} />
        </div>
      </div>
    </div>
  );
}

function FeatureCard({ icon, title, sub }: { icon: string; title: string; sub: string }) {
  return (
    <Card className="text-center py-7 px-5">
      <div className="text-4xl mb-3">{icon}</div>
      <h4 className="font-display font-bold mb-1.5">{title}</h4>
      <p className="text-sm text-muted">{sub}</p>
    </Card>
  );
}
