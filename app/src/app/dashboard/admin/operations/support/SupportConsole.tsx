'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useLanguage } from '@/lib/i18n/LanguageProvider';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Input, Label } from '@/components/ui/Field';
import { formatDateTime } from '@/lib/formatDate';
import { supportSearch, type SupportHit } from '@/lib/actions/operations';
import { OperationsNav, type Capabilities } from '../OperationsNav';

// Support lookup.
//
// FIND IT THE WAY SOMEBODY IS ASKED FOR IT
// A caller has whatever they have: a booking reference, the email they signed
// up with, the phone in their hand, or a line from their bank statement. The
// search takes all four and says which one matched, so the agent knows what
// they have actually confirmed about the person on the phone.
//
// Support can look. It cannot refund, cannot pay out, and cannot change a
// zone — the database refuses those regardless of what this screen shows.
export function SupportConsole({ capabilities }: { capabilities: Capabilities }) {
  const { lang } = useLanguage();
  const [term, setTerm] = useState('');
  const [hits, setHits] = useState<SupportHit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function search() {
    setBusy(true);
    setError(null);
    try {
      setHits(await supportSearch(term));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Search failed');
      setHits(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-8">
      <header className="mb-5">
        <h1 className="font-display text-2xl font-bold">{lang === 'fr' ? 'Support' : 'Support'}</h1>
        <p className="text-sm text-muted mt-1">
          {lang === 'fr'
            ? 'Retrouver une intervention à partir de ce que le client a sous la main.'
            : 'Find a job from whatever the customer has to hand.'}
        </p>
      </header>

      <OperationsNav capabilities={capabilities} />

      <Card className="mb-4">
        <Label>
          {lang === 'fr'
            ? 'Numéro de demande, courriel, téléphone ou référence de paiement'
            : 'Request id, email, phone number or payment reference'}
        </Label>
        <div className="flex gap-2 flex-wrap">
          <Input
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void search();
            }}
            placeholder={lang === 'fr' ? 'ex. pi_3Nx… ou client@exemple.com' : 'e.g. pi_3Nx… or customer@example.com'}
            className="flex-1 min-w-[240px]"
          />
          <Button disabled={busy || !term.trim()} onClick={search}>
            {lang === 'fr' ? 'Chercher' : 'Search'}
          </Button>
        </div>
        <p className="text-xs text-muted mt-3">
          {lang === 'fr'
            ? 'Chaque résultat indique par quel identifiant il a été trouvé — utile pour savoir ce que vous avez réellement confirmé.'
            : 'Each result says which identifier matched it — useful for knowing what you have actually confirmed.'}
        </p>
      </Card>

      {error ? (
        <Card className="mb-4 border-red">
          <p className="text-sm text-red">{error}</p>
        </Card>
      ) : null}

      {hits !== null ? (
        <Card>
          {hits.length === 0 ? (
            <p className="text-sm text-muted">
              {lang === 'fr'
                ? 'Rien ne correspond. Un identifiant valide sans résultat signifie qu’aucune intervention n’y est rattachée.'
                : 'Nothing matched. A valid identifier with no result means no job is attached to it.'}
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {hits.map((hit) => (
                <div
                  key={hit.requestId}
                  className="flex items-center justify-between gap-3 py-2.5 border-b border-steel/40 last:border-none flex-wrap"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium">{hit.customerName ?? '—'}</span>
                      <Badge tone="blue" dot={false}>
                        {hit.status}
                      </Badge>
                      <span className="text-[10px] uppercase tracking-wide text-muted border border-steel rounded px-1.5 py-0.5">
                        {hit.matchedVia}
                      </span>
                    </div>
                    <div className="text-xs text-muted mt-1 truncate">
                      {hit.locationText} · {formatDateTime(hit.createdAt)}
                    </div>
                  </div>
                  {capabilities.operations ? (
                    <Link
                      href={`/dashboard/admin/operations/jobs/${hit.requestId}`}
                      className="text-xs text-orange font-medium shrink-0"
                    >
                      {lang === 'fr' ? 'Chronologie →' : 'Timeline →'}
                    </Link>
                  ) : (
                    <span className="text-xs text-muted font-mono shrink-0">
                      #{hit.requestId.slice(0, 8)}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </Card>
      ) : null}

      {!capabilities.operations ? (
        <p className="text-xs text-muted mt-4">
          {lang === 'fr'
            ? 'Votre compte a la capacité « support » : consultation seulement. Les remboursements, les versements et les zones réglementées sont refusés par la base, pas seulement masqués ici.'
            : 'Your account holds the “support” capability: lookup only. Refunds, payouts and regulated zones are refused by the database, not merely hidden here.'}
        </p>
      ) : null}
    </div>
  );
}
