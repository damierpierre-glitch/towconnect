import type { Metadata } from 'next';
import { PublicArticle } from '@/components/PublicArticle';

export const metadata: Metadata = {
  title: 'Sécurité — TowConnect',
  description: "Se mettre en sécurité au bord de la route, partager un lien de suivi, vérifier qui vient vous chercher, et pourquoi aucun délai n'est inventé.",
  alternates: { canonical: '/securite' },
  openGraph: {
    title: 'Sécurité — TowConnect',
    description: "Se mettre en sécurité au bord de la route, partager un lien de suivi, vérifier qui vient vous chercher, et pourquoi aucun délai n'est inventé.",
    type: 'website',
    url: '/securite',
  },
};

export default function Page() {
  return (
    <>
      <PublicArticle page='safety' />
    </>
  );
}
