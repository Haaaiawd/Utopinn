/**
 * Per-card CSP builder (node:test).
 * 跑法:node --test tests/card-runtime-csp.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCardRuntimeCsp, cardRuntimeSecurityHeaders } from '../src/card-runtime/csp.js';

const ORIGIN = 'http://127.0.0.1:8000';

function directives(csp) {
    return Object.fromEntries(csp.split(';').map(d => d.trim().split(/\s+/)[0]).map((k, i) => [k, csp.split(';')[i].trim()]));
}

test('default policy: sandbox + path-scoped runtime only', () => {
    const csp = buildCardRuntimeCsp({ selfOrigin: ORIGIN, permissions: {} });
    const d = directives(csp);

    assert.match(d['sandbox'], /^sandbox allow-scripts allow-modals allow-downloads$/);
    assert.match(d['sandbox'], /^(?!.*allow-same-origin).*$/);
    assert.match(d['default-src'], /'none'/);
    assert.match(d['script-src'], new RegExp(`${ORIGIN.replace(/\./g, '\\.')}/card-runtime/`));
    assert.match(d['script-src'], /'unsafe-inline'/);
    assert.match(d['script-src'], /'wasm-unsafe-eval'/);
    assert.ok(!/media-src/.test(csp));
    assert.match(d['connect-src'], new RegExp(`^connect-src ${ORIGIN.replace(/\./g, '\\.')}/card-runtime/`));
    assert.ok(!d['connect-src'].includes('/api/'), 'connect-src must not reach session API paths');
    assert.match(d['frame-src'], /'none'/);
    assert.match(d['object-src'], /'none'/);
    assert.match(d['base-uri'], /'none'/);
    assert.match(d['frame-ancestors'], new RegExp(ORIGIN.replace(/\./g, '\\.')));
    // no eval anywhere ('wasm-unsafe-eval' is wasm compilation, not eval)
    assert.ok(!/'unsafe-eval'/.test(csp));
    // remote origins are never direct sources — only via the proxy path
    assert.ok(!/https?:\/\/cdn|jsdelivr|unpkg/.test(csp));
});

test('inlineScript:false removes unsafe-inline', () => {
    const csp = buildCardRuntimeCsp({ selfOrigin: ORIGIN, permissions: { inlineScript: false } });
    assert.ok(!/'unsafe-inline'/.test(directives(csp)['script-src']));
    // style keeps unsafe-inline (style attributes are universal in card HTML)
    assert.match(directives(csp)['style-src'], /'unsafe-inline'/);
});

test('media:true adds media-src', () => {
    const csp = buildCardRuntimeCsp({ selfOrigin: ORIGIN, permissions: { media: true } });
    assert.match(directives(csp)['media-src'], new RegExp(ORIGIN.replace(/\./g, '\\.')));
});

test('sameOrigin:true adds allow-same-origin token', () => {
    const csp = buildCardRuntimeCsp({ selfOrigin: ORIGIN, permissions: { sameOrigin: true } });
    assert.match(directives(csp)['sandbox'], /allow-same-origin/);
});

test('security headers: opaque-origin/CORP/CORS posture', () => {
    const h = cardRuntimeSecurityHeaders({ selfOrigin: ORIGIN, permissions: {} });
    assert.equal(h['Access-Control-Allow-Origin'], '*');
    assert.equal(h['Cross-Origin-Resource-Policy'], 'cross-origin');
    assert.equal(h['X-Content-Type-Options'], 'nosniff');
    assert.equal(h['Referrer-Policy'], 'no-referrer');
    assert.match(h['Permissions-Policy'], /camera=\(\)/);
    assert.match(h['Content-Security-Policy'], /sandbox allow-scripts/);
});
