'use client';

import { useEffect, useState } from 'react';
import { useLanguage } from '@/lib/i18n/LanguageProvider';
import { useToast } from '@/components/ToastProvider';
import { Button } from '@/components/ui/Button';
import { Input, Label } from '@/components/ui/Field';
import { listSupplementTypes, proposeSupplement } from '@/lib/actions/supplements';
import type { ServiceSupplementType } from '@/lib/supabase/types';
import { errorMessageKey } from '@/lib/errors';

// The driver's side of a supplement: propose, and wait. There is no approve
// control here because there is nothing for a driver to approve — the
// customer holds that, and 0027's trigger enforces it regardless of what any
// screen offers.
export function ProposeSupplement({ requestId }: { requestId: string }) {
  const { t, lang } = useLanguage();
  const { showToast } = useToast();
  const [types, setTypes] = useState<ServiceSupplementType[]>([]);
  const [open, setOpen] = useState(false);
  const [typeKey, setTypeKey] = useState('');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const rows = await listSupplementTypes();
      if (cancelled) return;
      setTypes(rows);
      setTypeKey((prev) => prev || rows[0]?.key || '');
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function submit() {
    setSaving(true);
    try {
      await proposeSupplement(requestId, typeKey, parseFloat(amount), note);
      setAmount('');
      setNote('');
      setOpen(false);
      showToast('✅', t('supp_awaiting_client'));
    } catch (e) {
      showToast('⚠️', t(errorMessageKey(e)));
    } finally {
      setSaving(false);
    }
  }

  if (!open) {
    return (
      <Button variant="secondary" full className="mt-3" onClick={() => setOpen(true)}>
        ➕ {t('supp_add_title')}
      </Button>
    );
  }

  return (
    <div className="mt-3 bg-night-3 border border-night-4 rounded-xl p-4">
      <h4 className="font-display font-bold text-sm mb-1">{t('supp_add_title')}</h4>
      <p className="text-xs text-muted mb-3">
        {lang === 'fr'
          ? "Le client verra ce montant et devra l'approuver. Il n'est jamais facturé sans son accord."
          : 'The customer sees this amount and must approve it. It is never charged without their consent.'}
      </p>

      <div className="grid sm:grid-cols-2 gap-3 mb-3">
        <div>
          <Label>{t('supp_title')}</Label>
          <select
            value={typeKey}
            onChange={(e) => setTypeKey(e.target.value)}
            className="w-full bg-night-2 border border-steel rounded-xl px-4 py-3 text-text"
          >
            {types.map((x) => (
              <option key={x.key} value={x.key}>
                {lang === 'fr' ? x.label_fr : x.label_en}
              </option>
            ))}
          </select>
        </div>
        <div>
          <Label>{t('supp_amount')}</Label>
          <Input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
        </div>
      </div>

      <div className="mb-4">
        <Label>{t('supp_note')}</Label>
        <Input value={note} onChange={(e) => setNote(e.target.value)} />
      </div>

      <div className="flex gap-2">
        <Button variant="secondary" className="flex-1" onClick={() => setOpen(false)}>
          {t('btn_back')}
        </Button>
        <Button
          className="flex-[2]"
          disabled={saving || !typeKey || !(parseFloat(amount) > 0)}
          onClick={submit}
        >
          {t('supp_propose')}
        </Button>
      </div>
    </div>
  );
}
