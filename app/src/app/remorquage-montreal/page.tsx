import type { Metadata } from 'next';
import { PublicArticle } from '@/components/PublicArticle';

export const metadata: Metadata = {
  title: 'Remorquage Montréal — TowConnect',
  description: "Demander un remorquage sur l'île de Montréal, avec le prix affiché avant confirmation et un suivi en direct. Phase pilote.",
  alternates: { canonical: '/remorquage-montreal' },
  openGraph: {
    title: 'Remorquage Montréal — TowConnect',
    description: "Demander un remorquage sur l'île de Montréal, avec le prix affiché avant confirmation et un suivi en direct. Phase pilote.",
    type: 'website',
    url: '/remorquage-montreal',
  },
};

// STRUCTURED DATA, AND WHAT IS DELIBERATELY MISSING FROM IT
// No aggregateRating, no review, no openingHours, no priceRange and no
// numeric areaServed geometry. Every one of those is a claim search engines
// will happily render as fact, and TowConnect cannot support any of them
// today: there are no reviews, no agreed hours and no verified boundary. What
// is left is what is true — who we are and which territory the pilot covers.

const serviceJsonLd = {
  '@context': 'https://schema.org',
  '@type': 'Service',
  name: 'Remorquage',
  serviceType: 'Remorquage',
  provider: { '@type': 'Organization', name: 'TowConnect' },
  areaServed: { '@type': 'Place', name: 'Montréal, Québec' },
};

export default function Page() {
  return (
    <>
      <script
        type="application/ld+json"
        // The object is built above from literals in this file, so there is
        // nothing user-supplied to inject here.
        dangerouslySetInnerHTML={{ __html: JSON.stringify(serviceJsonLd) }}
      />
      <PublicArticle page='towing-montreal' />
    </>
  );
}
