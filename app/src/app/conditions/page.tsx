import type { Metadata } from 'next';
import { PublicArticle } from '@/components/PublicArticle';

export const metadata: Metadata = {
  title: "Conditions d'utilisation — TowConnect",
  description: "Le rôle d'intermédiaire de TowConnect, le prix, l'annulation et les zones réglementées. DRAFT — révision juridique requise.",
  alternates: { canonical: '/conditions' },
  openGraph: {
    title: "Conditions d'utilisation — TowConnect",
    description: "Le rôle d'intermédiaire de TowConnect, le prix, l'annulation et les zones réglementées. DRAFT — révision juridique requise.",
    type: 'website',
    url: '/conditions',
  },
};

export default function Page() {
  return (
    <>
      <PublicArticle page='terms' />
    </>
  );
}
