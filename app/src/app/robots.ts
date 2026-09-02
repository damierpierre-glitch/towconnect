import type { MetadataRoute } from 'next';

// What a crawler may look at.
//
// The disallow list is not about secrecy — every one of these paths is
// already protected by row-level security, and /track/ needs a token nobody
// can guess. It is about not putting personal situations into a search index:
// a tracking link, a receipt or an operations console has no business being
// crawled, indexed, cached and surfaced to somebody who was never given it.
export default function robots(): MetadataRoute.Robots {
  const base =
    process.env.NEXT_PUBLIC_SITE_URL ??
    (process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
      : 'http://localhost:3000');

  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: [
          '/dashboard/',
          '/request',
          '/history',
          '/vehicles',
          '/payment-methods',
          '/notifications',
          '/track/',
          '/auth/',
          '/api/',
        ],
      },
    ],
    sitemap: `${base}/sitemap.xml`,
  };
}
