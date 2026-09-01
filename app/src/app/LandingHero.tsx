'use client';

import Link from 'next/link';
import { useLanguage } from '@/lib/i18n/LanguageProvider';
import { BrandMark } from '@/components/BrandMark';

export function LandingHero() {
  const { t } = useLanguage();

  return (
    <div className="overflow-x-hidden">
      {/* ---------------------------------------------------------------- hero */}
      <section className="relative overflow-hidden brand-aura brand-grid">
        <div className="relative max-w-3xl mx-auto px-5 sm:px-6 pt-14 sm:pt-24 pb-14 sm:pb-20 text-center">
          {/* The stacked lockup, with the symbol at full size — the navbar
              carries the small horizontal arrangement, so this is a different
              view of the mark rather than the same one twice. It replaces the
              typographic eyebrow that stood in while no logo existed; the
              tagline it carried now lives in the footer. */}
          <div className="flex justify-center mb-6 sm:mb-7">
            <BrandMark size="lg" />
          </div>

          <h1 className="font-display font-extrabold text-[34px] leading-[1.08] sm:text-[52px] lg:text-[62px] tracking-[-0.03em] text-balance mb-5">
            {t('hero_title_1')}
            <br className="hidden sm:block" />{' '}
            {t('hero_title_2')} <span className="text-orange">{t('hero_title_3')}</span>
          </h1>

          <p className="text-[16px] sm:text-[18px] leading-relaxed text-text-2 max-w-xl mx-auto text-pretty mb-8">
            {t('hero_sub')}
          </p>

          <div className="flex flex-wrap gap-2 justify-center mb-9">
            <HeroBadge tone="orange">{t('badge_area')}</HeroBadge>
            <HeroBadge tone="neutral">{t('badge_fast')}</HeroBadge>
            <HeroBadge tone="neutral">{t('badge_safe')}</HeroBadge>
          </div>

          <div className="flex flex-col sm:flex-row gap-3 sm:justify-center">
            <Link
              href="/signup"
              className="cta-glow px-8 py-4 rounded-xl bg-orange text-white font-semibold text-[17px] hover:bg-orange-dark transition-colors"
            >
              {t('btn_emergency')}
            </Link>
            <Link
              href="/login"
              className="px-8 py-4 rounded-xl bg-night-2 text-text border border-night-4 font-semibold text-[17px] hover:border-orange hover:text-orange transition-colors"
            >
              {t('nav_login')}
            </Link>
          </div>
        </div>
      </section>

      {/* -------------------------------------------------------- how it works */}
      <section className="max-w-5xl mx-auto px-5 sm:px-6 py-14 sm:py-20">
        <SectionTitle>{t('home_how_title')}</SectionTitle>
        <ol className="grid gap-4 sm:grid-cols-3">
          <Step n={1} title={t('home_step1_title')} sub={t('home_step1_sub')} />
          <Step n={2} title={t('home_step2_title')} sub={t('home_step2_sub')} />
          <Step n={3} title={t('home_step3_title')} sub={t('home_step3_sub')} />
        </ol>
      </section>

      {/* ------------------------------------------------------- feature cards */}
      <section className="max-w-5xl mx-auto px-5 sm:px-6 pb-14 sm:pb-20">
        <div className="grid gap-4 sm:grid-cols-3">
          <FeatureCard icon={<IconTag />} title={t('feat1_title')} sub={t('feat1_sub')} />
          <FeatureCard icon={<IconPin />} title={t('feat2_title')} sub={t('feat2_sub')} />
          <FeatureCard icon={<IconRoute />} title={t('feat3_title')} sub={t('feat3_sub')} />
        </div>
      </section>

      {/* ------------------------------------------------------------ closing */}
      <section className="max-w-5xl mx-auto px-5 sm:px-6 pb-16 sm:pb-24">
        <div className="relative overflow-hidden rounded-[24px] border border-night-4 bg-night-2 px-6 sm:px-12 py-12 sm:py-14 text-center brand-aura hairline-top">
          <h2 className="font-display text-[26px] sm:text-[34px] font-extrabold tracking-[-0.02em] text-balance mb-3">
            {t('home_cta_title')}
          </h2>
          <p className="text-text-2 max-w-md mx-auto text-pretty mb-7">{t('home_cta_sub')}</p>
          <Link
            href="/signup"
            className="cta-glow inline-block px-8 py-4 rounded-xl bg-orange text-white font-semibold text-[17px] hover:bg-orange-dark transition-colors"
          >
            {t('btn_emergency')}
          </Link>

          <div className="mt-10 pt-8 border-t border-night-4">
            <p className="text-sm font-semibold mb-1">{t('home_driver_title')}</p>
            <p className="text-sm text-muted max-w-md mx-auto text-pretty mb-3">
              {t('home_driver_sub')}
            </p>
            <Link
              href="/signup"
              className="text-sm text-orange font-semibold hover:text-orange-light transition-colors"
            >
              {t('home_driver_cta')} →
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="font-display text-[22px] sm:text-[28px] font-extrabold tracking-[-0.02em] text-center mb-8 sm:mb-10">
      {children}
    </h2>
  );
}

function HeroBadge({
  tone,
  children,
}: {
  tone: 'orange' | 'neutral';
  children: React.ReactNode;
}) {
  const toneClass =
    tone === 'orange'
      ? 'bg-orange/12 text-orange border-orange/30'
      : 'bg-night-2 text-text-2 border-night-4';
  return (
    <span
      className={`inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full border text-[13px] font-semibold ${toneClass}`}
    >
      <span className="w-1.5 h-1.5 rounded-full bg-current" />
      {children}
    </span>
  );
}

function Step({ n, title, sub }: { n: number; title: string; sub: string }) {
  return (
    <li className="surface-card rounded-[20px] p-6">
      <span className="inline-flex items-center justify-center w-9 h-9 rounded-lg bg-orange/12 text-orange font-sans font-semibold text-[15px] mb-4">
        {n}
      </span>
      <h3 className="font-display font-bold text-[17px] mb-1.5 text-balance">{title}</h3>
      <p className="text-sm text-muted leading-relaxed text-pretty">{sub}</p>
    </li>
  );
}

function FeatureCard({
  icon,
  title,
  sub,
}: {
  icon: React.ReactNode;
  title: string;
  sub: string;
}) {
  return (
    <div className="surface-card rounded-[20px] p-6 text-center">
      <span className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-orange/12 text-orange mb-4">
        {icon}
      </span>
      <h3 className="font-display font-bold text-[17px] mb-1.5 text-balance">{title}</h3>
      <p className="text-sm text-muted leading-relaxed text-pretty">{sub}</p>
    </div>
  );
}

/* Line icons rather than emoji: emoji render differently on every platform,
   which is the one thing a brand pass is supposed to stop happening. */

const iconProps = {
  width: 22,
  height: 22,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

function IconTag() {
  return (
    <svg {...iconProps}>
      <path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0l-7.2-7.2A2 2 0 0 1 2.8 12V4.8A2 2 0 0 1 4.8 2.8H12a2 2 0 0 1 1.4.6l7.2 7.2a2 2 0 0 1 0 2.8Z" />
      <path d="M7.5 7.5h.01" />
    </svg>
  );
}

function IconPin() {
  return (
    <svg {...iconProps}>
      <path d="M20 10c0 5.4-8 12-8 12s-8-6.6-8-12a8 8 0 0 1 16 0Z" />
      <circle cx="12" cy="10" r="2.8" />
    </svg>
  );
}

function IconRoute() {
  return (
    <svg {...iconProps}>
      <circle cx="6" cy="18.5" r="2.5" />
      <circle cx="18" cy="5.5" r="2.5" />
      <path d="M15.5 5.5H10a3.5 3.5 0 0 0 0 7h4a3.5 3.5 0 0 1 0 7H8.5" />
    </svg>
  );
}
