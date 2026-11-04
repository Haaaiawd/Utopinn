// Tiny key/value persistence adapter for reader settings & progress.
// Backed by react-native-mmkv (already a declared dep — the research note
// in .loom/capabilities/mobile-app-stack calls it the right tool for
// high-frequency small objects). When the native module isn't in the
// running binary (Expo Go / web preview), we degrade to an in-memory map:
// the reader still works, settings just don't survive a reload.
let impl: { getString(k: string): string | undefined; set(k: string, v: string): void } | null = null;
let warned = false;

function backend() {
    if (impl) return impl;
    try {
        // Lazy require so a missing native module never breaks module init.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { createMMKV } = require('react-native-mmkv') as typeof import('react-native-mmkv');
        const store = createMMKV({ id: 'uberge.reader' });
        impl = {
            getString: (k) => store.getString(k),
            set: (k, v) => store.set(k, v),
        };
    } catch {
        if (!warned) {
            warned = true;
            console.warn('[kv] react-native-mmkv unavailable — falling back to in-memory storage (dev build needed for persistence)');
        }
        const mem = new Map<string, string>();
        impl = { getString: (k) => mem.get(k), set: (k, v) => void mem.set(k, v) };
    }
    return impl;
}

export function kvGet<T>(key: string): T | null {
    try {
        const raw = backend().getString(key);
        return raw == null ? null : (JSON.parse(raw) as T);
    } catch {
        return null;
    }
}

export function kvSet(key: string, value: unknown): void {
    try {
        backend().set(key, JSON.stringify(value));
    } catch {
        /* never let persistence kill UX */
    }
}
