import type { Metadata } from 'next';
import { PublicArticle } from '@/components/PublicArticle';

export const metadata: Metadata = {
  title: 'Conditions partenaires — TowConnect',
  description: "Ce qu'une entreprise de remorquage peut attendre de TowConnect. DRAFT — révision juridique requise.",
  alternates: { canonical: '/conditions-partenaires' },
  openGraph: {
    title: 'Conditions partenaires — TowConnect',
    description: "Ce qu'une entreprise de remorquage peut attendre de TowConnect. DRAFT — révision juridique requise.",
    type: 'website',
    url: '/conditions-partenaires',
  },
};

export default function Page() {
  return (
    <>
      <PublicArticle page='partner-terms' />
    </>
  );
}
