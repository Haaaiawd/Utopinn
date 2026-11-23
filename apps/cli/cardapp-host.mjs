/**
 * cardapp-host — headless CardApp 宿主(.skeinn/design/headless-cardapp-harness.md)。
 *
 * 同一份 wire 契约做参照实现:nonce + 方法白名单 + requestId 台账,
 * 传输层退化为进程内函数调用(shim 自带 __utopinnPanelPost/Receive 钩子)。
 * dispatch 复合:T0 走 api-client createPanelT0Handler,其余 th.* 透传
 * /api/utopinn/th/call(unsupported → 'unsupported_method' wire 码,
 * 与 apps/web ctxApi.ts:44 同码)。
 *
 * 两类卡源 × 两种入口,正交:
 *   卡源 A(server charDir):POST /api/card-runtime/mounts → 能力 URL 资产空间
 *   卡源 B(--card 文件):PNG/charx/JSON → card_app.files 内存图,nonce 自铸
 *   document 入口:JSDOM(html) + beforeParse(bootstrap→stubs→shim)→ 卡 <script>
 *   module 入口:合成壳 + esbuild bundle(cjs)+ 显式 init(ctx)——Luker loader
 *   约定,web 宿主目前缺的正是这一步(设计 §0-1)。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';

// ─── 懒加载依赖(jsdom/esbuild 只在 cardapp 动词进程里付费)─────────────────
// UTOPINN_CARDAPP_DEPS_DIR:重依赖(jsdom/esbuild)的快速路径目录。
// 9P/NFS 场景把热包拷到本地盘后指过来:depsDir/node_modules/{jsdom,esbuild}
// ——包内相对引用跟着落在同棵树下,绕开远端挂载的逐文件延迟。
let deps = null;
function depsDirImport(name) {
    const dir = process.env.UTOPINN_CARDAPP_DEPS_DIR;
    if (!dir) return null;
    const req = createRequire(path.join(dir, 'node_modules', '_probe.cjs'));
    const entry = req.resolve(name);
    return import(pathToFileURL(entry).href);
}
async function loadDeps() {
    if (deps) return deps;
    const missing = [];
    const load = async (name, fastPath = false) => {
        if (fastPath) {
            try { const m = depsDirImport(name); if (m) return await m; } catch { /* 落到裸 specifier */ }
        }
        try { return await import(name); } catch (e) { missing.push(`${name}: ${e?.message ?? e}`); return null; }
    };
    const jsdom = await load('jsdom', true);
    const esbuild = await load('esbuild', true);
    const protocol = await load('@utopinn/protocol');
    const formats = await load('@utopinn/formats');
    const apiClient = await load('@utopinn/api-client');
    if (!jsdom || !protocol || !apiClient) {
        const err = new Error(
            'cardapp harness 缺依赖(jsdom/@utopinn/protocol/@utopinn/api-client): '
            + missing.join(' | '),
        );
        err.code = 'harness_missing';
        err.detail = { missing, hint: 'pnpm install --filter @utopinn/cli(jsdom 已 pin 进 apps/cli/package.json);装过仍缺 → 根目录 pnpm install --force(reset/clean 后快路径可能不补 workspace 链接)' };
        throw err;
    }
    // esbuild 只在 module 入口用——缺席不拦 document 卡,mount 时才炸
    deps = {
        JSDOM: jsdom.JSDOM,
        requestInterceptor: jsdom.requestInterceptor,   // jsdom≥26:ResourceLoader→undici interceptor
        VirtualConsole: jsdom.VirtualConsole,
        CookieJar: jsdom.CookieJar,
        esbuild,
        protocol,
        formats,
        UtopinnClient: apiClient.UtopinnClient,
        createPanelT0Handler: apiClient.createPanelT0Handler,
        PanelBridge: apiClient.PanelBridge,
    };
    return deps;
}

// ─── wire 层已上收共享包(耦合格调研 §5.1–5.3;原此处三份同构实现之 CLI 份)───
//   expandApiGrants / isPanelRequestData / toWireError → @utopinn/protocol
//     panel-wire.ts(CLI 走全 ctx 面语义 —— 不传 surfaceOnlyCtx)
//   PanelBridge → @utopinn/api-client panel-bridge.ts;进程内传输 seam:
//     normalize=jsonClone(① 斩断跨 realm 引用 ② 落实"wire 可序列化")
//     encodeResult=jsonClone(result) ?? null,send=__utopinnPanelReceive 直递。
// ev.source 门退化为"传输唯一性"(设计 §3b):能调 __utopinnPanelPost 的
// 只有被注入该函数的 realm。isPanelMethod 注入随之取消——共享 shape 门
// (isPanelRequestData)内嵌同一 ALL_PANEL_METHODS 白名单。
const jsonClone = (v) => v === undefined ? undefined : JSON.parse(JSON.stringify(v));

// ─── jsdom 缺口桩表(设计 §1;卡码运行前注入)────────────────────────────────
function installDomStubs(window) {
    const noop = () => { };
    // matchMedia:恒不匹配(桌面布局),注册不回调
    if (typeof window.matchMedia !== 'function') {
        window.matchMedia = (q) => ({
            matches: false, media: String(q), onchange: null,
            addEventListener: noop, removeEventListener: noop,
            addListener: noop, removeListener: noop, dispatchEvent: () => false,
        });
    }
    for (const name of ['ResizeObserver', 'IntersectionObserver']) {
        if (typeof window[name] !== 'function') {
            window[name] = class {
                constructor() { }
                observe() { } unobserve() { } disconnect() { }
            };
        }
    }
    if (typeof window.requestAnimationFrame !== 'function') {
        window.requestAnimationFrame = (fn) => window.setTimeout(() => fn(Date.now()), 16);
        window.cancelAnimationFrame = (id) => window.clearTimeout(id);
    }
    if (typeof window.requestIdleCallback !== 'function') {
        window.requestIdleCallback = (fn) => window.setTimeout(() => fn({ didTimeout: false, timeRemaining: () => 50 }), 0);
    }
    try { window.Element.prototype.scrollIntoView = window.Element.prototype.scrollIntoView || noop; } catch { }
    window.scrollTo = window.scrollTo || noop;
    window.scrollBy = window.scrollBy || noop;
    if (!window.visualViewport) {
        window.visualViewport = {
            width: window.innerWidth, height: window.innerHeight,
            addEventListener: noop, removeEventListener: noop, onresize: null,
        };
    }
    // fullscreen 面:缺席即可,但 stub 成 no-op 更省事(卡 .?. 防御也能活)
    try {
        if (!('fullscreenElement' in window.document)) window.document.fullscreenElement = null;
        window.document.exitFullscreen = window.document.exitFullscreen || (() => Promise.resolve());
        window.HTMLElement.prototype.requestFullscreen = window.HTMLElement.prototype.requestFullscreen || (() => Promise.resolve());
    } catch { }
    window.alert = window.alert || noop;
    window.confirm = window.confirm || (() => false);
    window.prompt = window.prompt || (() => null);
    window.open = window.open || (() => null);
    // 顶层姿态:parent===self(不造 iframe 宿主幻视)
    try { window.top = window; window.parent = window; } catch { }
}

// ─── 资产解析器(两类卡源统一接口;设计 §2 AssetResolver)────────────────────
class AssetResolver {
    /** @param opts {kind:'server'|'local', serverBase, mountId, files?, allowlist, client} */
    constructor(opts) {
        this.kind = opts.kind;
        this.serverBase = (opts.serverBase ?? '').replace(/\/+$/, '');
        this.mountId = opts.mountId;
        this.files = opts.files ?? null;                 // local: path → Buffer|string
        this.allowlist = opts.allowlist ?? [];           // [{kind:'exact'|'prefix',value}]
        this.fetchImpl = opts.fetchImpl ?? fetch;
        this.assetBasePath = `/card-runtime/m/${opts.mountId}/`;
        this.cdnPath = `${this.assetBasePath}cdn`;
    }
    absUrl(rel) { return `${this.serverBase}${this.assetBasePath}${rel}`; }

    /**
     * resolve(relPath) → {bytes, contentType} | null
     * 相对路径进卡资产空间;命中 allowlist 的 http(s) 进 CDN 代理(server)
     * 或宿主直取(local 卡源,语义=代理解)。
     */
    async resolve(relPath) {
        relPath = String(relPath ?? '').replace(/\\/g, '/').replace(/^\.?\//, '');
        if (!relPath || relPath.split('/').includes('..')) return null;
        if (this.kind === 'local') {
            const v = this.files?.[relPath];
            if (v === undefined || v === null) return null;
            return { bytes: Buffer.isBuffer(v) ? v : Buffer.from(v, 'utf8'), contentType: mimeOf(relPath) };
        }
        const r = await this.fetchImpl(this.absUrl(relPath));
        if (!r.ok) return null;
        return { bytes: Buffer.from(await r.arrayBuffer()), contentType: r.headers.get('content-type') ?? mimeOf(relPath) };
    }

    /** manifest network.allowlist 判(manifest.js isAdmittedByAllowlist 同语义)。 */
    admitted(url) {
        return this.allowlist.some(rule =>
            rule.kind === 'exact' ? url === rule.value : url.startsWith(rule.value));
    }

    /**
     * 外部 URL → 取回字节的渠道。
     * server 卡源:重写到 mount CDN 代理(GET /m/<id>/cdn?url=)。
     * local 卡源:宿主直取(卡 realm 绝无直连凭据——字节由宿主转交,凭据不出界)。
     */
    async resolveExternal(url) {
        if (!this.admitted(url)) return null;
        if (this.kind === 'local') {
            const r = await this.fetchImpl(url).catch(() => null);
            if (!r?.ok) return null;
            return { bytes: Buffer.from(await r.arrayBuffer()), contentType: r.headers.get('content-type') ?? 'application/octet-stream' };
        }
        const proxied = `${this.serverBase}${this.cdnPath}?url=${encodeURIComponent(url)}`;
        const r = await this.fetchImpl(proxied);
        if (!r.ok) return null;
        return { bytes: Buffer.from(await r.arrayBuffer()), contentType: r.headers.get('content-type') ?? 'application/octet-stream' };
    }
}

function mimeOf(p) {
    const ext = path.posix.extname(String(p).split('?')[0]).toLowerCase();
    return {
        '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
        '.js': 'application/javascript; charset=utf-8', '.mjs': 'application/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
        '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
        '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
        '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
        '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.mp4': 'video/mp4', '.txt': 'text/plain; charset=utf-8',
    }[ext] ?? 'application/octet-stream';
}

/** jsdom resources 收口点:<script src>/<link>/<img>/fetch/XHR 全从这里过(设计 §2)。
 * jsdom≥26 形态:resources:{interceptors:[requestInterceptor(fn)]},
 * fn(request,{element}) → Response 合成返回 | undefined 放行。 */
function makeResourcesOption(requestInterceptor, resolver, mountOrigin) {
    const toResponse = (r, fallbackType) => {
        if (!r) return new Response(null, { status: 404, statusText: 'mount asset not found' });
        return new Response(r.bytes, {
            status: 200,
            headers: { 'content-type': r.contentType ?? fallbackType },
        });
    };
    const notFound = () => new Response(null, { status: 404, statusText: 'denied by mount resolver' });
    const intercept = requestInterceptor(async (request) => {
        try {
            const u = new URL(request.url, mountOrigin);
            const mountO = new URL(mountOrigin).origin;
            if (u.origin === mountO && u.pathname.startsWith(resolver.cdnPath)) {
                return toResponse(await resolver.resolveExternal(u.searchParams.get('url')), 'application/octet-stream');
            }
            if (u.origin === mountO && u.pathname.startsWith(resolver.assetBasePath)) {
                const rel = decodeURIComponent(u.pathname.slice(resolver.assetBasePath.length));
                return toResponse(await resolver.resolve(rel), mimeOf(rel));
            }
            if (u.protocol === 'http:' || u.protocol === 'https:') {
                return resolver.admitted(u.toString())
                    ? toResponse(await resolver.resolveExternal(u.toString()), 'application/octet-stream')
                    : notFound();
            }
            return undefined;   // data:/blob:/about: 放行(jsdom 自持)
        } catch {
            return notFound();
        }
    });
    return { interceptors: [intercept] };
}

// ─── 本地卡源(--card png|charx|json)───────────────────────────────────────
async function loadLocalCardSource(file, { formats, serverManifestMod }) {
    const abs = path.resolve(file);
    const buf = fs.readFileSync(abs);
    const ext = path.extname(abs).toLowerCase();
    let card;
    if (ext === '.png') {
        card = JSON.parse(formats.readCardFromPng(new Uint8Array(buf)));
    } else if (ext === '.charx') {
        const parser = new formats.CharXParser(new Uint8Array(buf));
        card = await parser.parse();
        card = card?.card ?? card;
    } else {
        card = JSON.parse(buf.toString('utf8'));
    }
    const { getRawCardApp, parseCardAppManifest } = serverManifestMod;
    const { ok, errors, warnings, manifest } = parseCardAppManifest(card);
    if (!ok || !manifest) {
        const e = new Error(`--card 的 card_app manifest 校验失败: ${errors.join('; ')}`);
        e.code = 'invalid_card_app_manifest';
        e.detail = { errors, warnings };
        throw e;
    }
    if (!manifest.enabled) {
        const e = new Error('--card 的 card_app 被禁用(enabled:false)');
        e.code = 'card_app_disabled';
        throw e;
    }
    const rawFiles = getRawCardApp(card)?.files ?? {};
    const files = {};
    for (const [p, v] of Object.entries(rawFiles)) {
        if (typeof v !== 'string') continue;
        const b64 = v.match(/^data:[^;]+;base64,(.+)$/s);
        files[p] = b64 ? Buffer.from(b64[1], 'base64') : v;
    }
    return { card, manifest, warnings, files };
}

// ─── mount 主流程 ──────────────────────────────────────────────────────────
/**
 * mountCardApp({ server, charDir, chatName, card?, user?, timeoutMs?,
 *               mountTtlMs?, settleMs?, withParentDoc?, surface? })
 *   surface = { panelType?, openPanel?, collapsePanels? } —— 卡「表面可见性」
 *   (ctx.surfaceOpen/surfaceClose)的壳接线,与 web ctxHost.ts 同一契约;
 *   缺席 → 如实 PANEL_SURFACE_UNAVAILABLE 降级。
 * → session handle { window, document, mount, face, grants, ctx, bridge,
 *                    eventSource, consoleLog, pushThEvent, pushCtxEvent,
 *                    evalInCard, callDispatch, subscribedEvents, syncChat,
 *                    runCardGeneration, dispose, warnings }
 */
const dbg = (() => {
    const t0 = Date.now();
    return (s) => { if (process.env.UTOPINN_CARDAPP_DEBUG) process.stderr.write(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}\n`); };
})();

export async function mountCardApp(opts) {
    dbg('loadDeps…');
    const D = await loadDeps();
    dbg('deps ok');
    const { protocol, UtopinnClient, createPanelT0Handler, PanelBridge } = D;
    const server = String(opts.server ?? '').replace(/\/+$/, '');
    const charDir = String(opts.charDir ?? '').trim();
    const chatName = String(opts.chatName ?? '').trim().replace(/\.jsonl$/i, '');
    const charId = charDir;   // ctx.charId/bootstrap.charId 语义 = charDir(server 角色目录名)
    if (!server || !charDir) {
        const e = new Error('mountCardApp 需要 server + charDir');
        e.code = 'usage'; throw e;
    }

    const client = new UtopinnClient({ baseUrl: server, timeoutMs: opts.timeoutMs ?? 30_000 });
    // 事件通道(TASK-049 对齐 ctxHost.ts):本 mount 写出的信箱条目 origin=hostId,
    // 自己的 pollMailbox 跳过防回流;doc 可推导事件(楼层增删/编辑/swipe/切聊)由
    // diffAndEmitChat 各端独立检测,doc 不可推导的(生成生命周期、卡 eventEmit)走信箱。
    const hostId = `h-${crypto.randomBytes(5).toString('hex')}`;
    let lastEventSeq = 0;
    let eventLogUnsupported = false;
    const recordThEvent = (name, args = []) =>
        client.th.call('eventEmit', {
            target: { charDir, chatName },
            args: { event: name, args: jsonClone(args) ?? [], origin: hostId },
        }).catch(() => { });
    const consoleLog = [];   // VirtualConsole 捕获:[{lvl,msg}]
    const pushConsole = (lvl, msg) => {
        consoleLog.push({ lvl, msg: String(msg).slice(0, 2000), at: Date.now() });
        if (consoleLog.length > 500) consoleLog.shift();
    };

    // ── 卡源与 manifest ──────────────────────────────────────────────────
    let mountId, bridgeNonce, manifest, warnings, resolver, entryUrlPath, assetBaseUrl;
    if (opts.card) {
        // 服务端纯函数文件零依赖,直接 ESM 复用——manifest 校验只此一份事实源
        const serverManifestMod = await import('../server/src/card-runtime/manifest.js');
        const local = await loadLocalCardSource(opts.card, { formats: D.formats, serverManifestMod });
        manifest = local.manifest;
        warnings = [...(local.warnings ?? [])];
        mountId = `local-${crypto.randomBytes(8).toString('hex')}`;
        bridgeNonce = crypto.randomBytes(16).toString('hex');
        resolver = new AssetResolver({
            kind: 'local', mountId,
            files: local.files,
            allowlist: manifest.permissions.network.allowlist,
        });
        // local 源资产空间只是寻址契约(不走 http),entry/assetBase 用同一 mountId 命名
        entryUrlPath = manifest.entryKind === 'document' ? `${resolver.assetBasePath}${manifest.entry}` : resolver.assetBasePath;
        assetBaseUrl = resolver.assetBasePath;
    } else {
        dbg('mounts POST…');
        const bundle = await client.request('/api/card-runtime/mounts', { method: 'POST', body: { charId: charDir } });
        dbg('mounts ok ' + bundle.mountId);
        mountId = bundle.mountId;
        bridgeNonce = bundle.bridgeNonce;
        manifest = bundle.manifest;
        warnings = [...(bundle.warnings ?? [])];
        resolver = new AssetResolver({
            kind: 'server', serverBase: server, mountId,
            allowlist: manifest?.permissions?.network?.allowlist ?? [],
        });
        entryUrlPath = bundle.entryUrl;
        assetBaseUrl = bundle.assetBaseUrl;
    }
    if (!manifest?.entry) {
        const e = new Error('mount bundle 缺 manifest.entry'); e.code = 'server'; throw e;
    }

    const grants = protocol.expandApiGrants(manifest.permissions?.api);
    const face = manifest.entryKind === 'module' ? 'ctx' : 'th';   // 约定:module 入口 = ctx 面(Luker loader 形)
    const mountOrigin = `${server}${resolver.assetBasePath}`;

    // ── shim 源(server shim handler 同源,或直接读包)──────────────────────
    // face → 契约(card-runtime/assets.js SHIM_URLS/SHIM_FILES 同表):
    //   th  → GET /card-runtime/shim/t0.js  = panel-shim/src/runtime.js
    //   ctx → GET /card-runtime/shim/ctx.js = panel-shim/src/ctx-shim.js
    const SHIM_SPECS = {
        th: { url: '/card-runtime/shim/t0.js', file: 'runtime.js' },
        ctx: { url: '/card-runtime/shim/ctx.js', file: 'ctx-shim.js' },
    };
    const shimSpec = SHIM_SPECS[face] ?? null;
    let shimSource = null;
    if (shimSpec) {
        try {
            const r = await fetch(`${server}${shimSpec.url}`);
            if (r.ok) shimSource = await r.text();
        } catch { /* fallthrough */ }
        if (!shimSource) {
            // 服务端 shim 面不可达 → 从已装面板包读(design:同一 runtime)
            try {
                const shimPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)),
                    `../../packages/panel-shim/src/${shimSpec.file}`);
                shimSource = fs.readFileSync(shimPath, 'utf8');
            } catch (e) {
                const err = new Error(`shim runtime 不可读: ${e?.message ?? e}`);
                err.code = 'harness_missing';
                err.detail = { hint: `server ${shimSpec.url} 与 packages/panel-shim 双路都失` };
                throw err;
            }
        }
    }

    // ── DOM:document 走真 html;module 用合成壳(复刻 buildModuleShell)────
    let html;
    if (manifest.entryKind === 'document') {
        const entry = await resolver.resolve(manifest.entry);
        if (!entry) {
            const e = new Error(`card_app entry "${manifest.entry}" 资产不可解`); e.code = 'not_found'; throw e;
        }
        html = entry.bytes.toString('utf8');
    } else {
        const entryDir = path.posix.dirname(manifest.entry);
        const stylePath = entryDir === '.' ? 'style.css' : `${entryDir}/style.css`;
        const hasStyle = !!(await resolver.resolve(stylePath).catch(() => null));
        html = [
            '<!doctype html>', '<html>', '<head>',
            '<meta charset="utf-8">',
            `<title>${charDir} · card app</title>`,
            hasStyle ? `<link rel="stylesheet" href="./${stylePath}">` : '',
            '</head>', '<body>',
            '<div id="card-app-container"></div>',
            '</body>', '</html>',
        ].filter(Boolean).join('\n');
    }

    const VirtualConsole = new D.VirtualConsole();
    VirtualConsole.on('log', (...a) => pushConsole('log', a.join(' ')));
    VirtualConsole.on('info', (...a) => pushConsole('info', a.join(' ')));
    VirtualConsole.on('warn', (...a) => pushConsole('warn', a.join(' ')));
    VirtualConsole.on('error', (...a) => pushConsole('error', a.join(' ')));
    VirtualConsole.on('jsdomError', (e) => pushConsole('jsdomError', e?.stack || e?.message || String(e)));

    // dispatch/push 先声明(beforeParse 闭包引用),bridge 在 dom 后填 receive。
    // 时序坑:runScripts:'dangerously' 让文档内 inline <script> 在 new JSDOM()
    // 构造期同步执行——此时 bridge 尚未造。卡→宿主消息入队,bridge 就位后 flush,
    // shim 的 pending promise 按 requestId 正常收敛。
    let bridge = null;
    const pendingInbound = [];
    const eventSource = new EventEmitter();
    eventSource.setMaxListeners(0);
    const stateNamespaces = manifest.permissions?.stateNamespaces ?? [];

    // dispatch:复合表(设计 §3c)
    const pushThEvent = (name, args) => {
        if (!panelT0?.subscribedEvents) return;
        const want = panelT0.subscribedEvents();
        if (!want.includes(name)) return;
        bridge?.push('th.event', { name, args: jsonClone(args) ?? [] });
    };
    // ctx 订阅记账(ctx.on 经桥登记;ctxHost.ts ctxSubscribed/emitCtx 同语义)。
    // 卡 realm 内 ctx.eventSource 只收 shim 分发的 'host.event' push——
    // 不经桥 emit 的话 generation_started 等泵全部死在宿主侧。
    const ctxSubscribed = new Set();
    const pushCtxEvent = (name, args = []) => {
        try { eventSource.emit(name, ...(Array.isArray(args) ? args : [args])); } catch (e) { pushConsole('warn', `eventSource emit ${name} threw: ${e?.message ?? e}`); }
        if (ctxSubscribed.has(name)) bridge?.push('host.event', { name, args: jsonClone(args) ?? [] });
    };

    let panelT0 = null;
    const dispatch = async (method, args) => {
        if (method.startsWith('th.')) {
            if (protocol.PANEL_METHODS_TH_T0.includes(method)) {
                return await panelT0(method, args);
            }
            // T1+:透传服务端 th/call(ctxApi.ts:33-49 同路)
            const res = await client.th.call(method.slice(3), {
                target: { charDir, chatName },
                args: args ?? {},
            });
            if (res?.unsupported) throw new Error(`unsupported_method: ${method.slice(3)}`);
            if (res?.ok === false) throw new Error(res?.error ?? `th_call_failed: ${method.slice(3)}`);
            return res?.result;
        }
        if (method.startsWith('ctx.')) {
            return await ctxDispatch(method.slice(4), args);
        }
        throw new Error(`unsupported_method: ${method}`);
    };

    // ── ctx 面:变量缓存 + chat 快照(§3d)──────────────────────────────────
    const avatarUrl = `${charDir}.png`;
    const chatFileName = `${chatName}.jsonl`;
    let chatDoc = null;         // {header, messages, integrity}
    let varCache = {};          // chat_metadata.variables 快照(ctx.getVariable 同步读)
    const syncChat = async () => {
        try {
            const doc = await client.library.chatGet(charDir, chatName);
            if (doc?.corrupted) return null;
            const prev = chatDoc;
            chatDoc = doc;
            varCache = doc?.header?.chat_metadata?.variables ?? {};
            await pollMailbox();   // 刷新顺带补信箱(ctxHost.pollChat 同拍)
            return { prev, next: doc };
        } catch (e) {
            pushConsole('warn', `syncChat failed: ${e?.message ?? e}`);
            return null;
        }
    };
    const getMessages = () => (Array.isArray(chatDoc?.messages) ? chatDoc.messages : []);

    /** 信箱泵(ctxHost.pollEventLog 同语义):拉新条目推订阅卡,跳过本 mount。 */
    const pollMailbox = async () => {
        if (eventLogUnsupported || !chatName) return;
        try {
            const res = await client.th.call('getEventLog', {
                target: { charDir, chatName },
                args: { since: lastEventSeq },
            });
            if (res?.unsupported) { eventLogUnsupported = true; return; }
            const result = res?.result;
            if (!result || typeof result !== 'object') return;
            if (typeof result.seq === 'number') lastEventSeq = Math.max(lastEventSeq, result.seq);
            for (const e of result.entries ?? []) {
                if (e?.origin && e.origin === hostId) continue;
                if (typeof e?.event === 'string' && e.event) pushThEvent(e.event, Array.isArray(e.args) ? e.args : []);
            }
        } catch { /* 信箱面缺席/抖动不致命 */ }
    };

    const disposeCallbacks = [];
    const trackedTimers = { intervals: new Set(), timeouts: new Set(), listeners: [] };

    // setExtensionPrompt → settingsDoc.extension_prompts[key](generate-context.js:461 消费面)
    const setExtensionPrompt = async (key, value, position, depth, scan, role) => {
        const escKey = String(key).replace(/~/g, '~0').replace(/\//g, '~1');
        const settings = await client.settingsGet().catch(() => null);
        const ops = [];
        if (!settings || typeof settings !== 'object' || settings.extension_prompts === undefined) {
            ops.push({ op: 'add', path: '/extension_prompts', value: {} });
        }
        ops.push({
            op: 'add', path: `/extension_prompts/${escKey}`,   // add=upsert;replace 在键缺席时 409
            value: { value: String(value ?? ''), position: position ?? -1, depth, scan: !!scan, role },
        });
        await client.settingsPatch(ops);
    };

    // WI 书源(§3d 五层口径简化版:chat/character/aux/global/persona)
    const getWorldBooks = async (options = {}) => {
        const out = [];
        const seen = new Set();
        const push = (name, source) => {
            name = String(name ?? '').trim();
            if (name && !seen.has(name)) { seen.add(name); out.push({ name, source }); }
        };
        const chatMeta = chatDoc?.header?.chat_metadata ?? {};
        const chatBound = Array.isArray(chatMeta.world_info) ? chatMeta.world_info : (chatMeta.world_info ? [chatMeta.world_info] : []);
        for (const n of chatBound) push(n, 'chat');
        try {
            const settings = await client.library.settings().catch(() => null);
            const wis = settings?.world_info_settings?.world_info ?? settings?.settings?.world_info_settings?.world_info;
            for (const n of wis?.globalSelect ?? []) push(n, 'global');
            for (const lore of wis?.charLore ?? []) {
                if (lore?.name === charDir) for (const n of lore.extraBooks ?? []) push(n, 'character_aux');
            }
            if (settings?.power_user?.persona_description_lorebook || settings?.settings?.power_user?.persona_description_lorebook) {
                push(settings?.power_user?.persona_description_lorebook ?? settings?.settings?.power_user?.persona_description_lorebook, 'persona');
            }
        } catch { }
        try {
            const charDoc = await client.library.char(charDir).catch(() => null);
            const card = charDoc?.card ?? charDoc;
            const world = card?.data?.extensions?.world;
            if (world) push(world, 'character');
        } catch { }
        return options?.withSource ? out : out.map(b => b.name);
    };
    const getWorldBookEntries = async (name) => {
        try { return await client.library.worldGet(String(name)); }
        catch { return null; }
    };
    const getSortedWiEntries = async () => {
        const books = await getWorldBooks({});
        const all = [];
        for (const name of books) {
            const doc = await getWorldBookEntries(name);
            const entries = doc?.entries && typeof doc.entries === 'object' ? Object.values(doc.entries) : (Array.isArray(doc) ? doc : []);
            all.push(...entries);
        }
        all.sort((a, b) => Number(a?.order ?? a?.insertion_order ?? 0) - Number(b?.order ?? b?.insertion_order ?? 0));
        return all;
    };

    // GH#13:卡触发生成的在途台账。is_send_press 语义 = 有未归闲的生成 job;
    // cmd-cardapp op click/push 的 waitForIdle 靠它 + bridge.pending 判闲,
    // 否则 60ms 定死会把异步决策按钮掐在生成途中(dispose 杀桥)。
    let activeGenerations = 0;

    // 生成面(ctx.sendMessage 非 silent + lukerContext.generate):POST generate
    // → 轮终态 → 事件泵(started/ended + chat diff)。persist_target 复用
    // CLI runGeneration 的 character 形(服务端自落 AI 楼)。
    const runCardGeneration = async ({ type = 'normal', quietPrompt, pumpType } = {}) => {
        activeGenerations++;
        try {
        pushCtxEvent('generation_started', [pumpType ?? type]);
        pushThEvent('generation_started', [pumpType ?? type]);
        pushCtxEvent('GENERATION_STARTED', [pumpType ?? type]);
        recordThEvent('generation_started', [pumpType ?? type]);
        const jobId = crypto.randomUUID();
        const body = {
            charDir, chatName, type, stream: false,
            user: { name: opts.user ?? 'User' },
            luker_generation: {
                job_id: jobId,
                // CLI runGeneration 同款:getPersistChatKey 见 avatar_url 就当真
                // persist,故仅 normal/regenerate 走 character,其余 kind:'none'
                // (swipe/continue 由调用方补 patch——headless 只泵事件不落盘)
                persist_target: (type === 'normal' || type === 'regenerate')
                    ? { kind: 'character', avatar_url: avatarUrl, file_name: chatFileName, char_name: charDir }
                    : { kind: 'none' },
            },
        };
        if (quietPrompt) body.overrides = { quietPrompt };
        let accepted;
        try {
            accepted = await client.request('/api/utopinn/generate', { method: 'POST', body, timeout: opts.timeoutMs ?? 60_000 });
        } catch (e) {
            pushCtxEvent('generation_ended', []);
            pushThEvent('generation_ended', []);
            recordThEvent('generation_ended');
            throw e;
        }
        // 终态轮询(WS resume 是 CLI 交互面的东西;headless 泵只要头尾事件)
        const deadline = Date.now() + (opts.generationWaitMs ?? 120_000);
        let status = null;
        while (Date.now() < deadline) {
            await new Promise(r => setTimeout(r, 800));
            try {
                const j = await client.request(`/api/utopinn/jobs/${encodeURIComponent(jobId)}`);
                if (j?.persisted || ['completed', 'failed', 'cancelled'].includes(j?.status)) { status = j; break; }
            } catch { /* 轮询失败重试至 deadline */ }
        }
        await syncChat();
        const okEnd = status?.status === 'completed' || status?.persisted;
        pushCtxEvent(okEnd ? 'generation_ended' : 'generation_stopped', []);
        pushThEvent(okEnd ? 'generation_ended' : 'generation_stopped', []);
        pushCtxEvent('GENERATION_ENDED', []);
        recordThEvent(okEnd ? 'generation_ended' : 'generation_stopped');
        return { jobId, accepted, status };
        } finally { activeGenerations--; }
    };

    // GH#13 click/push 归闲探针:三门桥在途 bridge.pending(卡→宿主调用未回)、
    // 宿主侧生成 job activeGenerations(is_send_press 真值源)。grace 窗内
    // 无条件等待——点击处理链的 setTimeout/微任务尾巴里才发桥调,过早
    // 判闲会把异步链掐死在摇篮里;过了 grace 才按快照判闲。
    const idleSnapshot = () => ({
        bridgePending: bridge?.pending?.size ?? 0,
        activeGenerations,
        isSendPress: activeGenerations > 0,
    });
    const waitForIdle = async ({ timeoutMs = 120_000, graceMs = 500, pollMs = 100 } = {}) => {
        const start = Date.now();
        const deadline = start + Math.max(0, Number(timeoutMs) || 0);
        await new Promise(r => setTimeout(r, Math.min(graceMs, Math.max(0, deadline - Date.now()))));
        while (Date.now() < deadline) {
            const snap = idleSnapshot();
            if (!snap.bridgePending && !snap.activeGenerations) {
                return { settled: true, waitedMs: Date.now() - start, ...snap };
            }
            await new Promise(r => setTimeout(r, pollMs));
        }
        return { settled: false, waitedMs: Date.now() - start, ...idleSnapshot() };
    };

    /** 楼层 diff → 事件(ctxHost.diffAndEmitChat 同语义):
     *  追加→rendered+sent/received;缩短→deleted;同长字段差→edited+updated/
     *  swipe_id→swiped;任何差→chat_changed 兜底。 */
    const diffAndEmitChat = (prev, next) => {
        if (!next) return;
        const pa = Array.isArray(prev?.messages) ? prev.messages : [];
        const na = Array.isArray(next?.messages) ? next.messages : [];
        let dirty = false;
        if (na.length > pa.length) {
            for (let i = pa.length; i < na.length; i++) {
                const m = na[i];
                const ev = m?.is_user ? 'user_message_rendered' : 'char_message_rendered';
                pushCtxEvent(ev, [i]);
                pushThEvent(ev, [i]);
                pushThEvent(m?.is_user ? 'message_sent' : 'message_received', [i]);
            }
            dirty = true;
        } else if (na.length < pa.length) {
            pushCtxEvent('message_deleted', []);
            pushThEvent('message_deleted', []);
            dirty = true;
        } else {
            for (let i = 0; i < na.length; i++) {
                const pm = pa[i], nm = na[i];
                if (!pm || !nm) continue;
                if (nm.swipe_id !== pm.swipe_id) {
                    pushThEvent('message_swiped', [i]);
                    pushCtxEvent('message_swiped', [i]);
                    dirty = true;
                }
                const swipeContentChanged = Array.isArray(nm.swipes) && Number.isInteger(nm.swipe_id)
                    && nm.swipes[nm.swipe_id] !== (Array.isArray(pm.swipes) ? pm.swipes[nm.swipe_id] : undefined);
                if (nm.mes !== pm.mes || swipeContentChanged) {
                    pushThEvent('message_edited', [i]);
                    pushThEvent('message_updated', [i]);
                    pushCtxEvent('message_edited', [i]);
                    dirty = true;
                }
            }
        }
        if (dirty) {
            pushThEvent('chat_changed', [chatFileName]);
            pushCtxEvent('chat_changed', [chatFileName]);
        }
    };

    // ── ctx 对象(Luker buildContext 实测子集;设计 §3d)───────────────────
    const ctx = {};
    let containerRef = null;
    const unsupported = (name) => () => {
        throw new Error(`unsupported in headless ctx: ${name}`);
    };

    const buildLukerContext = () => new Proxy({
                get chat() { return getMessages(); },
                chatId: chatName,
                characterId: charDir,
                name2: charDir,
                eventTypes: {
                    GENERATION_STARTED: 'generation_started',
                    GENERATION_ENDED: 'generation_ended',
                    GENERATION_STOPPED: 'generation_stopped',
                    GENERATION_WORLD_INFO_FINALIZED: 'generation_world_info_finalized',
                    CHARACTER_MESSAGE_RENDERED: 'char_message_rendered',
                    USER_MESSAGE_RENDERED: 'user_message_rendered',
                    MESSAGE_SENT: 'message_sent',
                    MESSAGE_RECEIVED: 'message_received',
                    MESSAGE_SWIPED: 'message_swiped',
                    MESSAGE_EDITED: 'message_edited',
                    MESSAGE_DELETED: 'message_deleted',
                    MESSAGE_UPDATED: 'message_updated',
                    CHAT_CHANGED: 'chat_changed',
                },
                eventSource,
                setExtensionPrompt,
                worldInfoEntry: { getSorted: getSortedWiEntries },
                // GH#13:活 getter——生成 job 在途即 true(ctxHost.ts
                // is_send_press 同语义;旧常量 false 让卡永远探不到生成中)。
                get is_send_press() { return activeGenerations > 0; },
                generate: (type = 'normal') => runCardGeneration({ type }),
                getContext: () => ctx.lukerContext,
    }, {
        get(t, k) { return k in t ? t[k] : (typeof k === 'string' ? unsupported(`lukerContext.${k}`) : undefined); },
    });
    let lukerContextMemo = null;

    // Object.assign 会立即求值 getter 再拷值——containerRef 此刻还是 null,
    // 懒字段必须用 defineProperties 保持活 getter。
    Object.defineProperties(ctx, {
        container: { get: () => containerRef, enumerable: true },
        assetBase: { get: () => assetBaseUrl, enumerable: true },
        dead: { get: () => ctx._dead === true, enumerable: true },
        lukerContext: { get: () => (lukerContextMemo ??= buildLukerContext()), enumerable: true },
    });

    Object.assign(ctx, {
        charId,
        parentDoc: null,                       // --with-parent-doc 时再挂伪 host 文档
        eventSource,
        onDispose(fn) { if (typeof fn === 'function') disposeCallbacks.push(fn); },

        // ── messages ──
        async sendMessage(text, options = {}) {
            if (options?.silent) {
                const r = await runCardGeneration({ type: 'quiet', quietPrompt: String(text ?? '') });
                return r?.status?.text ?? r?.status?.result ?? null;
            }
            const prev = chatDoc;
            await client.library.appendMessages(charDir, chatName, [{
                name: opts.user ?? 'User', is_user: true, is_system: false,
                send_date: new Date().toISOString(), mes: String(text ?? ''),
            }]);
            pushThEvent('message_sent', []);
            pushCtxEvent('message_sent', []);
            const r = await runCardGeneration({ type: 'normal' });
            await diffAndEmitChat(prev, chatDoc);
            return r?.status?.text;
        },
        getHistory(limit, offset = 0) {
            const msgs = getMessages();
            if (limit) {
                const start = Math.max(0, msgs.length - offset - limit);
                return msgs.slice(start, msgs.length - offset);
            }
            return [...msgs];
        },
        async editMessage(messageId, newText) {
            const i = Number(messageId);
            const msg = getMessages()[i];
            if (!msg) return;
            const ops = [{ op: 'replace', path: `/body/${i}/mes`, value: String(newText ?? '') }];
            const swipes = Array.isArray(msg.swipes) ? msg.swipes : null;
            const swipeId = Number.isInteger(msg.swipe_id) ? msg.swipe_id : null;
            if (swipes && swipeId != null && swipeId < swipes.length) {
                ops.push({ op: 'replace', path: `/body/${i}/swipes/${swipeId}`, value: String(newText ?? '') });
            }
            await client.library.patchChat(charDir, chatName, ops);
            await syncChat();
        },
        async regenerate() { return runCardGeneration({ type: 'regenerate', pumpType: 'regenerate' }); },
        async swipe() { return runCardGeneration({ type: 'swipe', pumpType: 'swipe' }); },

        // ── 变量:chat_metadata.variables 写穿缓存(ctx 面即 Luker 真值面)──
        getVariable(key) { return varCache?.[key]; },
        async setVariable(key, value, _options = {}) {
            const v = jsonClone(value);
            varCache[key] = v;
            const escKey = String(key).replace(/~/g, '~0').replace(/\//g, '~1');
            await client.patchChatMetadata(avatarUrl, chatFileName,
                [{ op: 'add', path: `/variables/${escKey}`, value: v }]);   // add=upsert,新键不报 409
            return value;
        },

        // ── chat_state sidecar(state chat 面;Luker envelope 语义)─────────
        async getChatState(namespace) {
            try {
                const state = await client.stateGet(avatarUrl, chatFileName, String(namespace));
                return { ok: true, state: state ?? null };
            } catch (e) {
                return { ok: false, state: null, reason: 'transport', hint: String(e?.message ?? e) };
            }
        },
        async updateChatState(namespace, updater, options = {}) {
            try {
                const cur = await client.stateGet(avatarUrl, chatFileName, String(namespace)).catch(() => null);
                const next = typeof updater === 'function'
                    ? await updater(jsonClone(cur) ?? {}, { attempt: 0, target: {}, namespace })
                    : jsonClone(updater);
                if (next === null || next === undefined) return { ok: true, state: cur ?? null, updated: false };
                const v = jsonClone(next) ?? {};
                await client.statePatch(avatarUrl, chatFileName, String(namespace),
                    [{ op: 'replace', path: '', value: v }]);
                return { ok: true, state: v, updated: true };
            } catch (e) {
                return { ok: false, reason: 'transport', hint: String(e?.message ?? e) };
            }
        },
        async patchChatState(namespace, operations) {
            try {
                await client.statePatch(avatarUrl, chatFileName, String(namespace), jsonClone(operations));
                return { ok: true };
            } catch (e) {
                return { ok: false, reason: 'transport', hint: String(e?.message ?? e) };
            }
        },
        async deleteChatState(namespace) {
            try {
                await client.state.chat.delete({ avatar_url: avatarUrl, file_name: chatFileName }, String(namespace));
                return { ok: true };
            } catch (e) {
                return { ok: false, reason: 'transport', hint: String(e?.message ?? e) };
            }
        },

        // ── world info ──
        getWorldBooks,
        getWorldBookEntries,

        // ── slash / misc ──
        async executeSlashCommand(command) {
            const res = await client.th.call('triggerSlash', {
                target: { charDir, chatName },
                args: { script: String(command ?? '') },
            });
            if (res?.ok === false) throw new Error(res?.error ?? 'triggerSlash failed');
            return res?.result;
        },
        async sendTextareaMessage(text) { return ctx.sendMessage(text); },
        getCharaFilename() { return charDir; },
        getChatId() { return chatName; },
        openOverlay() { }, closeOverlay() { },
        registerRenderer(obj) { ctx.__renderer = obj; },
        getRenderer() { return ctx.__renderer ?? null; },
        addEventListener(target, event, handler, options) {
            target?.addEventListener?.(event, handler, options);
            trackedTimers.listeners.push({ target, event, handler });
        },
        setInterval(fn, ms) {
            const id = setInterval(fn, ms);
            trackedTimers.intervals.add(id);
            return id;
        },
        setTimeout(fn, ms) {
            const id = setTimeout(fn, ms);
            trackedTimers.timeouts.add(id);
            return id;
        },
    });

    // ctx.* 桥方法(ctxDispatch):可序列化的经桥——设计 §3d「经桥」表,
    // 方法面与 apps/web/src/cardapp/ctxHost.ts ctxDispatch 同名对齐(22)。
    const ctxDispatch = async (sub, args) => {
        switch (sub) {
            case 'getChat':
                await syncChat();
                return { messages: getMessages(), header: chatDoc?.header ?? null };
            case 'sendMessage': return ctx.sendMessage(args?.text ?? args?.mes ?? '', args?.options);
            case 'generate': return runCardGeneration({
                type: String(args?.type ?? 'normal'),
                quietPrompt: args?.quietPrompt ? String(args.quietPrompt) : undefined,
            });
            case 'regenerate': return ctx.regenerate();
            case 'swipe': return ctx.swipe();
            case 'editMessage': {
                const i = Number(args?.messageId);
                if (!getMessages()[i]) return { ok: true, edited: false };
                await ctx.editMessage(i, String(args?.text ?? ''));
                pushCtxEvent('message_edited', [i]);
                pushThEvent('message_edited', [i]);
                return { ok: true, edited: true };
            }
            case 'setVariable': {
                await ctx.setVariable(String(args?.key ?? ''), args?.value);
                return args?.value;
            }
            case 'getChatState': return ctx.getChatState(args?.namespace ?? args?.ns);
            case 'updateChatState': {
                const ns = args?.namespace ?? args?.ns;
                const ops = args?.operations;
                if (Array.isArray(ops)) return ctx.patchChatState(ns, ops);
                return ctx.updateChatState(ns, () => args?.state ?? args?.value ?? {});
            }
            case 'deleteChatState': return ctx.deleteChatState(args?.namespace ?? args?.ns);
            case 'getCharacterState': {
                const st = await client.state.char.get({ avatar_url: avatarUrl }, String(args?.namespace ?? '')).catch(() => null);
                return { ok: true, state: st?.data ?? st ?? null };
            }
            case 'updateCharacterState': {
                const cur = (await client.state.char.get({ avatar_url: avatarUrl }, String(args?.namespace ?? '')).catch(() => null))?.data ?? {};
                const next = { ...cur, ...(jsonClone(args?.state ?? args?.value) ?? {}) };
                await client.state.char.set({ avatar_url: avatarUrl }, String(args?.namespace ?? ''), next);
                return { ok: true, state: next };
            }
            case 'getCharacter': {
                const res = await client.th.call('getCharacter', { target: { charDir } });
                return res?.result;
            }
            case 'getWorldBooks': return getWorldBooks({ withSource: !!args?.withSource });
            case 'getWorldBook': {
                const name = args?.name ?? (await getWorldBooks({}))[0];
                return name ? getWorldBookEntries(name) : null;
            }
            case 'updateWorldBookEntry': {
                const name = args?.name ?? (await getWorldBooks({}))[0];
                if (!name) return { ok: false, reason: 'no_book' };
                const doc = await getWorldBookEntries(name);
                if (!doc?.entries) return { ok: false, reason: 'no_book' };
                const uid = args?.uid ?? args?.entryId;
                const fields = args?.fields ?? args?.data ?? {};
                const key = String(uid ?? Object.keys(doc.entries).length);
                doc.entries[key] = { ...(doc.entries[key] ?? {}), ...fields };
                await client.library.worldEdit(String(name), doc);
                return { ok: true };
            }
            case 'executeSlashCommand': return ctx.executeSlashCommand(String(args?.script ?? args?.command ?? ''));
            case 'setExtensionPrompt': {
                await setExtensionPrompt(
                    String(args?.key ?? ''), String(args?.value ?? ''),
                    args?.position, args?.depth, args?.scan, args?.role);
                return { ok: true };
            }
            case 'eventEmit': {
                // 卡→宿主扇出(worldinfo_force_activate 等):当前面没有服务端
                // 消费者 —— 收下并留痕,不伪装成功语义(ctxHost.ts:401 同款)。
                pushConsole('log', `ctx.eventEmit ${String(args?.name)} (no host consumer)`);
                return { ok: true, delivered: 'log' };
            }
            case 'on': { ctxSubscribed.add(String(args?.event)); return null; }
            case 'off': { ctxSubscribed.delete(String(args?.event)); return null; }
            case 'setTimer': return null;
            case 'dispose': return dispose();
            // ── 卡「表面可见性」面(ctx.openOverlay/closeOverlay → wire
            //    ctx.surfaceOpen/surfaceClose):headless 无工作台——可经
            //    opts.surface 注壳(测试/宿主复用 ctxHost 同契约),缺席 → 如实降级 ──
            case 'surfaceOpen': {
                const s = opts.surface;
                if (typeof s?.openPanel === 'function') {
                    const panelType = s.panelType ?? 'cardapp';
                    s.openPanel(panelType);
                    return { ok: true, panel: panelType };
                }
                pushConsole('log', 'ctx.surfaceOpen: 无壳可收(headless)→ degraded');
                return { ok: false, reason: protocol.PANEL_SURFACE_UNAVAILABLE, surface: 'open' };
            }
            case 'surfaceClose': {
                const s = opts.surface;
                if (typeof s?.collapsePanels === 'function') {
                    s.collapsePanels();
                    return { ok: true };
                }
                pushConsole('log', 'ctx.surfaceClose: 无壳可收(headless)→ degraded');
                return { ok: false, reason: protocol.PANEL_SURFACE_UNAVAILABLE, surface: 'close' };
            }
            default: throw new Error(`unsupported_method: ctx.${sub}`);
        }
    };

    // ── 初始 chat 快照先于 DOM:bootstrap.messageId/varCache 要真值 ──────────
    dbg('syncChat…');
    await syncChat();
    dbg('syncChat ok');

    // ── JSDOM 装载 ────────────────────────────────────────────────────────
    const resources = makeResourcesOption(D.requestInterceptor, resolver, mountOrigin);
    dbg('JSDOM construct…');
    const dom = new D.JSDOM(html, {
        url: mountOrigin,
        runScripts: 'dangerously',
        resources,
        pretendToBeVisual: true,
        virtualConsole: VirtualConsole,
        cookieJar: new D.CookieJar(),   // 空罐:卡 realm 无会话凭据(§5 硬约束)
        beforeParse(window) {
            window.__UTOPINN_PANEL_NONCE__ = bridgeNonce;
            window.__UTOPINN_PANEL_BOOTSTRAP__ = {
                face: face === 'ctx' ? 'ctx' : 'th',
                mountId, charId,
                chatName,                                   // ctx-shim:getChatId/lukerContext.chatId
                entry: manifest.entry,                      // ctx 面 init 寻址约定
                assetBase: assetBaseUrl,                    // ctx-shim:ctx.assetBase
                stateNamespaces,
                initializedGlobals: [],
                messageId: getMessages().length - 1,
            };
            window.__utopinnPanelPost = (m) => { bridge ? bridge.onMessage(m) : pendingInbound.push(m); };
            installDomStubs(window);
            if (shimSource) {
                try { window.eval(shimSource); }
                catch (e) { pushConsole('jsdomError', `shim eval failed: ${e?.message ?? e}`); }
            }
        },
    });
    dbg('JSDOM constructed');
    const window = dom.window;
    // ctx.__ready peut rejeter dès le flush des requêtes en file (ex: ctx.getChat
    // non accordé) — avaler la promesse tôt pour éviter un unhandledRejection
    // fatal; l'init-caller await __ready plus tard avec son propre catch.
    try { window.__CARDAPP_CTX__?.__ready?.catch(() => { }); } catch { }

    bridge = new PanelBridge({
        nonce: bridgeNonce,
        allowed: grants.allowed,
        // 进程内传输 seam(见 §5.3):normalize 斩 jsdom realm 引用并落实
        // "wire 可序列化";encodeResult 同理 —— 响应体只携可序列化值。
        normalize: jsonClone,
        encodeResult: (r) => jsonClone(r) ?? null,
        send: (msg) => { try { window.__utopinnPanelReceive?.(jsonClone(msg)); } catch (e) { pushConsole('warn', `panelReceive threw: ${e?.message ?? e}`); } },
        dispatch,
    });

    // panel-t0 handler(复合 dispatch 的 T0 主路;deps 与 §3c 对齐)
    panelT0 = createPanelT0Handler({
        client,
        avatarUrl,
        chatFileName,
        mountMessageId: Math.max(0, getMessages().length - 1),
        initializedGlobals: new Set(),
        // 卡 eventEmit → server 信箱(跨 mount 扇出;本卡 shim 已 dispatchLocal,
        // 回推自己 bridge 会双发 —— ctxHost.ts:90 同修复)。
        emitToPanels: async (ev, a) => { await recordThEvent(ev, a); },
        debug: (rec) => pushConsole('shadow', JSON.stringify(rec)),
        getCharacterCard: async () => {
            const res = await client.th.call('getCharacter', { target: { charDir } });
            return res?.result;
        },
    });

    // bridge+panelT0 就位——构造期卡码(内联 script/init 外提)寄存的请求放行
    for (const m of pendingInbound.splice(0)) bridge.onMessage(m);

    containerRef = window.document.getElementById('card-app-container') ?? window.document.body;

    // --with-parent-doc:伪 host 文档(#send_textarea + matchMedia 桩),
    // 掌门卡「倒入输入框」路径的验证面(设计 §3d parentDoc 行)
    if (opts.withParentDoc) {
        const pdom = new D.JSDOM('<!doctype html><body><textarea id="send_textarea"></textarea></body>', {
            url: server, pretendToBeVisual: true,
        });
        installDomStubs(pdom.window);
        ctx.parentDoc = pdom.window.document;
        ctx.__parentDom = pdom;
    }

    // ── module 入口:esbuild bundle → realm eval → init(ctx) ────────────────
    dbg('module entry? ' + manifest.entryKind);
    let moduleExports = null;
    let initCalled = false;
    if (manifest.entryKind === 'module') {
        if (!D.esbuild) {
            const e = new Error('module 入口需要 esbuild(未安装)');
            e.code = 'harness_missing';
            e.detail = { hint: 'pnpm install --filter @utopinn/cli' };
            throw e;
        }
        const entryRes = await resolver.resolve(manifest.entry);
        if (!entryRes) {
            const e = new Error(`module entry "${manifest.entry}" 资产不可解`); e.code = 'not_found'; throw e;
        }
        // esbuild 插件:import 全部走 AssetResolver(线上资产也能 bundle)
        const mountPlugin = {
            name: 'cardapp-mount-resolver',
            setup(build) {
                build.onResolve({ filter: /.*/ }, (a) => {
                    if (a.kind === 'entry-point') return { path: manifest.entry, namespace: 'mount' };
                    const rel = a.path.startsWith('./') || a.path.startsWith('../')
                        ? path.posix.normalize(path.posix.join(path.posix.dirname(a.importer || manifest.entry), a.path))
                        : a.path;
                    if (!/^\//.test(a.path) && !/^[a-z]+:/.test(a.path)) {
                        return { path: rel.replace(/^\.?\//, ''), namespace: 'mount' };
                    }
                    if (/^https?:/.test(a.path)) {
                        return resolver.admitted(a.path)
                            ? { path: a.path, namespace: 'external' }
                            : { errors: [{ text: `import 未被 network.allowlist 放行: ${a.path}` }] };
                    }
                    return { errors: [{ text: `bare import 不支持(headless): ${a.path}` }] };
                });
                build.onLoad({ filter: /.*/, namespace: 'mount' }, async (a) => {
                    const r = await resolver.resolve(a.path);
                    if (!r) return { errors: [{ text: `资产不可解: ${a.path}` }] };
                    const ext = path.posix.extname(a.path).toLowerCase();
                    const loader = { '.js': 'js', '.mjs': 'js', '.json': 'json', '.css': 'css', '.txt': 'text' }[ext] ?? 'binary';
                    return loader === 'binary'
                        ? { contents: `export default ${JSON.stringify(`data:${mimeOf(a.path)};base64,${r.bytes.toString('base64')}`)};`, loader: 'js' }
                        : { contents: r.bytes.toString('utf8'), loader };
                });
                build.onLoad({ filter: /.*/, namespace: 'external' }, async (a) => {
                    const r = await resolver.resolveExternal(a.path);
                    if (!r) return { errors: [{ text: `外部资产不可解: ${a.path}` }] };
                    return { contents: r.bytes.toString('utf8'), loader: 'js' };
                });
            },
        };
        const built = await D.esbuild.build({
            stdin: { contents: entryRes.bytes.toString('utf8'), resolveDir: '/', loader: 'js' },
            bundle: true,
            format: 'cjs',
            write: false,
            plugins: [mountPlugin],
            logLevel: 'silent',
            target: 'es2020',
        });
        const code = built.outputFiles?.[0]?.text ?? '';
        window.eval(`(function(){var module={exports:{}},exports=module.exports;\n${code}\n;window.__cardapp_exports=module.exports;})()`);
        moduleExports = window.__cardapp_exports;
        if (typeof moduleExports?.init === 'function') {
            initCalled = true;
            // ctx 面:init 收 shim 造的 __CARDAPP_CTX__(ctx.* 全走桥,wire 契约
            // 才被真实行使)——mount 端 buildModuleShell initCaller 同语义:
            // 先等 __ready 种子(varCache/chatCache),再 init。shim eval 失败
            // 时退宿主 ctx 对象(旧直调路径,仍能跑但不过 wire 门)。
            const cardCtx = (face === 'ctx' && window.__CARDAPP_CTX__) ? window.__CARDAPP_CTX__ : ctx;
            if (cardCtx !== ctx && cardCtx.__ready) {
                try { await cardCtx.__ready; } catch { /* 种子失败不拦 init */ }
            }
            await Promise.resolve(moduleExports.init(cardCtx));
        } else {
            warnings.push('module entry 无 init(ctx) 导出——按自执行模块降级(side effects only)');
        }
    }

    // settle:DOMContentLoaded + 两个 macrotask(卡 init 尾巴里常排 setTimeout 0)
    dbg('settle…');
    const settle = async (ms = opts.settleMs ?? 1200) => {
        const deadline = Date.now() + ms;
        while (Date.now() < deadline) {
            if (window.document.readyState === 'complete') break;
            await new Promise(r => setTimeout(r, 25));
        }
        await new Promise(r => setTimeout(r, 40));
        await new Promise(r => setTimeout(r, 40));
    };
    await settle();

    const evalInCard = (expr) => {
        const r = window.eval(`(${expr})`);
        return r;
    };
    const callDispatch = (method, args) => dispatch(method.startsWith('th.') || method.startsWith('ctx.') ? method : `th.${method}`, args ?? {});

    async function dispose() {
        if (ctx._dead) return;
        ctx._dead = true;
        for (const fn of disposeCallbacks.splice(0)) {
            try { fn(); } catch (e) { pushConsole('warn', `onDispose threw: ${e?.message ?? e}`); }
        }
        for (const id of trackedTimers.intervals) clearInterval(id);
        for (const id of trackedTimers.timeouts) clearTimeout(id);
        for (const l of trackedTimers.listeners.splice(0)) {
            try { l.target?.removeEventListener?.(l.event, l.handler); } catch { }
        }
        eventSource.removeAllListeners();
        ctxSubscribed.clear();
        bridge?.dispose();
        try { ctx.__parentDom?.window?.close(); } catch { }
        try { window.close(); } catch { }
    }

    return {
        client, dom, window, document: window.document,
        ctx, containerRef, eventSource, bridge,
        mount: { mountId, charId, chatName, entry: manifest.entry, entryKind: manifest.entryKind, entryUrl: entryUrlPath, assetBaseUrl, bridgeNonce },
        face, grants, manifest, warnings, consoleLog,
        evalInCard, callDispatch, pushThEvent, pushCtxEvent,
        // GH#15b:ctx.on 登记进 ctxSubscribed,却只吐 panelT0 的——
        // op push 的 subscribed 永远 []。两面合并去重。
        subscribedEvents: () => [...new Set([...(panelT0?.subscribedEvents?.() ?? []), ...ctxSubscribed])],
        syncChat, diffAndEmitChat, runCardGeneration, dispose,
        // GH#13:click/push 后的归闲探针(三门桥 pending + 生成 job 台账)。
        idleSnapshot, waitForIdle,
        pollMailbox, recordThEvent, hostId,
        varSnapshot: () => jsonClone(varCache),
        initCalled,
        moduleExports,
        resolver,
    };
}
