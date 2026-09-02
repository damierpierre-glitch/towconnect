'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useLanguage } from '@/lib/i18n/LanguageProvider';
import { formatDate } from '@/lib/formatDate';
import type { RegulatedTowingZone } from '@/lib/supabase/types';

// Looks up the rule that applies at a point. The database is the authority:
// this only renders what regulated_zone_for_point() returns, and that
// function only ever returns zones that are active, in force today, and have
// a real geometry.
//
// A composite-returning Postgres function hands back a row of NULLs rather
// than nothing when there is no match, so `id` is what says "no zone here",
// not the row being absent.
export function useRegulatedZone(lat: number | null, lng: number | null) {
  const [zone, setZone] = useState<RegulatedTowingZone | null>(null);
  const [fetched, setFetched] = useState(false);

  useEffect(() => {
    // No coordinates yet: nothing to ask, and nothing to set. Deliberately no
    // setState in the synchronous part of this effect — `checked` is derived
    // below instead, which is what "there is nowhere to look up" actually
    // means.
    if (lat == null || lng == null) return;

    let cancelled = false;
    (async () => {
      const supabase = createClient();
      const { data, error } = await supabase.rpc('regulated_zone_for_point', {
        p_lat: lat,
        p_lng: lng,
      });
      if (cancelled) return;
      const row = data as RegulatedTowingZone | null;
      setZone(!error && row && row.id ? row : null);
      setFetched(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [lat, lng]);

  const checked = lat == null || lng == null ? true : fetched;
  return { zone, checked };
}

// The instruction shown to a motorist standing in a regulated zone.
//
// Everything here comes from the zone row: the instruction text is stored per
// language and written from the official wording, the phone number is the one
// the jurisdiction publishes, and the source link is the page it was read
// from. Nothing is composed on the fly, because a paraphrased legal
// instruction is how someone ends up calling the wrong number.
export function RegulatedZoneNotice({
  zone,
  compact = false,
}: {
  zone: RegulatedTowingZone;
  compact?: boolean;
}) {
  const { t, lang } = useLanguage();
  const instruction = lang === 'fr' ? zone.user_instruction_fr : zone.user_instruction_en;
  const blocksDispatch =
    zone.dispatch_mode === 'external_authority_required' ||
    zone.dispatch_mode === 'manual_instruction_only';

  return (
    <div className="rounded-[18px] border border-yellow/40 bg-yellow/5 p-5">
      <div className="flex items-start gap-3 mb-3">
        <span className="mt-0.5 shrink-0 w-2 h-2 rounded-full bg-yellow" aria-hidden />
        <div className="min-w-0">
          <h3 className="font-display font-bold text-[15px] text-yellow">{t('zone_detected_title')}</h3>
          <p className="text-xs text-muted mt-0.5 break-words">
            {zone.official_name} · {zone.province}
          </p>
        </div>
      </div>

      <p className="text-sm text-text leading-relaxed mb-4">{instruction}</p>

      {zone.authority_phone ? (
        <a
          href={`tel:${zone.authority_phone}`}
          className="cta-glow inline-flex items-center justify-center w-full sm:w-auto px-6 py-3.5 rounded-xl bg-orange-dark text-white font-semibold text-[17px] hover:bg-orange-deep transition-colors mb-4"
        >
          {t('zone_call_cta')} {zone.authority_phone}
        </a>
      ) : null}

      {blocksDispatch ? (
        <p className="text-xs text-yellow/90 mb-4">{t('zone_cannot_dispatch')}</p>
      ) : (
        <p className="text-xs text-text-2 mb-4">{t('zone_authorized_search')}</p>
      )}

      {!compact ? (
        <dl className="text-xs text-muted space-y-1 border-t border-night-4 pt-3">
          <div className="flex gap-2">
            <dt className="shrink-0">{t('zone_jurisdiction_label')} :</dt>
            <dd className="text-text-2 break-words">{zone.jurisdiction}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="shrink-0">{t('zone_source_label')} :</dt>
            <dd className="min-w-0">
              <a
                href={zone.source_url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-orange hover:text-orange-light break-all"
              >
                {zone.source_title}
              </a>
            </dd>
          </div>
          <div className="flex gap-2">
            <dt className="shrink-0">{t('zone_verified_label')} :</dt>
            <dd className="text-text-2">{formatDate(zone.last_verified_at)}</dd>
          </div>
        </dl>
      ) : null}
    </div>
  );
}

// Shown while a request sits in restricted_capacity_wait: the authorized
// providers for the zone exist but none is free. Deliberately carries no
// estimated wait — we do not have one, and inventing one here would be the
// exact "faux ETA" the brief rules out.
export function RestrictedCapacityNotice() {
  const { t } = useLanguage();
  return (
    <div className="rounded-[18px] border border-yellow/40 bg-yellow/5 p-5">
      <h3 className="font-display font-bold text-[15px] text-yellow mb-1.5">
        {t('zone_capacity_wait_title')}
      </h3>
      <p className="text-sm text-text-2 leading-relaxed">{t('zone_capacity_wait_sub')}</p>
    </div>
  );
}
