'use client';

import Link from 'next/link';
import { useLanguage } from '@/lib/i18n/LanguageProvider';
import type { DictKey } from '@/lib/i18n/dictionary';
import { problemLabel } from '@/lib/constants';
import { toMoney } from '@/lib/pricing';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import type { Payment, PaymentStatus, TowRequest } from '@/lib/supabase/types';

const PAYMENT_BADGE_TONE: Record<PaymentStatus, 'green' | 'yellow' | 'red' | 'orange'> = {
  requires_payment_method: 'yellow',
  requires_action: 'yellow',
  authorized: 'orange',
  captured: 'green',
  failed: 'red',
  canceled: 'red',
  refunded: 'orange',
};

export function Receipt({
  request,
  driverName,
  payment,
}: {
  request: TowRequest;
  driverName: string | null;
  payment: Payment | null;
}) {
  const { t, lang } = useLanguage();

  const base = toMoney(request.price_base);
  const distance = toMoney(request.price_distance);
  const surcharge = toMoney(request.price_surcharge);
  const total = toMoney(request.price_estimate);
  const towKm = request.tow_distance_km == null ? null : toMoney(request.tow_distance_km);

  return (
    <div className="max-w-md mx-auto px-6 py-8">
      <Link href="/history" className="text-sm text-orange font-medium">
        {t('receipt_back')}
      </Link>

      <Card className="mt-4">
        <div className="text-center pb-5 border-b border-steel/60 mb-5">
          <div className="text-3xl mb-2">🧾</div>
          <h1 className="font-display text-xl font-bold">{t('receipt_title')}</h1>
          <p className="text-xs text-muted mt-1">TowConnect · #{request.id.slice(0, 8)}</p>
        </div>

        <dl className="flex flex-col gap-3 text-sm mb-5">
          <Row label={t('receipt_service')} value={problemLabel(request.problem_type, lang)} />
          <Row
            label={t('receipt_date')}
            value={new Date(request.created_at).toLocaleString(lang === 'fr' ? 'fr-CA' : 'en-CA')}
          />
          <Row label={t('receipt_pickup')} value={request.location_text} />
          {request.destination_address ? (
            <Row label={t('receipt_destination')} value={request.destination_address} />
          ) : null}
          {driverName ? <Row label={t('receipt_driver')} value={driverName} /> : null}
        </dl>

        <div className="border-t border-steel/60 pt-4 mb-5">
          <PriceLine label={lang === 'fr' ? 'Frais de base' : 'Base fare'} value={base} />
          {/* The kilometres are the only thing that makes this line checkable:
              a bare "$4.50" next to "Distance" is exactly the opaque invoice
              line this product exists to replace. tow_distance_km is frozen
              onto the request at creation (0012), so it is the billed figure,
              not a recalculation. Older requests predate the column and simply
              show the amount. */}
          <PriceLine
            label={
              towKm != null
                ? `${lang === 'fr' ? 'Distance' : 'Distance'} · ${towKm.toFixed(1)} km`
                : lang === 'fr'
                  ? 'Distance'
                  : 'Distance'
            }
            value={distance}
          />
          {surcharge > 0 ? <PriceLine label={lang === 'fr' ? 'Supplément' : 'Surcharge'} value={surcharge} /> : null}
          <div className="flex justify-between items-center pt-2 mt-2 border-t border-steel/60">
            <span className="font-semibold">{t('receipt_total')}</span>
            <span className="font-display text-xl font-bold text-orange">${total.toFixed(2)}</span>
          </div>
        </div>

        {payment ? (
          <div className="bg-night-3 border border-steel rounded-xl p-4">
            <div className="flex justify-between items-center mb-2">
              <span className="text-sm text-text-2">{t('receipt_payment_status')}</span>
              <Badge tone={PAYMENT_BADGE_TONE[payment.status]}>{t(`pay_status_${payment.status}` as DictKey)}</Badge>
            </div>
            {payment.stripe_payment_intent_id ? (
              <div className="flex justify-between items-center text-xs text-muted">
                <span>{t('receipt_transaction')}</span>
                <span className="font-mono">{payment.stripe_payment_intent_id}</span>
              </div>
            ) : null}
          </div>
        ) : null}
      </Card>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-muted shrink-0">{label}</dt>
      <dd className="text-right">{value}</dd>
    </div>
  );
}

function PriceLine({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex justify-between text-sm text-text-2 py-0.5">
      <span>{label}</span>
      <span>${value.toFixed(2)}</span>
    </div>
  );
}
