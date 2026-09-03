'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { useLanguage } from '@/lib/i18n/LanguageProvider';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input, Label } from '@/components/ui/Field';
import { BrandMark } from '@/components/BrandMark';
import { updatePassword } from '@/lib/actions/auth';
import { roleHome } from '@/lib/roleHome';

// Where a recovery link lands.
//
// The link points straight here rather than through /auth/callback, because
// Supabase returns a recovery session either as `?code=` or as tokens in the
// URL fragment — and a fragment never reaches a server, so a route handler in
// the middle would bounce somebody holding a perfectly valid link. The browser
// client consumes both shapes on load.
//
// THERE IS NO TOKEN ON THIS PAGE
// The recovery link created a session — that is what proves the person owns
// the address — so setting the password is an ordinary authenticated action.
// Nothing here parses a token, which means nothing here can validate one
// wrongly. Somebody who opens this page without having followed a link has no
// session and is told to start over rather than shown a form that cannot work.
export default function NewPasswordPage() {
  const { t } = useLanguage();
  const router = useRouter();
  const [checking, setChecking] = useState(true);
  const [hasSession, setHasSession] = useState(false);
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);

  // The recovery link arrives either as `?code=` or with tokens in the
  // fragment, and the browser client consumes both — but not synchronously.
  // Asking once and declaring the link dead would fail the flow for anybody
  // whose network is slow, so this waits for the client to tell us.
  useEffect(() => {
    const supabase = createClient();
    let settled = false;

    const { data: subscription } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session?.user) {
        settled = true;
        setHasSession(true);
        setChecking(false);
      }
    });

    supabase.auth.getUser().then(({ data }) => {
      if (data.user) {
        settled = true;
        setHasSession(true);
        setChecking(false);
      }
    });

    // Nothing arrived. Say the link is spent rather than showing a form that
    // cannot work.
    const giveUp = setTimeout(() => {
      if (!settled) setChecking(false);
    }, 4000);

    return () => {
      subscription.subscription.unsubscribe();
      clearTimeout(giveUp);
    };
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (password !== confirmation) {
      setError(t('reset_mismatch'));
      return;
    }
    if (password.length < 8) {
      setError(t('reset_too_short'));
      return;
    }

    setSaving(true);
    const result = await updatePassword(password);
    setSaving(false);

    if (!result.ok) {
      setError(
        result.reason === 'too_short'
          ? t('reset_too_short')
          : result.reason === 'unchanged'
            ? t('reset_unchanged')
            : result.reason === 'no_session'
              ? t('reset_link_expired')
              : t('error_generic')
      );
      return;
    }

    setDone(true);
    // The session created by the recovery link is a real one, so they are
    // already signed in with the new password. Sending them to their own home
    // rather than back to the login form avoids asking somebody who just
    // proved who they are to prove it again.
    const supabase = createClient();
    const { data } = await supabase.auth.getUser();
    const { data: profile } = data.user
      ? await supabase.from('profiles').select('role').eq('id', data.user.id).maybeSingle()
      : { data: null };
    setTimeout(() => {
      router.push(roleHome(profile?.role ?? 'user'));
      router.refresh();
    }, 1200);
  }

  return (
    <div className="relative brand-aura">
      <div className="relative max-w-md mx-auto px-5 sm:px-6 py-12 sm:py-16">
        <div className="flex justify-center mb-7">
          <BrandMark size="md" />
        </div>

        <Card>
          <h1 className="font-display text-xl font-bold mb-1">{t('reset_title')}</h1>

          {checking ? (
            <p className="text-sm text-muted mt-3">…</p>
          ) : done ? (
            <p role="status" className="text-sm text-text-2 mt-3">
              {t('reset_done')}
            </p>
          ) : !hasSession ? (
            <div role="status">
              <p className="text-sm text-text-2 mt-3">{t('reset_link_expired')}</p>
              <Link
                href="/mot-de-passe-oublie"
                className="inline-block mt-6 text-sm text-orange font-semibold hover:text-orange-light transition-colors"
              >
                {t('forgot_submit')} →
              </Link>
            </div>
          ) : (
            <>
              <p className="text-sm text-text-2 mb-6">{t('reset_sub')}</p>
              <form onSubmit={handleSubmit} className="flex flex-col gap-4">
                <div>
                  <Label htmlFor="reset-password">{t('reset_new')}</Label>
                  <Input
                    id="reset-password"
                    type="password"
                    autoComplete="new-password"
                    required
                    minLength={8}
                    autoFocus
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </div>
                <div>
                  <Label htmlFor="reset-confirm">{t('reset_confirm')}</Label>
                  <Input
                    id="reset-confirm"
                    type="password"
                    autoComplete="new-password"
                    required
                    minLength={8}
                    value={confirmation}
                    onChange={(e) => setConfirmation(e.target.value)}
                  />
                </div>
                {error ? (
                  <p role="alert" className="text-sm text-red">
                    {error}
                  </p>
                ) : null}
                <Button type="submit" full disabled={saving}>
                  {saving ? '…' : t('reset_submit')}
                </Button>
              </form>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}
