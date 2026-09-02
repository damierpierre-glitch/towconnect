import type { Metadata } from 'next';
import { viewSafetyLink } from '@/lib/actions/safety';
import { SafetyLinkTracker } from './SafetyLinkTracker';

// The public Safety Link page.
//
// The only route in TowConnect readable without an account. Everything it can
// show comes from safety_link_view() (0046), which selects a fixed list of
// fields — so this page cannot leak something simply because a developer
// widened a query later.

export const metadata: Metadata = {
  title: 'Suivi TowConnect',
  // A shared link must not end up in a search index, and its preview must not
  // repeat what the page says.
  robots: { index: false, follow: false, nocache: true },
};

export default async function SafetyLinkPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const view = await viewSafetyLink(token);
  return <SafetyLinkTracker view={view} />;
}
