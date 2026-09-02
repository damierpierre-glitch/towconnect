'use client';

import Link from 'next/link';
import { useLanguage } from '@/lib/i18n/LanguageProvider';
import { PUBLIC_PAGES, type PublicPageKey } from '@/lib/content/publicPages';

// One renderer for every public page.
//
// The pages differ in what they say, not in how they are built, so there is
// one component and one content file rather than eleven near-identical
// layouts drifting apart. It is a client component for a single reason: the
// language toggle is client state, and a marketing page that stays French
// when the rest of the product switches to English is a page that is quietly
// making a promise in a language the reader did not choose.
export function PublicArticle({ page }: { page: PublicPageKey }) {
  const { lang } = useLanguage();
  const content = PUBLIC_PAGES[lang][page];

  return (
    <div className="max-w-3xl mx-auto px-5 sm:px-6 py-12 sm:py-16">
      <article>
        <h1 className="font-display text-[30px] sm:text-[40px] font-extrabold tracking-[-0.02em] text-balance mb-4">
          {content.title}
        </h1>
        <p className="text-[17px] leading-relaxed text-text-2 text-pretty mb-8">{content.lede}</p>

        {/* The draft banner is a <strong> inside a role="note" rather than a
            styled div: somebody reading this with a screen reader has to hear
            that the document has no legal force, not just see an orange box. */}
        {content.banner ? (
          <div
            role="note"
            className="border border-orange bg-orange/10 rounded-xl px-4 py-3.5 mb-8"
          >
            <p className="text-sm text-text">
              <strong>{content.banner}</strong>
            </p>
          </div>
        ) : null}

        {content.sections.map((section) => (
          <section key={section.heading} className="mb-8">
            <h2 className="font-display text-[20px] sm:text-[24px] font-bold tracking-[-0.01em] mb-3 text-balance">
              {section.heading}
            </h2>
            {section.paragraphs.map((p) => (
              <p key={p.slice(0, 40)} className="text-[15px] leading-relaxed text-text-2 text-pretty mb-3">
                {p}
              </p>
            ))}
            {section.bullets ? (
              <ul className="list-disc pl-5 flex flex-col gap-2 mt-3">
                {section.bullets.map((b) => (
                  <li key={b.slice(0, 40)} className="text-[15px] leading-relaxed text-text-2 text-pretty">
                    {b}
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
        ))}

        {content.cta ? (
          <Link
            href={content.cta.href}
            className="inline-block px-7 py-3.5 rounded-xl bg-orange-dark text-white font-semibold hover:bg-orange-deep transition-colors"
          >
            {content.cta.label}
          </Link>
        ) : null}
      </article>
    </div>
  );
}
