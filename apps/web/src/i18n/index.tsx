// Locale — 字典不再全局:词条经 'locale' 贡献点按 feature 注册,
// Provider 订阅 registry 合并出各 locale 字典。feature 拆除 →
// 词条离场 → t() 回落键名(诚实降级,不藏缺词)。
// 契约仍是"组件无字面量";plurals/插值/懒包是以后的切片。
import { createContext, useCallback, useContext, useMemo, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import type { Registry } from '../kernel/registry';
import type { Dict, Locale } from './types';

export type { Locale } from './types';

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

export function I18nProvider({ registry, children }: { registry: Registry; children: ReactNode }) {
    const [locale, setLocaleState] = useState<Locale>(readStoredLocale);
    const contribs = useSyncExternalStore(
        registry.subscribe,
        () => registry.list('locale'),
        () => registry.list('locale'),
    );
    /** locale → 合并字典;后注册的同键词条覆盖先注册的(同 cordis 后效)。 */
    const dicts = useMemo(() => {
        const merged: Record<string, Dict> = {};
        for (const c of contribs)
            for (const [loc, d] of Object.entries(c.dicts))
                merged[loc] = { ...(merged[loc] ?? {}), ...d };
        return merged;
    }, [contribs]);
    const setLocale = useCallback((l: Locale) => {
        setLocaleState(l);
        try { localStorage.setItem(STORAGE_KEY, l); } catch { /* ignore */ }
        document.documentElement.lang = l;
    }, []);
    const t = useCallback(
        (key: string) => dicts[locale]?.[key] ?? dicts['zh-CN']?.[key] ?? key,
        [locale, dicts],
    );
    const value = useMemo(() => ({ locale, setLocale, t }), [locale, setLocale, t]);
    return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18n {
    return useContext(I18nContext);
}
