'use client';

import { createContext, useCallback, useContext, useRef, useState } from 'react';

interface Toast {
  id: number;
  icon: string;
  message: string;
}

interface ToastContextValue {
  showToast: (icon: string, message: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toast, setToast] = useState<Toast | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const idRef = useRef(0);

  const showToast = useCallback((icon: string, message: string) => {
    idRef.current += 1;
    setToast({ id: idRef.current, icon, message });
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setToast(null), 3000);
  }, []);

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      {/* A live region, always present.
          A toast is frequently the ONLY feedback for an action — "supplement
          declined", "location unavailable", "your card was refused". Rendered
          without one, a screen-reader user performs the action and hears
          nothing at all. The region has to exist before the message arrives,
          which is why the wrapper is unconditional and only its contents are
          conditional. The icon is decorative and hidden: "warning sign" read
          aloud before every message adds nothing. */}
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="fixed bottom-6 right-6 z-[300] pointer-events-none"
      >
        {toast ? (
          <div
            key={toast.id}
            className="flex items-center gap-2.5 bg-night-2 border border-orange rounded-xl px-4.5 py-3.5 shadow-2xl animate-in"
            style={{ animation: 'slide-in 0.3s ease' }}
          >
            <span className="text-lg" aria-hidden="true">
              {toast.icon}
            </span>
            <span className="text-sm">{toast.message}</span>
          </div>
        ) : null}
      </div>
      <style>{`
        @keyframes slide-in {
          from { transform: translateX(100px); opacity: 0; }
          to { transform: translateX(0); opacity: 1; }
        }
      `}</style>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within a ToastProvider');
  return ctx;
}
