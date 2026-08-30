import type { Metadata } from 'next';
import { Syne, DM_Sans } from 'next/font/google';
import './globals.css';
import { LanguageProvider } from '@/lib/i18n/LanguageProvider';
import { ToastProvider } from '@/components/ToastProvider';
import { NavBar } from '@/components/NavBar';
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

export const metadata: Metadata = {
  title: 'TowConnect — Remorquage instantané au Canada',
  description:
    'TowConnect connecte les automobilistes en panne au remorqueur le plus proche, avec prix transparent, partout au Canada.',
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
          </ToastProvider>
        </LanguageProvider>
      </body>
    </html>
  );
}
