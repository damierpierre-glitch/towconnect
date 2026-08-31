'use client';

import { useState } from 'react';
import { useLanguage } from '@/lib/i18n/LanguageProvider';
import { useToast } from '@/components/ToastProvider';
import { cancelRequest, createRequest } from '@/lib/actions/requests';
import { retryRequestPayment } from '@/lib/actions/payments';
import type { PaymentStatus, TowRequest, Vehicle } from '@/lib/supabase/types';
import { StepForm } from './StepForm';
import { StepEstimate } from './StepEstimate';
import { StepPayment } from './StepPayment';
import { StepTracking } from './StepTracking';
import type { RequestFormData } from './types';

type Step = 'form' | 'estimate' | 'payment' | 'tracking';

const STEP_ORDER: Step[] = ['form', 'estimate', 'tracking'];

export function RequestFlow({
  userId,
  vehicles,
  initialActiveRequest,
  initialUnresolvedPaymentStatus,
}: {
  userId: string;
  vehicles: Vehicle[];
  initialActiveRequest: TowRequest | null;
  // Set when the resumed request's payment never resolved — that request is
  // 'pending' but dispatch never ran for it, so tracking would show an
  // endless "searching" with no driver ever arriving. Land on the payment
  // step instead, where the rider can retry or cancel.
  initialUnresolvedPaymentStatus: PaymentStatus | null;
}) {
  const { t } = useLanguage();
  const { showToast } = useToast();

  // The DB is the source of truth for "is there an active intervention" —
  // page.tsx already fetched it server-side (RLS-scoped to this user) before
  // this component ever mounts, so a refresh or a reopened tab lands
  // straight back in tracking — searching, offer outstanding, matched, or en
  // route, StepTracking itself figures out which — instead of losing state.
  const [step, setStep] = useState<Step>(
    initialActiveRequest ? (initialUnresolvedPaymentStatus ? 'payment' : 'tracking') : 'form'
  );
  const [form, setForm] = useState<RequestFormData | null>(null);
  const [requestId, setRequestId] = useState<string | null>(initialActiveRequest?.id ?? null);
  const [userLocation, setUserLocation] = useState<{ lat: number; lng: number } | null>(
    initialActiveRequest ? { lat: initialActiveRequest.lat, lng: initialActiveRequest.lng } : null
  );
  const [createdAt, setCreatedAt] = useState<string | null>(initialActiveRequest?.created_at ?? null);
  const [paymentStatus, setPaymentStatus] = useState<PaymentStatus | 'skipped' | null>(
    initialUnresolvedPaymentStatus
  );
  const [paymentClientSecret, setPaymentClientSecret] = useState<string | null>(null);
  const [paymentMethodId, setPaymentMethodId] = useState<string | null>(null);
  const [retryingPayment, setRetryingPayment] = useState(false);

  function handleFormSubmit(data: RequestFormData) {
    setForm(data);
    setStep('estimate');
  }

  function enterTracking(id: string, lat: number, lng: number) {
    setRequestId(id);
    setUserLocation({ lat, lng });
    setCreatedAt(new Date().toISOString());
    showToast('🔍', t('dispatch_searching'));
    setStep('tracking');
  }

  async function handleConfirm() {
    if (!form) return;
    try {
      const result = await createRequest({
        problemType: form.problemType,
        locationText: form.locationText,
        lat: form.lat,
        lng: form.lng,
        vehicleDesc: form.vehicleDesc,
        vehicleId: form.vehicleId,
        notes: form.notes,
        destinationAddress: form.destinationAddress,
        destinationLat: form.destinationLat,
        destinationLng: form.destinationLng,
      });

      if (result.paymentStatus === 'authorized' || result.paymentStatus === 'skipped') {
        enterTracking(result.requestId, form.lat, form.lng);
        return;
      }

      // requires_action / failed — payment must be resolved before dispatch.
      setRequestId(result.requestId);
      setPaymentStatus(result.paymentStatus);
      setPaymentClientSecret(result.paymentClientSecret);
      setPaymentMethodId(result.paymentMethodId);
      setStep('payment');
    } catch {
      showToast('⚠️', t('error_generic'));
    }
  }

  function handlePaymentResolved() {
    if (!requestId) return;
    // On a resumed request `form` is null (it was never re-filled), so fall
    // back to the coordinates the request itself was created with.
    const lat = form?.lat ?? userLocation?.lat ?? initialActiveRequest?.lat;
    const lng = form?.lng ?? userLocation?.lng ?? initialActiveRequest?.lng;
    if (lat == null || lng == null) return;
    enterTracking(requestId, lat, lng);
  }

  async function handlePaymentRetry() {
    if (!requestId) return;
    setRetryingPayment(true);
    try {
      const result = await retryRequestPayment(requestId);
      if (result.status === 'authorized') {
        handlePaymentResolved();
      } else {
        setPaymentStatus(result.status);
        setPaymentClientSecret(result.clientSecret);
        setPaymentMethodId(result.paymentMethodId);
      }
    } catch {
      showToast('⚠️', t('error_generic'));
    } finally {
      setRetryingPayment(false);
    }
  }

  async function handlePaymentGiveUp() {
    if (requestId) {
      try {
        await cancelRequest(requestId);
      } catch {
        // Best effort — reset() below returns the user to a blank form
        // regardless of whether the cancel call itself succeeded.
      }
    }
    reset();
  }

  function reset() {
    setStep('form');
    setForm(null);
    setRequestId(null);
    setUserLocation(null);
    setCreatedAt(null);
    setPaymentStatus(null);
    setPaymentClientSecret(null);
    setPaymentMethodId(null);
  }

  const currentIndex = STEP_ORDER.indexOf(step === 'payment' ? 'estimate' : step);

  return (
    <div className="max-w-3xl mx-auto px-6 py-8">
      <StepIndicator currentIndex={currentIndex} />
      {step === 'form' ? <StepForm vehicles={vehicles} onSubmit={handleFormSubmit} /> : null}
      {step === 'estimate' && form ? (
        <StepEstimate form={form} onBack={() => setStep('form')} onConfirm={handleConfirm} />
      ) : null}
      {step === 'payment' && requestId && paymentStatus && paymentStatus !== 'skipped' ? (
        <StepPayment
          requestId={requestId}
          status={paymentStatus}
          clientSecret={paymentClientSecret}
          paymentMethodId={paymentMethodId}
          retrying={retryingPayment}
          onResolved={handlePaymentResolved}
          onRetry={handlePaymentRetry}
          onGiveUp={handlePaymentGiveUp}
        />
      ) : null}
      {step === 'tracking' && requestId && userLocation && createdAt ? (
        <StepTracking
          requestId={requestId}
          userId={userId}
          userLocation={userLocation}
          createdAt={createdAt}
          onCancelled={reset}
        />
      ) : null}
    </div>
  );
}

function StepIndicator({ currentIndex }: { currentIndex: number }) {
  const { t } = useLanguage();
  const labels = [t('step_situation'), t('step_estimate'), t('step_confirm')];

  return (
    <div className="flex mb-7">
      {labels.map((label, i) => (
        <div key={label} className="flex-1 flex flex-col items-center gap-1.5">
          <div className="flex items-center w-full">
            {i > 0 ? <div className={`h-0.5 flex-1 ${i <= currentIndex ? 'bg-orange' : 'bg-steel'}`} /> : <div className="flex-1" />}
            <div
              className={`w-8 h-8 rounded-full border-2 flex items-center justify-center text-xs font-semibold shrink-0 ${
                i < currentIndex
                  ? 'bg-orange border-orange text-white'
                  : i === currentIndex
                    ? 'border-orange text-orange'
                    : 'border-steel text-muted'
              }`}
            >
              {i < currentIndex ? '✓' : i + 1}
            </div>
            {i < labels.length - 1 ? (
              <div className={`h-0.5 flex-1 ${i < currentIndex ? 'bg-orange' : 'bg-steel'}`} />
            ) : (
              <div className="flex-1" />
            )}
          </div>
          <span className="text-[11px] text-muted text-center">{label}</span>
        </div>
      ))}
    </div>
  );
}
