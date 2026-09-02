import type { Metadata } from 'next';
import { PublicArticle } from '@/components/PublicArticle';

export const metadata: Metadata = {
  title: 'Nous joindre — TowConnect',
  description: "Comment joindre TowConnect pendant une intervention, et ce qui n'existe pas encore. En cas de danger immédiat, appelez le 911.",
  alternates: { canonical: '/contact' },
  openGraph: {
    title: 'Nous joindre — TowConnect',
    description: "Comment joindre TowConnect pendant une intervention, et ce qui n'existe pas encore. En cas de danger immédiat, appelez le 911.",
    type: 'website',
    url: '/contact',
  },
};

export default function Page() {
  return (
    <>
      <PublicArticle page='contact' />
    </>
  );
}
