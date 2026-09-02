import type { Metadata } from 'next';
import { PublicArticle } from '@/components/PublicArticle';

export const metadata: Metadata = {
  title: 'Politique de confidentialité — TowConnect',
  description: "Ce que TowConnect enregistre, ce qu'il n'enregistre pas, et qui peut le voir. DRAFT — révision juridique requise.",
  alternates: { canonical: '/confidentialite' },
  openGraph: {
    title: 'Politique de confidentialité — TowConnect',
    description: "Ce que TowConnect enregistre, ce qu'il n'enregistre pas, et qui peut le voir. DRAFT — révision juridique requise.",
    type: 'website',
    url: '/confidentialite',
  },
};

export default function Page() {
  return (
    <>
      <PublicArticle page='privacy' />
    </>
  );
}
