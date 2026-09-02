'use client';

import { useCallback, useEffect, useState } from 'react';
import { useLanguage } from '@/lib/i18n/LanguageProvider';
import { useToast } from '@/components/ToastProvider';
import { Button } from '@/components/ui/Button';
import { createSafetyLink, getSafetyLinkStatus, revokeSafetyLink } from '@/lib/actions/safety';
import type { SafetyLink } from '@/lib/supabase/types';
import { errorMessageKey } from '@/lib/errors';

// "Let somebody know where I am."
//
// THE TOKEN IS SHOWN ONCE
// It is never stored in plaintext, so it genuinely cannot be shown again —
// the screen says so rather than hiding a Copy button that would fail. If
// somebody loses the link, they generate a new one, and the old one dies.
export function SafetyLinkPanel({ requestId }: { requestId: string }) {
  const { lang, t } = useLanguage();
  const { showToast } = useToast();
  const [link, setLink] = useState<SafetyLink | null>(null);
  const [freshUrl, setFreshUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setLink(await getSafetyLinkStatus(requestId));
    } catch {
      setLink(null);
    }
  }, [requestId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  async function generate() {
    setBusy(true);
    try {
      const created = await createSafetyLink(requestId);
      const url = `${window.location.origin}/track/${created.token}`;
      setFreshUrl(url);
      await load();
      try {
        await navigator.clipboard.writeText(url);
        showToast('🔗', lang === 'fr' ? 'Lien copié.' : 'Link copied.');
      } catch {
        // Clipboard access is not always granted; the URL is on screen anyway.
      }
    } catch (e) {
      showToast('⚠️', t(errorMessageKey(e)));
    } finally {
      setBusy(false);
    }
  }

  async function revoke() {
    setBusy(true);
    try {
      await revokeSafetyLink(requestId);
      setFreshUrl(null);
      await load();
      showToast('✅', lang === 'fr' ? 'Lien désactivé.' : 'Link turned off.');
    } catch (e) {
      showToast('⚠️', t(errorMessageKey(e)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border-t border-night-4 pt-4 mt-4">
      <h4 className="font-display font-bold text-sm mb-1">
        {lang === 'fr' ? 'Partager mon suivi' : 'Share my tracking'}
      </h4>
      <p className="text-xs text-muted mb-3">
        {lang === 'fr'
          ? 'Envoyez un lien à une personne de confiance. Elle voit votre position, l’avancement et qui intervient — jamais vos coordonnées, vos prix ni votre historique. Aucun compte requis.'
          : 'Send a link to somebody you trust. They see your location, the progress and who is coming — never your contact details, your prices or your history. No account needed.'}
      </p>

      {freshUrl ? (
        <div className="bg-night-3 border border-orange rounded-xl p-3.5 mb-3">
          <p className="text-[11px] uppercase tracking-wide text-orange mb-1.5">
            {lang === 'fr' ? 'Copiez-le maintenant' : 'Copy it now'}
          </p>
          <p className="text-xs font-mono break-all text-text-2">{freshUrl}</p>
          <p className="text-[11px] text-muted mt-2">
            {lang === 'fr'
              ? 'Ce lien ne sera plus affiché : il n’est pas conservé chez TowConnect. Si vous le perdez, générez-en un nouveau.'
              : 'This link will not be shown again — TowConnect does not keep it. If you lose it, generate a new one.'}
          </p>
        </div>
      ) : null}

      <div className="flex gap-2 flex-wrap items-center">
        <Button size="md" disabled={busy} onClick={generate}>
          {link
            ? lang === 'fr'
              ? 'Générer un nouveau lien'
              : 'Generate a new link'
            : lang === 'fr'
              ? 'Créer un lien de suivi'
              : 'Create a tracking link'}
        </Button>
        {link ? (
          <Button size="md" variant="secondary" disabled={busy} onClick={revoke}>
            {lang === 'fr' ? 'Désactiver' : 'Turn off'}
          </Button>
        ) : null}
      </div>

      {link ? (
        <p className="text-xs text-text-2 mt-2.5">
          {lang === 'fr' ? 'Lien actif' : 'Link active'} ·{' '}
          {link.view_count === 0
            ? lang === 'fr'
              ? 'pas encore ouvert'
              : 'not opened yet'
            : `${link.view_count} ${lang === 'fr' ? 'ouverture(s)' : 'view(s)'}`}
          {' · '}
          {lang === 'fr' ? 'expire' : 'expires'} {link.expires_at.slice(11, 16)}
          {' · '}
          {lang === 'fr'
            ? 'générer un nouveau lien désactive celui-ci'
            : 'generating a new link turns this one off'}
        </p>
      ) : null}
    </div>
  );
}
