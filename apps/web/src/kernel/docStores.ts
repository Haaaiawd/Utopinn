// Kernel-level shared document stores — the single source of truth for
// docs that multiple edit surfaces touch at once.
//
//   presetDocs   — preset documents, keyed presetKey(apiId, name).
//                  Every surface (right-rail PresetDocEditor, studio
//                  presets page, automation panel preset regex groups,
//                  param sliders via mutatePresetDoc) reads/writes the
//                  same optimistic doc; saves are debounced fresh-base
//                  writes so no surface can clobber another.
//   qrSettings   — settings.extension_settings.quickReplyV2 bindings doc.
//                  Composer header, automation panel and studio QR page
//                  share one doc instead of three snapshots.
//   qrChatCfgs   — chat_metadata.quickReply link docs, keyed per chat.
//
// After out-of-lane writes (STscript runs can mutate any of these via
// TH: /setregex preset-scope writes, /qrset chat links, /cut floors),
// call invalidateSharedDocs() to re-pull every live entry.
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { getPreset, savePreset } from '../api/presets';
import { getQrSettingsDoc, patchQrSettingsDoc, getChatQrConfig, patchChatQrConfig } from '../api/quickreplies';
import type { PresetDocument } from '../api/presets';
import type { QrConfig, QrSettings } from '../api/quickreplies';
import type { SharedDocSnapshot, SharedDocStore } from '../lib/sharedDoc';
import { createSharedDocStore } from '../lib/sharedDoc';

/** Error surface — App wires this to s.hint once at mount. */
let errorHandler: (scope: string, key: string, message: string) => void = () => undefined;
export function setSharedDocErrorHandler(fn: (scope: string, key: string, message: string) => void): void {
    errorHandler = fn;
}
const onErr = (scope: string) => (key: string, message: string) => errorHandler(scope, key, message);

/* Preset doc keys encode apiId + name — JSON keeps names with '/' safe. */
export const presetKey = (apiId: string, name: string): string => JSON.stringify([apiId, name]);
export const presetKeyParts = (key: string): { apiId: string; name: string } => {
    const [apiId, name] = JSON.parse(key) as [string, string];
    return { apiId, name };
};

export const presetDocs: SharedDocStore<PresetDocument> = createSharedDocStore<PresetDocument>({
    load: (key) => {
        const { apiId, name } = presetKeyParts(key);
        return getPreset(name, apiId).then((r) => r.doc);
    },
    save: (key, doc) => {
        const { apiId, name } = presetKeyParts(key);
        return savePreset(name, doc, apiId);
    },
    debounceMs: 450,
    onError: onErr('preset'),
});

const QR_KEY = 'quickReplyV2';
export const qrSettings: SharedDocStore<QrSettings> = createSharedDocStore<QrSettings>({
    load: () => getQrSettingsDoc().then((d) => d ?? {}),
    save: (_key, doc) => patchQrSettingsDoc(doc),
    debounceMs: 250,
    onError: onErr('qr-settings'),
});

/* Per-chat QR link doc, keyed qrChatKey(charDir, chatName). */
export const qrChatKey = (charDir: string, chatName: string): string => JSON.stringify([charDir, chatName]);
const qrChatKeyParts = (key: string): { charDir: string; chatName: string } => {
    const [charDir, chatName] = JSON.parse(key) as [string, string];
    return { charDir, chatName };
};

export const qrChatCfgs: SharedDocStore<QrConfig> = createSharedDocStore<QrConfig>({
    load: (key) => {
        const { charDir, chatName } = qrChatKeyParts(key);
        return getChatQrConfig(charDir, chatName).then((r) => r ?? {});
    },
    save: (key, cfg) => {
        const { charDir, chatName } = qrChatKeyParts(key);
        return patchChatQrConfig(charDir, chatName, cfg);
    },
    debounceMs: 250,
    onError: onErr('qr-chat'),
});

/** Re-pull every live entry across all stores — call after script runs
    and other out-of-lane writes (TH can write preset-scope regex, QR
    links, and floors all server-side). */
export function invalidateSharedDocs(): void {
    presetDocs.invalidateAll();
    qrSettings.invalidateAll();
    qrChatCfgs.invalidateAll();
}

/* Bound mutate/flush helpers — callers get a clean signature instead of
   hand-encoding store keys. */
export const mutatePresetDoc = (apiId: string, name: string, fn: (d: PresetDocument) => PresetDocument): void =>
    presetDocs.mutate(presetKey(apiId, name), fn);
export const flushPresetDoc = (apiId: string, name: string): Promise<void> =>
    presetDocs.flush(presetKey(apiId, name));

export const mutateQrSettings = (fn: (d: QrSettings) => QrSettings): void =>
    qrSettings.mutate(QR_KEY, fn);
export const flushQrSettings = (): Promise<void> => qrSettings.flush(QR_KEY);

export const mutateQrChatCfg = (charDir: string, chatName: string, fn: (d: QrConfig) => QrConfig): void =>
    qrChatCfgs.mutate(qrChatKey(charDir, chatName), fn);
export const flushQrChatCfg = (charDir: string, chatName: string): Promise<void> =>
    qrChatCfgs.flush(qrChatKey(charDir, chatName));

/* ---------- React bindings ---------- */

/* Null-key snapshot must be referentially stable — a fresh object per
   getSnapshot makes useSyncExternalStore loop forever (React #185). */
const NULL_SNAP: SharedDocSnapshot<never> = { doc: null, status: 'idle', saving: false, version: 0 };

const useDoc = <T,>(store: SharedDocStore<T>, key: string | null): SharedDocSnapshot<T> => {
    const subscribe = useCallback(
        (l: () => void) => (key ? store.subscribe(key, l) : () => undefined),
        [store, key],
    );
    const getSnapshot = useCallback(
        () => (key ? store.getSnapshot(key) : NULL_SNAP),
        [store, key],
    );
    const snap = useSyncExternalStore(subscribe, getSnapshot);
    useEffect(() => {
        if (key) void store.ensure(key).catch(() => undefined);
    }, [store, key]);
    return snap as SharedDocSnapshot<T>;
};

/** Optimistic preset doc for (apiId, name) — null name renders empty. */
export const usePresetDoc = (apiId: string, name: string | null): SharedDocSnapshot<PresetDocument> =>
    useDoc(presetDocs, name != null ? presetKey(apiId, name) : null);

/** Shared quickReplyV2 bindings doc. */
export const useQrSettings = (): SharedDocSnapshot<QrSettings> => useDoc(qrSettings, QR_KEY);

/** Shared per-chat QR link doc. */
export const useQrChatCfg = (charDir: string | null, chatName: string | null): SharedDocSnapshot<QrConfig> =>
    useDoc(qrChatCfgs, charDir != null && chatName != null ? qrChatKey(charDir, chatName) : null);
