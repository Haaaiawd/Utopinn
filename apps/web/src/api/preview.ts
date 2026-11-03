// POST /api/uberge/preview — dry-run prompt assembly (uberge-generate.js:123).
// Returns {messages, trace, sources}; feeds the prompt-viewer/diagnostics face.
import { ApiError, apiPost } from './client';
import { mockPreviewResponse } from './mock';
import type { PreviewRequestBody, PreviewResponse, PreviewResult } from '../types';

export async function postPreview(body: PreviewRequestBody): Promise<PreviewResponse> {
    return apiPost<PreviewResponse>('/api/uberge/preview', body);
}

/**
 * Preview with honest fallback: when the server is unreachable the caller
 * gets clearly-labelled mock data so the skeleton stays demonstrable.
 * Real HTTP/CSRF errors (400/404/500) still surface as errors — only network
 * failure triggers the mock path.
 */
export async function postPreviewWithFallback(body: PreviewRequestBody): Promise<PreviewResult> {
    try {
        const data = await postPreview(body);
        return { data, mock: false };
    } catch (error) {
        // Unreachable server → labelled mock. TypeError = fetch-level network
        // failure; ApiError(502) = dev-proxy marked upstream down.
        const unreachable = error instanceof TypeError ||
            (error instanceof ApiError && error.status === 502);
        if (!unreachable) {
            return { data: null, mock: false, error: error instanceof Error ? error.message : String(error) };
        }
        return { data: mockPreviewResponse(body), mock: true };
    }
}
