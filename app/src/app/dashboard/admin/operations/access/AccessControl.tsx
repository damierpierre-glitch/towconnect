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
// NO CAPABILITY MEANS NO CAPABILITY
// It did not always. 0041 shipped these roles with a grandfather rule — an
// admin holding no grant held everything — so that introducing them could not
// lock out the people running the platform. 0044 removed it, after granting
// super_admin explicitly to every administrator that existed.
//
// The rule that replaced it is the one worth knowing at this screen: revoking
// somebody's LAST capability now revokes their access, rather than handing
// them everything. That inversion is exactly why the old rule could not stay.

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
            ? 'Un administrateur ne détient que ce qui lui est attribué. Retirer sa dernière capacité lui retire réellement l’accès — il reste administrateur au sens du compte, mais ne peut plus rien faire de privilégié. Assurez-vous qu’il reste au moins un super administrateur : sans lui, plus personne ne peut attribuer de capacité.'
            : 'An administrator holds only what they are granted. Revoking their last capability genuinely revokes their access — the account stays an admin, but can do nothing privileged. Make sure at least one super administrator remains: without one, nobody can grant capabilities to anybody.'}
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
                    <Badge tone="red">
                      {lang === 'fr' ? 'aucun accès privilégié' : 'no privileged access'}
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
