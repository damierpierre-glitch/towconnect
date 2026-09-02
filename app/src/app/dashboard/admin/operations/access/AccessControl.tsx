'use client';

import { useState } from 'react';
import { useLanguage } from '@/lib/i18n/LanguageProvider';
import { useToast } from '@/components/ToastProvider';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { grantCapability, revokeCapability, type AdminAccount } from '@/lib/actions/operations';
import { OperationsNav, type Capabilities } from '../OperationsNav';
import type { AdminCapability } from '@/lib/supabase/types';

// Who may do what.
//
// THE GRANDFATHER RULE IS THE POINT OF THIS SCREEN
// Every existing administrator can do everything today. If "no grant" had
// meant "no access", this feature would have locked the platform's operators
// out of it the moment it shipped. So an account with no grants keeps full
// access, and narrowing somebody is a deliberate act performed here — which
// is also why the first grant is the one that changes their world.

const CAPABILITIES: { key: AdminCapability; fr: string; en: string; blurb: { fr: string; en: string } }[] = [
  {
    key: 'super_admin',
    fr: 'Super admin',
    en: 'Super admin',
    blurb: { fr: 'Tout, y compris cet écran.', en: 'Everything, including this screen.' },
  },
  {
    key: 'operations',
    fr: 'Opérations',
    en: 'Operations',
    blurb: {
      fr: 'Répartition, chauffeurs, documents, zones, incidents. Ne peut pas activer une commission.',
      en: 'Dispatch, drivers, documents, zones, incidents. Cannot activate a commission.',
    },
  },
  {
    key: 'finance',
    fr: 'Finance',
    en: 'Finance',
    blurb: {
      fr: 'Remboursements, versements, configuration économique. Ne peut pas modifier une zone réglementée.',
      en: 'Refunds, payouts, economic configuration. Cannot modify a regulated zone.',
    },
  },
  {
    key: 'support',
    fr: 'Support',
    en: 'Support',
    blurb: {
      fr: 'Recherche et consultation. Ne déplace aucun argent.',
      en: 'Lookup and read-only. Moves no money.',
    },
  },
];

export function AccessControl({
  capabilities,
  accounts,
}: {
  capabilities: Capabilities;
  accounts: AdminAccount[];
}) {
  const { lang } = useLanguage();
  const { showToast } = useToast();
  const [busy, setBusy] = useState(false);

  async function run(fn: () => Promise<unknown>, done: string) {
    setBusy(true);
    try {
      await fn();
      showToast('✅', done);
    } catch (e) {
      showToast('⚠️', e instanceof Error ? e.message : 'Error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-8">
      <header className="mb-5">
        <h1 className="font-display text-2xl font-bold">{lang === 'fr' ? 'Accès' : 'Access'}</h1>
        <p className="text-sm text-muted mt-1">
          {lang === 'fr'
            ? 'Qui peut faire quoi. Les refus sont appliqués par la base, pas par cet écran.'
            : 'Who may do what. The refusals are enforced by the database, not by this screen.'}
        </p>
      </header>

      <OperationsNav capabilities={capabilities} />

      <Card className="mb-4 !bg-night-3">
        <h2 className="font-display text-sm font-bold mb-2">
          {lang === 'fr' ? 'Comment cela fonctionne' : 'How this works'}
        </h2>
        <p className="text-xs text-text-2">
          {lang === 'fr'
            ? 'Un administrateur sans aucune capacité attribuée conserve l’accès complet — c’est ce qui a permis d’introduire ces rôles sans verrouiller personne. Dès qu’une première capacité lui est donnée, il est restreint à ce qu’il détient. Retirer sa dernière capacité lui rend donc l’accès complet : c’est délibéré, mais cela surprend, alors sachez-le.'
            : 'An administrator with no capabilities assigned keeps full access — that is what allowed these roles to be introduced without locking anybody out. The moment they are given their first capability, they are restricted to what they hold. Removing their last capability therefore restores full access: that is deliberate, but it surprises people, so it is worth knowing.'}
        </p>
      </Card>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-5">
        {CAPABILITIES.map((c) => (
          <div key={c.key} className="bg-night-3 border border-steel rounded-xl p-3.5">
            <div className="text-sm font-semibold">{lang === 'fr' ? c.fr : c.en}</div>
            <div className="text-xs text-muted mt-1">{c.blurb[lang === 'fr' ? 'fr' : 'en']}</div>
          </div>
        ))}
      </div>

      <Card>
        <h2 className="font-display text-base font-bold mb-4">
          {lang === 'fr' ? 'Comptes administrateurs' : 'Administrator accounts'}
        </h2>
        {accounts.length === 0 ? (
          <p className="text-sm text-muted">
            {lang === 'fr' ? 'Aucun compte administrateur.' : 'No administrator accounts.'}
          </p>
        ) : (
          <div className="flex flex-col gap-4">
            {accounts.map((account) => (
              <div key={account.id} className="py-3 border-b border-steel/40 last:border-none">
                <div className="flex items-center justify-between gap-3 flex-wrap mb-2">
                  <span className="text-sm font-medium">{account.name}</span>
                  {account.capabilities.length === 0 ? (
                    <Badge tone="yellow">
                      {lang === 'fr' ? 'accès complet (non restreint)' : 'full access (unscoped)'}
                    </Badge>
                  ) : (
                    <span className="flex gap-1.5 flex-wrap">
                      {account.capabilities.map((c) => (
                        <Badge key={c} tone="green" dot={false}>
                          {c}
                        </Badge>
                      ))}
                    </span>
                  )}
                </div>
                <div className="flex gap-2 flex-wrap">
                  {CAPABILITIES.map((c) => {
                    const held = account.capabilities.includes(c.key);
                    return (
                      <Button
                        key={c.key}
                        variant={held ? 'secondary' : 'primary'}
                        className="!px-2.5 !py-1 !text-xs"
                        disabled={busy}
                        onClick={() =>
                          run(
                            () =>
                              held
                                ? revokeCapability(account.id, c.key)
                                : grantCapability(account.id, c.key),
                            held
                              ? lang === 'fr'
                                ? 'Capacité retirée.'
                                : 'Capability revoked.'
                              : lang === 'fr'
                                ? 'Capacité accordée.'
                                : 'Capability granted.'
                          )
                        }
                      >
                        {held ? '− ' : '+ '}
                        {c.key}
                      </Button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
