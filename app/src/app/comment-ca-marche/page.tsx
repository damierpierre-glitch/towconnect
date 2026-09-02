import type { Metadata } from 'next';
import { PublicArticle } from '@/components/PublicArticle';

export const metadata: Metadata = {
  title: 'Comment ça marche — TowConnect',
  description: "Décrire la panne, voir le prix avant de confirmer, être assigné automatiquement, suivre l'arrivée. Quatre étapes, sans appel obligatoire.",
  alternates: { canonical: '/comment-ca-marche' },
  openGraph: {
    title: 'Comment ça marche — TowConnect',
    description: "Décrire la panne, voir le prix avant de confirmer, être assigné automatiquement, suivre l'arrivée. Quatre étapes, sans appel obligatoire.",
    type: 'website',
    url: '/comment-ca-marche',
  },
};

export default function Page() {
  return (
    <>
      <PublicArticle page='how' />
    </>
  );
}
