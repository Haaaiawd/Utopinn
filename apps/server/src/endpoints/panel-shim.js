// Serves the card-panel shim runtime to panel hosts (RN WebView / web iframe).
// `GET /api/panel-shim/t0.js` → the TH-face T0 IIFE, verbatim from
// @utopinn/panel-shim. Cached in-process; ETag'd by content hash.
import express from 'express';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

export const router = express.Router();

let cache = null;

function loadRuntime() {
    if (cache) return cache;
    const require = createRequire(import.meta.url);
    const pkgDir = path.dirname(require.resolve('@utopinn/panel-shim/package.json'));
    const source = readFileSync(path.join(pkgDir, 'src', 'runtime.js'), 'utf8');
    const etag = `W/"${createHash('sha256').update(source).digest('hex').slice(0, 24)}"`;
    cache = { source, etag };
    return cache;
}

router.get('/t0.js', (request, response) => {
    try {
        const { source, etag } = loadRuntime();
        if (request.headers['if-none-match'] === etag) {
            return response.status(304).end();
        }
        response.set({
            'Content-Type': 'application/javascript; charset=utf-8',
            'Cache-Control': 'no-cache',
            'ETag': etag,
            'X-Content-Type-Options': 'nosniff',
        });
        return response.send(source);
    } catch (error) {
        console.error('panel-shim runtime unavailable:', error);
        return response.status(500).send({ error: 'panel-shim runtime unavailable' });
    }
});
