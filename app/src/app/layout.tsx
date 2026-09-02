import type { Metadata, Viewport } from 'next';
import { Syne, DM_Sans } from 'next/font/google';
import './globals.css';
import { LanguageProvider } from '@/lib/i18n/LanguageProvider';
import { ToastProvider } from '@/components/ToastProvider';
import { NavBar } from '@/components/NavBar';
import { SiteFooter } from '@/components/SiteFooter';
import { createClient } from '@/lib/supabase/server';

const syne = Syne({
  variable: '--font-syne',
  subsets: ['latin'],
  weight: ['400', '600', '700', '800'],
});

const dmSans = DM_Sans({
  variable: '--font-dm-sans',
  subsets: ['latin'],
  weight: ['300', '400', '500', '600'],
});

// A share card needs absolute URLs. VERCEL_PROJECT_PRODUCTION_URL is set by
// Vercel on every deployment; the fallback only matters for local runs, where
// nothing is scraping the page anyway.
const siteUrl =
  process.env.NEXT_PUBLIC_SITE_URL ??
  (process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : 'http://localhost:3000');

// The previous copy here promised the whole country. The launch area is
// Montréal and the South Shore, and the metadata is the first thing a search
// engine or a link preview quotes back at people — so it says that instead.
// The card image itself comes from src/app/opengraph-image.jpg by convention.
export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: 'TowConnect — Remorquage à la demande | Montréal & Rive-Sud',
  description:
    'TowConnect vous connecte rapidement à un remorqueur disponible dans la région de Montréal et la Rive-Sud, avec un prix affiché avant confirmation et un suivi en direct.',
  applicationName: 'TowConnect',
  openGraph: {
    title: 'TowConnect — Remorquage à la demande',
    description:
      'Un remorqueur disponible à Montréal et sur la Rive-Sud, prix affiché avant confirmation, suivi en direct.',
    siteName: 'TowConnect',
    locale: 'fr_CA',
    type: 'website',
    url: siteUrl,
  },
  twitter: {
    card: 'summary_large_image',
    title: 'TowConnect — Remorquage à la demande',
    description:
      'Un remorqueur disponible à Montréal et sur la Rive-Sud, prix affiché avant confirmation, suivi en direct.',
  },
};

export const viewport: Viewport = {
  themeColor: '#0d0d0d',
};

export default async function RootLayout({ children }: LayoutProps<'/'>) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  let role: 'user' | 'driver' | 'admin' | null = null;
  // Business access is a company membership, not a fourth user_role — see
  // dashboard/business/page.tsx. The bar only needs to know whether there is
  // one, so it can offer the link.
  let hasCompany = false;
  if (user) {
    const { data: profile } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single();
    role = profile?.role ?? null;

    const { data: membership } = await supabase
      .from('company_members')
      .select('id')
      .eq('profile_id', user.id)
      .eq('status', 'active')
      .limit(1)
      .maybeSingle();
    hasCompany = Boolean(membership);
  }

  return (
    <html lang="fr" className={`${syne.variable} ${dmSans.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col bg-night text-text">
        <LanguageProvider>
          <ToastProvider>
            <NavBar role={role} hasCompany={hasCompany} />
            <main className="flex-1">{children}</main>
            {/* Marketing chrome, so it stops at the signed-in surfaces: a
                driver mid-mission does not need a footer under the map. */}
            {role === null ? <SiteFooter /> : null}
          </ToastProvider>
        </LanguageProvider>
      </body>
    </html>
  );
}
