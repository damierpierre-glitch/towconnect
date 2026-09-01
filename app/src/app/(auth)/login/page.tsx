'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { useLanguage } from '@/lib/i18n/LanguageProvider';
import { roleHome } from '@/lib/roleHome';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input, Label } from '@/components/ui/Field';
import { BrandMark } from '@/components/BrandMark';

export default function LoginPage() {
  const { t } = useLanguage();
  const router = useRouter();
  const supabase = createClient();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const { data, error: signInError } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (signInError || !data.user) {
      setError(t('error_generic'));
      setLoading(false);
      return;
    }

    const { data: profile } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', data.user.id)
      .single();

    router.push(roleHome(profile?.role ?? 'user'));
    router.refresh();
  }

  async function handleGoogle() {
    await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: `${window.location.origin}/auth/callback` },
    });
  }

  return (
    <div className="relative brand-aura">
      <div className="relative max-w-md mx-auto px-5 sm:px-6 py-12 sm:py-16">
        <div className="flex justify-center mb-7">
          <BrandMark size="md" />
        </div>
        <Card>
          <h1 className="font-display text-2xl font-bold mb-6">{t('login_title')}</h1>
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div>
              <Label>{t('login_email')}</Label>
              <Input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div>
              <Label>{t('login_password')}</Label>
              <Input
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            {error ? <p className="text-sm text-red">{error}</p> : null}
            <Button type="submit" full disabled={loading}>
              {t('login_submit')}
            </Button>
          </form>
          <div className="my-4 h-px bg-steel" />
          <Button type="button" variant="secondary" full onClick={handleGoogle}>
            {t('login_google')}
          </Button>
          <p className="text-sm text-text-2 mt-6 text-center">
            {t('login_no_account')}{' '}
            <Link href="/signup" className="text-orange font-medium">
              {t('nav_signup')}
            </Link>
          </p>
        </Card>
      </div>
    </div>
  );
}
