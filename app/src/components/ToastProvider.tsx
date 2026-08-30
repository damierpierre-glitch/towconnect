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
      {toast ? (
        <div
          key={toast.id}
          className="fixed bottom-6 right-6 z-[300] flex items-center gap-2.5 bg-night-2 border border-orange rounded-xl px-4.5 py-3.5 shadow-2xl animate-in"
          style={{ animation: 'slide-in 0.3s ease' }}
        >
          <span className="text-lg">{toast.icon}</span>
          <span className="text-sm">{toast.message}</span>
        </div>
      ) : null}
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
