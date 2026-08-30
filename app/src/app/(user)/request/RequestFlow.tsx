'use client';

import { useState } from 'react';
import { useLanguage } from '@/lib/i18n/LanguageProvider';
import { useToast } from '@/components/ToastProvider';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { createRequest, reassignDriver } from '@/lib/actions/requests';
import { StepForm } from './StepForm';
import { StepDrivers } from './StepDrivers';
import { StepTracking } from './StepTracking';
import type { RequestFormData } from './types';

type Step = 'idle' | 'form' | 'drivers' | 'tracking';

const STEP_ORDER: Step[] = ['form', 'drivers', 'tracking'];

export function RequestFlow() {
  const { t } = useLanguage();
  const { showToast } = useToast();
  const [step, setStep] = useState<Step>('idle');
  const [form, setForm] = useState<RequestFormData | null>(null);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [declinedDriverId, setDeclinedDriverId] = useState<string | undefined>(undefined);

  function handleFormSubmit(data: RequestFormData) {
    setForm(data);
    setStep('drivers');
  }

  async function handleConfirm(driverId: string, price: number) {
    if (!form) return;
    try {
      if (requestId) {
        // Re-offering to a new driver after a previous decline.
        await reassignDriver(requestId, driverId);
      } else {
        const id = await createRequest({
          problemType: form.problemType,
          locationText: form.locationText,
          lat: form.lat,
          lng: form.lng,
          vehicleDesc: form.vehicleDesc,
          notes: form.notes,
          driverId,
          price,
        });
        setRequestId(id);
      }
      showToast('🚛', t('title_onway'));
      setStep('tracking');
    } catch {
      showToast('⚠️', t('error_generic'));
    }
  }

  function handleDriverDeclined(previousDriverId?: string) {
    if (!requestId) return;
    setDeclinedDriverId(previousDriverId);
    showToast('❌', t('no_drivers'));
    setStep('drivers');
  }

  function reset() {
    setStep('idle');
    setForm(null);
    setRequestId(null);
    setDeclinedDriverId(undefined);
  }

  if (step === 'idle') {
    return <Hero onStart={() => setStep('form')} />;
  }

  const currentIndex = STEP_ORDER.indexOf(step);

  return (
    <div className="max-w-3xl mx-auto px-6 py-8">
      <StepIndicator currentIndex={currentIndex} />
      {step === 'form' ? <StepForm onSubmit={handleFormSubmit} /> : null}
      {step === 'drivers' && form ? (
        <StepDrivers
          form={form}
          excludeDriverId={declinedDriverId}
          onBack={() => setStep('form')}
          onConfirm={handleConfirm}
        />
      ) : null}
      {step === 'tracking' && requestId && form ? (
        <StepTracking
          requestId={requestId}
          userLocation={form}
          onDriverDeclined={handleDriverDeclined}
          onCancelled={reset}
        />
      ) : null}
    </div>
  );
}

function StepIndicator({ currentIndex }: { currentIndex: number }) {
  const { t } = useLanguage();
  const labels = [t('step_situation'), t('step_driver'), t('step_confirm')];

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

function Hero({ onStart }: { onStart: () => void }) {
  const { t } = useLanguage();

  return (
    <div>
      <div
        className="text-center px-5 pt-16 pb-10"
        style={{
          background:
            'radial-gradient(ellipse at 50% 0%, rgba(255,92,26,0.12) 0%, transparent 70%)',
        }}
      >
        <span className="text-6xl mb-4 block">🚨</span>
        <h1 className="font-display text-3xl md:text-[42px] font-extrabold leading-tight mb-4">
          {t('hero_title_1')}
          <br />
          {t('hero_title_2')} <span className="text-orange">{t('hero_title_3')}</span>
        </h1>
        <p className="text-[17px] text-text-2 max-w-lg mx-auto mb-8 leading-relaxed">
          {t('hero_sub')}
        </p>
        <div className="flex gap-2.5 justify-center flex-wrap mb-10">
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-green/15 text-green">
            {t('badge_canada')}
          </span>
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-orange/15 text-orange">
            {t('badge_fast')}
          </span>
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-blue/15 text-blue">
            {t('badge_safe')}
          </span>
        </div>
        <Button size="lg" onClick={onStart}>
          🚨 {t('btn_emergency')}
        </Button>
      </div>

      <div className="max-w-5xl mx-auto px-6 pb-16">
        <div className="grid md:grid-cols-3 gap-4">
          <FeatureCard icon="💵" title={t('feat1_title')} sub={t('feat1_sub')} />
          <FeatureCard icon="📍" title={t('feat2_title')} sub={t('feat2_sub')} />
          <FeatureCard icon="🍁" title={t('feat3_title')} sub={t('feat3_sub')} />
        </div>
      </div>
    </div>
  );
}

function FeatureCard({ icon, title, sub }: { icon: string; title: string; sub: string }) {
  return (
    <Card className="text-center py-7 px-5">
      <div className="text-4xl mb-3">{icon}</div>
      <h4 className="font-display font-bold mb-1.5">{title}</h4>
      <p className="text-sm text-muted">{sub}</p>
    </Card>
  );
}
