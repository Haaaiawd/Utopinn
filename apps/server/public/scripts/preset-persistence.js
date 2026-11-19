import { getRequestHeaders } from '../script.js';

/**
 * Saves a preset to the server with a full write.
 *
 * @param {object} options
 * @param {string} options.apiId
 * @param {string} options.name
 * @param {object} options.preset
 * @returns {Promise<{ ok: boolean, response: Response, data: any, mode: 'full', operations: [] }>}
 */
export async function persistPreset(options) {
    const apiId = String(options?.apiId || '').trim();
    const name = String(options?.name || '').trim();
    const preset = options?.preset && typeof options.preset === 'object' && !Array.isArray(options.preset)
        ? options.preset
        : {};

    // TASK-033 reroute: legacy /api/presets/save → PUT /api/utopinn/presets/:name
    // (apiId moves to a query param; the preset doc IS the request body).
    const response = await fetch(`/api/utopinn/presets/${encodeURIComponent(name)}?apiId=${encodeURIComponent(apiId)}`, {
        method: 'PUT',
        headers: getRequestHeaders(),
        body: JSON.stringify(preset),
    });

    const data = response.ok ? await response.json() : null;
    return {
        ok: response.ok,
        response,
        data,
        mode: 'full',
        operations: [],
    };
}
