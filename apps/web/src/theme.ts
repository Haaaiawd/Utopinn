// Theme = CSS custom properties on [data-theme] (tokens.css). Dark default,
// paper a toggle away (IA §14). Persisted to localStorage in the skeleton;
// the design intends typing/appearance to sync server-side later.
import { useCallback, useSyncExternalStore } from 'react';

export type Theme = 'dark' | 'light';

const STORAGE_KEY = 'uberge.theme';
const listeners = new Set<() => void>();

export function getTheme(): Theme {
    return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

export function setTheme(theme: Theme) {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem(STORAGE_KEY, theme); } catch { /* ignore */ }
    listeners.forEach((l) => l());
}

export function toggleTheme() {
    setTheme(getTheme() === 'dark' ? 'light' : 'dark');
}

function subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function useTheme(): { theme: Theme; toggle: () => void } {
    const theme = useSyncExternalStore(subscribe, getTheme);
    const toggle = useCallback(() => toggleTheme(), []);
    return { theme, toggle };
}
