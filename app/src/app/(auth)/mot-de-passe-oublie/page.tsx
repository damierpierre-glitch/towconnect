'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useLanguage } from '@/lib/i18n/LanguageProvider';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input, Label } from '@/components/ui/Field';
import { BrandMark } from '@/components/BrandMark';
import { requestPasswordReset } from '@/lib/actions/auth';

// "I have forgotten my password."
//
// THE SCREEN SAYS THE SAME THING EITHER WAY
// Whatever the address is — registered, mistyped, or somebody else's — the
// result is one sentence: if an account exists, a link is on its way. A form
// that distinguishes the cases is a form that answers "does this person have a
// TowConnect account?" for anybody who asks, at whatever rate they like.
//
// That is why there is no error state here at all, and why the button is
// disabled while submitting rather than reporting what happened.
export default function ForgotPasswordPage() {
  const { t } = useLanguage();
  const [email, setEmail] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSending(true);
    try {
      await requestPasswordReset(email);
    } finally {
      // Shown whatever happened, including a failure. The person is told what
      // to do next; the detail goes to the server log.
      setSent(true);
      setSending(false);
    }
  }

  return (
    <div className="relative brand-aura">
      <div className="relative max-w-md mx-auto px-5 sm:px-6 py-12 sm:py-16">
        <div className="flex justify-center mb-7">
          <BrandMark size="md" />
        </div>

        <Card>
          <h1 className="font-display text-xl font-bold mb-1">{t('forgot_title')}</h1>

          {sent ? (
            <div role="status">
              <p className="text-sm text-text-2 mt-3">{t('forgot_sent')}</p>
              <p className="text-sm text-muted mt-3">{t('forgot_sent_hint')}</p>
              <Link
                href="/login"
                className="inline-block mt-6 text-sm text-orange font-semibold hover:text-orange-light transition-colors"
              >
                ← {t('nav_login')}
              </Link>
            </div>
          ) : (
            <>
              <p className="text-sm text-text-2 mb-6">{t('forgot_sub')}</p>
              <form onSubmit={handleSubmit} className="flex flex-col gap-4">
                <div>
                  <Label htmlFor="forgot-email">{t('login_email')}</Label>
                  <Input
                    id="forgot-email"
                    type="email"
                    autoComplete="email"
                    required
                    autoFocus
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </div>
                <Button type="submit" full disabled={sending}>
                  {sending ? '…' : t('forgot_submit')}
                </Button>
              </form>
              <p className="text-sm text-text-2 mt-6 text-center">
                <Link href="/login" className="text-orange font-medium">
                  ← {t('nav_login')}
                </Link>
              </p>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}
