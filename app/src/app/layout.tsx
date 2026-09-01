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

// The previous copy here promised the whole country. The launch area is
// Montréal and the South Shore, and the metadata is the first thing a search
// engine or a link preview quotes back at people — so it says that instead.
export const metadata: Metadata = {
  title: 'TowConnect — Remorquage à la demande | Montréal & Rive-Sud',
  description:
    'TowConnect vous connecte rapidement à un remorqueur disponible dans la région de Montréal et la Rive-Sud, avec un prix affiché avant confirmation et un suivi en direct.',
  openGraph: {
    title: 'TowConnect — Remorquage à la demande',
    description:
      'Un remorqueur disponible à Montréal et sur la Rive-Sud, prix affiché avant confirmation, suivi en direct.',
    siteName: 'TowConnect',
    locale: 'fr_CA',
    type: 'website',
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
  if (user) {
    const { data: profile } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single();
    role = profile?.role ?? null;
  }

  return (
    <html lang="fr" className={`${syne.variable} ${dmSans.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col bg-night text-text">
        <LanguageProvider>
          <ToastProvider>
            <NavBar role={role} />
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
