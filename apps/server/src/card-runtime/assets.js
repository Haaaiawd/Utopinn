/**
 * Card asset serving — card-embedded html/css/js/images extracted to the
 * per-card directory, addressed inside the mount space
 * `/card-runtime/m/<id>/<asset path>` so relative references (`./lib/x.js`,
 * `img/a.png`) resolve under the mount without any rewriting.
 *
 * Entry contract:
 *   - document entry (`entry: 'panel.html'`) → served verbatim at its own
 *     path; `/m/<id>/` redirects there.
 *   - module entry (`entry: 'index.js'`, Luker convention) → `/m/<id>/`
 *     serves a synthesized shell: minimal document + optional `style.css`
 *     auto-link + `<script type="module">`. The ctx/TH bridge is NOT injected
 *     here — the host mints the bridge nonce and injects the shim (or passes
 *     `?shim=t0` to have the server splice the shim tag before card code).
 *
 * Every response on this surface carries the per-card CSP + the opaque-origin
 * headers from csp.js — including non-document assets, harmlessly.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import mime from 'mime-types';
import { createRequire } from 'node:module';
import { resolveAssetPath, entryFileExists } from './mounts.js';
import { cardRuntimeSecurityHeaders } from './csp.js';

/**
 * Server-shim names the ?shim= knob may splice into entry documents.
 * 'face' is the bridge contract the shim implements — the bootstrap JSON and
 * (for module entries) the init-caller follow it:
 *   t0  → TH-face T0 table (panel-shim runtime.js, th.* wire methods)
 *   ctx → Luker ctx face (panel-shim ctx-shim.js, ctx.* wire methods + init caller)
 */
const SHIM_URLS = new Map([
    ['t0', { url: '/card-runtime/shim/t0.js', face: 'th' }],
    ['ctx', { url: '/card-runtime/shim/ctx.js', face: 'ctx' }],
]);

function selfOrigin(request) {
    return `${request.protocol}://${request.get('host')}`;
}

function setSecurityHeaders(request, response, mount) {
    const headers = cardRuntimeSecurityHeaders({
        selfOrigin: selfOrigin(request),
        permissions: mount.manifest.permissions,
    });
    for (const [k, v] of Object.entries(headers)) response.set(k, v);
}

/**
 * Per-shim bridge bootstrap -- nonce + face + ctx seeds, emitted before the
 * shim source so card code can read but not forge the bridge identity.
 * @param {object} mount
 * @param {{face:string}} shimSpec
 */
function bootstrapTag(mount, shimSpec) {
    if (!mount?.bridgeNonce) return '';
    return `<script data-card-runtime-bootstrap>window.__UTOPINN_PANEL_NONCE__=${JSON.stringify(mount.bridgeNonce)};window.__UTOPINN_PANEL_BOOTSTRAP__=${JSON.stringify({
        face: shimSpec.face,
        mountId: mount.id,
        charId: mount.charId,
        chatName: mount.chatName ?? undefined,
        entry: mount.manifest?.entry,
        assetBase: `/card-runtime/m/${mount.id}/`,
        stateNamespaces: mount.manifest?.permissions?.stateNamespaces ?? [],
        initializedGlobals: [],
    })};</script>`;
}

/**
 * Splice a <script src> shim tag as early as possible -- before card code.
 * @param {string} html
 * @param {{url:string,face:string}} shimSpec
 */
export function injectShimTag(html, shimSpec, mount) {
    // bridge bootstrap 先于 shim 源下发:nonce 由 mount 服务端持有,卡代码
    // 可读但不可伪造来源(ev.source / RN 侧 nonce 校验各自消费)。
    const bootstrap = bootstrapTag(mount, shimSpec);
    const tag = `${bootstrap}<script src="${shimSpec.url}" data-card-runtime-shim></script>`;
    const head = html.match(/<head[^>]*>/i);
    if (head) {
        const at = head.index + head[0].length;
        return `${html.slice(0, at)}${tag}${html.slice(at)}`;
    }
    const htmlTag = html.match(/<html[^>]*>/i);
    if (htmlTag) {
        const at = htmlTag.index + htmlTag[0].length;
        return `${html.slice(0, at)}<head>${tag}</head>${html.slice(at)}`;
    }
    return `${tag}${html}`;
}

/**
 * Synthesized shell for ES-module entries (Luker CardApp convention:
 * module exports init(ctx); style.css in the same folder is auto-loaded).
 * ctx face(?shim=ctx)时附加 init-caller:等 ctx-shim 把 __CARDAPP_CTX__
 * 挂好(含 varCache/chatCache 种子)再 invoke module.init(ctx)——
 * 否则 module 只是裸脚本,export 的 init 永远不跑(掌门卡即此病)。
 * @param {object} mount
 * @param {{url:string,face:string}|null} shimSpec
 */
export function buildModuleShell(mount, shimSpec = null) {
    const entryDir = path.posix.dirname(mount.manifest.entry);
    const stylePath = entryDir === '.' ? 'style.css' : `${entryDir}/style.css`;
    const hasStyle = !!resolveAssetPath(mount, stylePath);
    // module 入口与 document 同待遇:shim 前下发 bootstrap(nonce+face),
    // 否则宿主 nonce 门全拒——桥死。
    const shim = shimSpec ? `${bootstrapTag(mount, shimSpec)}<script src="${shimSpec.url}" data-card-runtime-shim></script>
` : '';
    const style = hasStyle ? `<link rel="stylesheet" href="./${stylePath}">` : '';
    const entryRef = JSON.stringify(`./${mount.manifest.entry}`);
    const initCaller = shimSpec?.face === 'ctx'
        ? `<script type="module" data-card-runtime-init>
  const __mod = await import(${entryRef});
  const __ctx = window.__CARDAPP_CTX__;
  if (__ctx && typeof __mod?.init === 'function') {
    try { await __ctx.__ready; } catch { /* 种子失败不拦 init */ }
    try { await __mod.init(__ctx); window.__CARDAPP_INIT__ = { ok: true }; }
    catch (err) { window.__CARDAPP_INIT__ = { ok: false, error: String(err?.stack || err) }; console.error('[card-runtime] init(ctx) failed:', err); }
  } else {
    window.__CARDAPP_INIT__ = { ok: false, error: __mod?.init ? 'ctx_shim_missing' : 'no_init_export' };
  }
</script>`
        : '';
    const moduleTag = initCaller ? '' : `<script type="module" src="./${mount.manifest.entry}"></script>`;
    return [
        '<!doctype html>',
        '<html>',
        '<head>',
        '<meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width, initial-scale=1">',
        '<meta name="referrer" content="no-referrer">',
        `<title>${escapeHtml(mount.charId)} · card app</title>`,
        shim + style,
        '</head>',
        '<body>',
        '<div id="card-app-container"></div>',
        moduleTag || initCaller,
        '</body>',
        '</html>',
    ].filter(Boolean).join('\n');
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * TH「前端界面」楼层文档壳 —— JSR createSrcContent(panel/render/iframe.ts)
 * 的最小等价物:重置样式 + 基座 + 内容本体 + 自动高度上报。
 * TH 注入 jQuery/Vue/tailwind CDN 与 predefine(TH 全局)——我们的 TH 面由
 * ?shim=t0 拼接(bridge nonce + TH API 桥),CDN 依赖交卡自理(走 /cdn 代理)。
 *
 * 高度:卡内脚本 post {type:'utopinn-msgframe-height', height} →
 * 宿主 MessageIframe 调 iframe 高(TH adjust_iframe_height 同语义)。
 */
const MSGFRAME_AUTOHEIGHT = `<script data-card-runtime-autoheight>
(function () {
  var last = -1;
  function post() {
    try {
      var h = Math.max(
        document.body ? document.body.scrollHeight : 0,
        document.documentElement ? document.documentElement.scrollHeight : 0);
      if (h !== last) { last = h; parent.postMessage({ type: 'utopinn-msgframe-height', height: h }, '*'); }
    } catch (e) { /* opaque 父页无法读 DOM 时只能由我们推 */ }
  }
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(post).observe(document.documentElement);
  }
  window.addEventListener('load', post);
  document.addEventListener('DOMContentLoaded', post);
  setTimeout(post, 50); setTimeout(post, 300); setTimeout(post, 1200);
})();
</script>`;

/**
 * 楼层前端块 → 完整文档。TH 恒把块内容注进 <body>(整块是完整 HTML
 * 文档的卡也同待遇 —— 浏览器容错解析,与 JSR createSrcContent 同行为)。
 */
export function buildMessageDoc(content) {
    return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<base target="_blank">
<style>
*,*::before,*::after{box-sizing:border-box;}
html,body{margin:0!important;padding:0!important;max-width:100%!important;}
</style>
</head>
<body>
${String(content ?? '')}
${MSGFRAME_AUTOHEIGHT}
</body>
</html>`;
}

function sendDocument(request, response, mount, body) {
    setSecurityHeaders(request, response, mount);
    const etag = `W/"${crypto.createHash('sha256').update(body).digest('hex').slice(0, 24)}"`;
    if (request.headers['if-none-match'] === etag) return response.status(304).end();
    response.set({
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'private, no-cache, max-age=1',
        'Vary': 'Cookie',
        'ETag': etag,
    });
    return response.send(body);
}

/**
 * `GET /m/:id/` — entry document: redirect for document entries, synthesized
 * shell for module entries. `?shim=t0|ctx` splices the shim tag for hosts that
 * cannot inject before card scripts (ctx also drives the module init-caller).
 */
export function entryHandler(request, response) {
    const mount = request.cardRuntimeMount;
    // TH「前端界面」楼层文档:mount 自带 doc,默认拼 t0(TH 面)。
    if (mount.kind === 'message') {
        const shimSpec = SHIM_URLS.get(String(request.query.shim || 't0')) || SHIM_URLS.get('t0');
        return sendDocument(request, response, mount, injectShimTag(mount.doc, shimSpec, mount));
    }
    const shimSpec = SHIM_URLS.get(String(request.query.shim || '')) || null;
    if (mount.manifest.entryKind === 'document') {
        const target = `./${mount.manifest.entry}${shimSpec ? '?shim=' + encodeURIComponent(String(request.query.shim)) : ''}`;
        return response.redirect(302, target);
    }
    if (!entryFileExists(mount)) {
        return response.status(404).json({ error: 'entry_not_found' });
    }
    return sendDocument(request, response, mount, buildModuleShell(mount, shimSpec));
}

/**
 * `GET /m/:id/*` — any file inside the card's asset dir. HTML documents get
 * the document treatment (CSP + optional shim splice); everything else is a
 * byte asset with ETag revalidation.
 */
export function assetHandler(request, response) {
    const mount = request.cardRuntimeMount;
    const relPath = request.params[0] || '';
    if (relPath === 'cdn' || relPath.startsWith('cdn/')) {
        return response.status(404).json({ error: 'reserved_prefix' });
    }
    const fullPath = resolveAssetPath(mount, relPath);
    if (!fullPath || !fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
        return response.status(404).json({ error: 'asset_not_found' });
    }

    setSecurityHeaders(request, response, mount);
    const ext = path.extname(fullPath).toLowerCase();
    if (ext === '.html' || ext === '.htm') {
        let body = fs.readFileSync(fullPath, 'utf8');
        const shimSpec = SHIM_URLS.get(String(request.query.shim || '')) || null;
        if (shimSpec) body = injectShimTag(body, shimSpec, mount);
        return sendDocument(request, response, mount, body);
    }

    const contentType = mime.lookup(fullPath) || 'application/octet-stream';
    const stat = fs.statSync(fullPath);
    const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
    if (request.headers['if-none-match'] === etag) return response.status(304).end();
    response.set({
        'Content-Type': contentType,
        'Content-Length': stat.size,
        'Cache-Control': 'private, no-cache, max-age=1',
        'Vary': 'Cookie',
        'ETag': etag,
    });
    return response.sendFile(fullPath);
}

// ---------- host-side shim (public, session-free) ----------
// TH-face T0 runtime + ctx-face runtime from @utopinn/panel-shim, re-served on
// the public surface so WebViews without a session can load it (mirrors
// endpoints/panel-shim.js, which stays on the authenticated side for admin use).

const SHIM_FILES = new Map([
    ['t0.js', 'runtime.js'],
    ['t0', 'runtime.js'],
    ['ctx.js', 'ctx-shim.js'],
    ['ctx', 'ctx-shim.js'],
]);

const shimCache = new Map();

function loadShimRuntime(file) {
    if (shimCache.has(file)) return shimCache.get(file);
    const require = createRequire(import.meta.url);
    const pkgDir = path.dirname(require.resolve('@utopinn/panel-shim/package.json'));
    const source = fs.readFileSync(path.join(pkgDir, 'src', file), 'utf8');
    const etag = `W/"${crypto.createHash('sha256').update(source).digest('hex').slice(0, 24)}"`;
    const entry = { source, etag };
    shimCache.set(file, entry);
    return entry;
}

/** `GET /shim/:name` -- allowlisted host-side scripts (t0 = TH-face, ctx = ctx-face). */
export function shimHandler(request, response) {
    const file = SHIM_FILES.get(request.params.name);
    if (!file) {
        return response.status(404).json({ error: 'unknown_shim' });
    }
    try {
        const { source, etag } = loadShimRuntime(file);
        if (request.headers['if-none-match'] === etag) return response.status(304).end();
        response.set({
            'Content-Type': 'application/javascript; charset=utf-8',
            'Cache-Control': 'public, max-age=3600, must-revalidate',
            'ETag': etag,
            'X-Content-Type-Options': 'nosniff',
            'Access-Control-Allow-Origin': '*',
            'Cross-Origin-Resource-Policy': 'cross-origin',
        });
        return response.send(source);
    } catch (error) {
        console.error('[card-runtime] shim runtime unavailable:', error);
        return response.status(500).json({ error: 'shim_unavailable' });
    }
}
