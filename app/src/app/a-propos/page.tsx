import type { Metadata } from 'next';
import { PublicArticle } from '@/components/PublicArticle';

export const metadata: Metadata = {
  title: 'À propos — TowConnect',
  description: 'TowConnect met en relation une personne immobilisée et une entreprise de remorquage indépendante, sur Montréal et la Rive-Sud. Ce que nous faisons, et ce que nous refusons de promettre.',
  alternates: { canonical: '/a-propos' },
  openGraph: {
    title: 'À propos — TowConnect',
    description: 'TowConnect met en relation une personne immobilisée et une entreprise de remorquage indépendante, sur Montréal et la Rive-Sud. Ce que nous faisons, et ce que nous refusons de promettre.',
    type: 'website',
    url: '/a-propos',
  },
};

// STRUCTURED DATA, AND WHAT IS DELIBERATELY MISSING FROM IT
// No aggregateRating, no review, no openingHours, no priceRange and no
// numeric areaServed geometry. Every one of those is a claim search engines
// will happily render as fact, and TowConnect cannot support any of them
// today: there are no reviews, no agreed hours and no verified boundary. What
// is left is what is true — who we are and which territory the pilot covers.

const organizationJsonLd = {
  '@context': 'https://schema.org',
  '@type': 'Organization',
  name: 'TowConnect',
  description:
    'Plateforme de mise en relation entre une personne immobilisée et une entreprise de remorquage indépendante.',
  areaServed: [
    { '@type': 'City', name: 'Montréal' },
    { '@type': 'Place', name: 'Rive-Sud de Montréal' },
  ],
};

export default function Page() {
  return (
    <>
      <script
        type="application/ld+json"
        // The object is built above from literals in this file, so there is
        // nothing user-supplied to inject here.
        dangerouslySetInnerHTML={{ __html: JSON.stringify(organizationJsonLd) }}
      />
      <PublicArticle page='about' />
    </>
  );
}
