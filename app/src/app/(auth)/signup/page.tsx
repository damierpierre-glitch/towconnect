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
import type { UserRole } from '@/lib/supabase/types';
import { BrandMark } from '@/components/BrandMark';
import { track } from '@/lib/analytics';

export default function SignupPage() {
  const { t, lang } = useLanguage();
  const router = useRouter();
  const supabase = createClient();
  const [role, setRole] = useState<Extract<UserRole, 'user' | 'driver'>>('user');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [confirmEmail, setConfirmEmail] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    track('signup_started', { source: role });

    const { data, error: signUpError } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { role, full_name: fullName } },
    });

    if (signUpError) {
      // Names the two things that actually go wrong here, without confirming
      // whether the address is already registered.
      setError(t('err_signup_failed'));
      setLoading(false);
      return;
    }

    if (!data.session) {
      // Email confirmation is required before a session is issued.
      setConfirmEmail(true);
      setLoading(false);
      return;
    }

    track('auth_completed', { source: 'signup' });
    router.push(roleHome(role));
    router.refresh();
  }

  async function handleGoogle() {
    track('signup_started', { source: 'google' });
    await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: `${window.location.origin}/auth/callback` },
    });
  }

  if (confirmEmail) {
    return (
      <div className="relative brand-aura">
        <div className="relative max-w-md mx-auto px-5 sm:px-6 py-12 sm:py-16">
          <div className="flex justify-center mb-7">
            <BrandMark size="md" />
          </div>
          <Card className="text-center">
            <div className="text-4xl mb-3">📬</div>
            <p className="text-text-2">
              {lang === 'en'
                ? 'Check your inbox to confirm your email, then log in.'
                : 'Vérifiez votre boîte courriel pour confirmer votre compte, puis connectez-vous.'}
            </p>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="relative brand-aura">
      <div className="relative max-w-md mx-auto px-5 sm:px-6 py-12 sm:py-16">
        <div className="flex justify-center mb-7">
          <BrandMark size="md" />
        </div>
        <Card>
          <h1 className="font-display text-2xl font-bold mb-6">{t('signup_title')}</h1>
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            {/* Two buttons acting as one choice, so the group is named and
                each button reports whether it is the chosen one — until now
                that was conveyed by colour alone. */}
            <div role="group" aria-labelledby="signup-role-label">
              <Label id="signup-role-label">{t('signup_role')}</Label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  aria-pressed={role === 'user'}
                  onClick={() => setRole('user')}
                  className={`px-3 py-3 rounded-xl border text-sm font-medium transition-colors ${
                    role === 'user' ? 'border-orange bg-orange/10 text-orange' : 'border-steel text-text-2'
                  }`}
                >
                  👤 {t('signup_role_user')}
                </button>
                <button
                  type="button"
                  aria-pressed={role === 'driver'}
                  onClick={() => setRole('driver')}
                  className={`px-3 py-3 rounded-xl border text-sm font-medium transition-colors ${
                    role === 'driver' ? 'border-orange bg-orange/10 text-orange' : 'border-steel text-text-2'
                  }`}
                >
                  🚛 {t('signup_role_driver')}
                </button>
              </div>
            </div>
            <div>
              <Label htmlFor="signup-name">{t('signup_name')}</Label>
              <Input
                id="signup-name"
                autoComplete="name"
                required
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="signup-email">{t('login_email')}</Label>
              <Input
                id="signup-email"
                autoComplete="email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="signup-password">{t('login_password')}</Label>
              <Input
                id="signup-password"
                autoComplete="new-password"
                type="password"
                required
                minLength={6}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            {error ? (
              <p role="alert" className="text-sm text-red">
                {error}
              </p>
            ) : null}
            <Button type="submit" full disabled={loading}>
              {t('signup_submit')}
            </Button>
          </form>
          <div className="my-4 h-px bg-steel" />
          <Button type="button" variant="secondary" full onClick={handleGoogle}>
            {t('login_google')}
          </Button>
          <p className="text-sm text-text-2 mt-6 text-center">
            {t('signup_have_account')}{' '}
            <Link href="/login" className="text-orange font-medium">
              {t('nav_login')}
            </Link>
          </p>
        </Card>
      </div>
    </div>
  );
}
