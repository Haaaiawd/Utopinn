import { assembleResourceFields, loadResourceBootstrap } from './resource-read.js';
import { assembleJsonFields } from './util/resource-fields.js';
import {
    listWorldInfoNames,
    loadNamedDocumentEntries,
    loadPresetDocumentEntries,
    loadPresetResources,
    stampNamedDocuments,
} from './named-resource-read.js';

function selectedPresetNames(settings) {
    return {
        novel: settings?.preset_settings_novel,
        openai: settings?.oai_settings?.preset_settings_openai ?? settings?.preset_settings_openai,
        textgenerationwebui: settings?.textgenerationwebui_settings?.preset,
        kobold: settings?.kai_settings?.preset_settings ?? settings?.preset_settings,
    };
}

export async function loadSettingsDocument({ signal } = {}) {
    const { account } = await loadResourceBootstrap({ signal });
    const query = new URLSearchParams({ account });
    const directoryUrl = `/api/settings/fields?${query}`;
    const fieldUrl = (path) => {
        const params = new URLSearchParams({ account, path });
        return `/api/settings/field?${params}`;
    };
    const { directory, values } = await assembleResourceFields({ directoryUrl, fieldUrl, signal });
    return assembleJsonFields(directory, values);
}

async function loadAdvancedPreset(apiId, { signal } = {}) {
    return stampNamedDocuments(await loadPresetDocumentEntries(apiId, { signal }));
}

async function buildSettingsEnvelopeFromDocument(settingsDocument, { bootstrap = false, signal } = {}) {
    const metadata = await loadResourceBootstrap({ signal });
    const selected = selectedPresetNames(settingsDocument);

    const [
        presetData,
        world_names,
        themes,
        movingUIPresets,
        quickReplyEntries,
        instruct,
        context,
        sysprompt,
        reasoning,
    ] = await Promise.all([
        loadPresetResources({ selected, complete: !bootstrap, signal }),
        listWorldInfoNames({ signal }),
        loadNamedDocumentEntries('themes', { signal }),
        loadNamedDocumentEntries('movingUI', { signal }),
        bootstrap ? [] : loadNamedDocumentEntries('quickReplies', { signal }),
        loadAdvancedPreset('instruct', { signal }),
        loadAdvancedPreset('context', { signal }),
        loadAdvancedPreset('sysprompt', { signal }),
        loadAdvancedPreset('reasoning', { signal }),
    ]);

    return {
        ...presetData,
        settings: JSON.stringify(settingsDocument),
        world_names,
        themes: stampNamedDocuments(themes),
        movingUIPresets: stampNamedDocuments(movingUIPresets),
        quickReplyPresets: bootstrap ? [] : stampNamedDocuments(quickReplyEntries),
        instruct,
        context,
        sysprompt,
        reasoning,
        enable_extensions: metadata.enable_extensions,
        enable_extensions_auto_update: metadata.enable_extensions_auto_update,
        enable_accounts: metadata.enable_accounts,
    };
}

export async function loadSettingsEnvelope({ bootstrap = false, signal } = {}) {
    const settingsDocument = await loadSettingsDocument({ signal });
    return buildSettingsEnvelopeFromDocument(settingsDocument, { bootstrap, signal });
}

/**
 * TASK-033 reroute: settings document via the kernel route
 * GET /api/uberge/settings ({settings:<doc>}) instead of POST /api/settings/get
 * or the /api/settings/fields granular channel. The envelope around the
 * document is identical to loadSettingsEnvelope's, so getSettings() consumers
 * see no shape change.
 */
export async function loadUbergeSettingsEnvelope({ bootstrap = false, signal } = {}) {
    const response = await fetch('/api/uberge/settings', {
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { Accept: 'application/json' },
        signal,
    });
    if (!response.ok) {
        throw new Error(`uberge settings read failed with HTTP ${response.status}`);
    }
    const payload = await response.json();
    const settingsDocument = (payload?.settings && typeof payload.settings === 'object' && !Array.isArray(payload.settings))
        ? payload.settings
        : {};
    return buildSettingsEnvelopeFromDocument(settingsDocument, { bootstrap, signal });
}
