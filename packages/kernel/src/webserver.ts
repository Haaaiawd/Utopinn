/**
 * webServer —— 路由即贡献的服务(照 dsh-host-webserver 形状,裁剪版):
 *   register(route) → disposer        HTTP 路由(exact/pattern/prefix)
 *   registerUpgrade(route) → disposer WS 升级位
 *
 * 不持服务器对象——两个出口:
 *   middleware()     挂进 Express(放在 legacy 挂载前,表命中即接管,
 *                    未命中 next() 落回 legacy —— 按面切不翻桌)
 *   upgradeListener() 挂 httpServer 'upgrade',未命中不动 socket
 *
 * pattern 是 `:param` 段模式(Express 形):/a/:b/c → 命名捕获组,
 * 命中后写进 req.params,handler 拿到的 req/res 就是 Express 原生对象。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';

export interface WebHandler {
    (req: IncomingMessage & { params?: Record<string, string>; [k: string]: unknown },
        res: ServerResponse): unknown | Promise<unknown>;
}

export interface WebRoute {
    kind: 'exact' | 'pattern' | 'prefix';
    /** 'GET'/'POST'/… ;省略 = 任意方法。 */
    method?: string;
    path: string;
    handler: WebHandler;
}

export interface WebUpgradeRoute {
    path: string;
    handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => void;
}

type NextFn = (err?: unknown) => void;

interface CompiledRoute extends WebRoute {
    regex?: RegExp;
    paramNames?: string[];
    key: string;
}

/** '/a/:b/c' → [/^\/a\/([^/]+)\/c$/, ['b']] ;非 :段原样转义。 */
function compilePattern(path: string): { regex: RegExp; paramNames: string[] } {
    const paramNames: string[] = [];
    const src = path.split('/').map((seg) => {
        if (seg.startsWith(':')) {
            paramNames.push(seg.slice(1));
            return '([^/]+)';
        }
        return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }).join('/');
    return { regex: new RegExp(`^${src}$`), paramNames };
}

export class WebServer {
    private readonly routes = new Map<string, CompiledRoute>();
    private readonly upgrades = new Map<string, WebUpgradeRoute>();

    /** 注册一条路由。同 (method,kind,path) 重复注册即 throw。 */
    register(route: WebRoute): () => void {
        const key = `${route.method ?? '*'}|${route.kind}|${route.path}`;
        if (this.routes.has(key)) {
            throw new Error(`webserver: duplicate route "${key}"`);
        }
        const compiled: CompiledRoute = { ...route, key };
        if (route.kind === 'pattern') {
            const { regex, paramNames } = compilePattern(route.path);
            compiled.regex = regex;
            compiled.paramNames = paramNames;
        }
        this.routes.set(key, compiled);
        return () => { this.routes.delete(key); };
    }

    /** 注册 WS 升级位。同 path 重复注册即 throw。 */
    registerUpgrade(route: WebUpgradeRoute): () => void {
        if (this.upgrades.has(route.path)) {
            throw new Error(`webserver: duplicate upgrade route "${route.path}"`);
        }
        this.upgrades.set(route.path, route);
        return () => { this.upgrades.delete(route.path); };
    }

    /** Express middleware:表命中 → handler 接管(异步错误 → 500);
        未命中 → next()。 */
    middleware() {
        return (req: IncomingMessage & { params?: Record<string, string>; [k: string]: unknown },
            res: ServerResponse, next: NextFn): void => {
            const path = (req.url ?? '').split('?')[0];
            const method = (req.method ?? 'GET').toUpperCase();
            for (const r of this.routes.values()) {
                if (r.method && r.method.toUpperCase() !== method) continue;
                let params: Record<string, string> | undefined;
                if (r.kind === 'exact') {
                    if (path !== r.path) continue;
                    params = {};
                } else if (r.kind === 'prefix') {
                    if (!path.startsWith(r.path)) continue;
                    params = {};
                } else {
                    const m = r.regex!.exec(path);
                    if (!m) continue;
                    params = {};
                    r.paramNames!.forEach((n, i) => { params![n] = decodeURIComponent(m[i + 1] ?? ''); });
                }
                req.params = params;
                try {
                    const out = r.handler(req, res);
                    if (out instanceof Promise) {
                        out.catch((err) => {
                            if (!res.headersSent) {
                                res.statusCode = 500;
                                res.setHeader('content-type', 'application/json');
                                res.end(JSON.stringify({ error: String(err?.message ?? err) }));
                            } else {
                                res.end();
                            }
                        });
                    }
                } catch (err) {
                    if (!res.headersSent) {
                        res.statusCode = 500;
                        res.setHeader('content-type', 'application/json');
                        res.end(JSON.stringify({ error: String(err instanceof Error ? err.message : err) }));
                    }
                }
                return;
            }
            next();
        };
    }

    /** httpServer 'upgrade' 监听:path 命中 → handler 接管 socket;
        未命中 → 不动(socket 留给同事件上的其他监听者,如 ws-delivery)。 */
    upgradeListener() {
        return (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
            const path = (req.url ?? '').split('?')[0];
            const route = this.upgrades.get(path);
            if (!route) return;
            try {
                const result = route.handler(req, socket, head) as unknown;
                if (result && typeof (result as Promise<unknown>).catch === 'function') {
                    (result as Promise<unknown>).catch((err) => {
                        console.error(`[webserver] upgrade handler ${path} rejected:`, err);
                        socket.destroy();
                    });
                }
            } catch (err) {
                console.error(`[webserver] upgrade handler ${path} threw:`, err);
                socket.destroy();
            }
        };
    }

    /** 诊断面:当前注册的路由清单。 */
    list(): string[] {
        return [...this.routes.keys(), ...[...this.upgrades.keys()].map((p) => `upgrade|${p}`)];
    }
}
