// Minimal locale dictionary (IA §14: strings are locale-owned, V1 zh+en).
// Deliberately tiny — a real i18n layer (plurals, interpolation, lazy packs)
// is a later slice; the contract here is "no literals in components".
import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { Dict, Locale } from './types';
import { zhCN } from './zh-CN';
import { en } from './en';

export type { Locale } from './types';

const DICTS: Record<Locale, Dict> = { 'zh-CN': zhCN, en };

const STORAGE_KEY = 'uberge.locale';

function readStoredLocale(): Locale {
    try {
        const v = localStorage.getItem(STORAGE_KEY);
        if (v === 'en' || v === 'zh-CN') return v;
    } catch { /* storage unavailable */ }
    return 'zh-CN';
}

export interface I18n {
    locale: Locale;
    setLocale: (l: Locale) => void;
    /** Look up a key; falls back to zh-CN, then renders the key itself. */
    t: (key: string) => string;
}

const I18nContext = createContext<I18n>({
    locale: 'zh-CN',
    setLocale: () => undefined,
    t: (k) => k,
});

export function I18nProvider({ children }: { children: ReactNode }) {
    const [locale, setLocaleState] = useState<Locale>(readStoredLocale);
    const setLocale = useCallback((l: Locale) => {
        setLocaleState(l);
        try { localStorage.setItem(STORAGE_KEY, l); } catch { /* ignore */ }
        document.documentElement.lang = l;
    }, []);
    const t = useCallback(
        (key: string) => DICTS[locale][key] ?? zhCN[key] ?? key,
        [locale],
    );
    const value = useMemo(() => ({ locale, setLocale, t }), [locale, setLocale, t]);
    return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18n {
    return useContext(I18nContext);
}
