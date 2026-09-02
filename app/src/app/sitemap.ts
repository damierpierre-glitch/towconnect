import type { MetadataRoute } from 'next';

// Only the pages a stranger should find.
//
// Nothing behind a login is listed, and nothing that would be misleading out
// of context — /track/[token] in particular is a bearer link, and a sitemap
// entry for it would be an invitation to guess.
const PUBLIC_ROUTES = [
  '',
  '/a-propos',
  '/comment-ca-marche',
  '/securite',
  '/contact',
  '/remorquage-montreal',
  '/remorquage-rive-sud',
  '/assistance-routiere-montreal',
  '/assistance-routiere-rive-sud',
  '/confidentialite',
  '/conditions',
  '/conditions-partenaires',
];

function siteUrl(): string {
  return (
    process.env.NEXT_PUBLIC_SITE_URL ??
    (process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
      : 'http://localhost:3000')
  );
}

export default function sitemap(): MetadataRoute.Sitemap {
  const base = siteUrl();
  // One date for the whole set, taken from the build. A per-page lastModified
  // would need a per-page fact nobody is recording, and inventing one is
  // exactly the kind of small lie this project keeps refusing to tell.
  const lastModified = new Date();

  return PUBLIC_ROUTES.map((route) => ({
    url: `${base}${route}`,
    lastModified,
    changeFrequency: 'monthly' as const,
    priority: route === '' ? 1 : 0.6,
  }));
}
