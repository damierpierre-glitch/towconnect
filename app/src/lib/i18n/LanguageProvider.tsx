'use client';

import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { dictionary, type DictKey, type Lang } from './dictionary';

interface LanguageContextValue {
  lang: Lang;
  setLang: (lang: Lang) => void;
  toggleLang: () => void;
  t: (key: DictKey) => string;
}

const LanguageContext = createContext<LanguageContextValue | null>(null);

const STORAGE_KEY = 'towconnect_lang';

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<Lang>('fr');

  useEffect(() => {
    // Deliberately deferred to an effect (not a lazy useState initializer):
    // the server always renders 'fr', so reading localStorage/navigator here
    // avoids a hydration mismatch instead of causing one.
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === 'fr' || stored === 'en') {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setLangState(stored);
    } else if (navigator.language?.toLowerCase().startsWith('en')) {
      setLangState('en');
    }
  }, []);

  const setLang = (next: Lang) => {
    setLangState(next);
    window.localStorage.setItem(STORAGE_KEY, next);
  };

  const value = useMemo<LanguageContextValue>(
    () => ({
      lang,
      setLang,
      toggleLang: () => setLang(lang === 'fr' ? 'en' : 'fr'),
      t: (key: DictKey) => dictionary[lang][key] ?? key,
    }),
    [lang]
  );

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useLanguage() {
  const ctx = useContext(LanguageContext);
  if (!ctx) throw new Error('useLanguage must be used within a LanguageProvider');
  return ctx;
}
