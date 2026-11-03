import type { PluginModule } from './plugin.js';
import type { AppContext } from './context.js';

/**
 * 旧 ST 服务端插件适配器(plugin-kernel C4 / D-012)。
 * ST 契约:{ info, init(router), exit() } —— init 拿挂在 /api/plugins/<id>/ 下的 Express router。
 * 适配:info→manifest 元数据;init(router)→挂到我们 HTTP 面(ctx.http mount);exit()→effect disposer。
 * 不做任何行为翻译——插件的路由/中间件原样工作。
 */

export interface LegacySTPlugin {
    info: { id: string; name: string; description?: string };
    init: (router: unknown) => void | Promise<void>;
    exit?: () => void | Promise<void>;
}

export interface LegacyAdapterOptions {
    /** 由宿主提供的 router 工厂(Express Router 或等价物);未提供时跳过 init(degraded 由 loader 判定) */
    routerFactory?: (pluginId: string) => unknown;
}

export function adaptLegacyPlugin(
    legacy: LegacySTPlugin,
    opts: LegacyAdapterOptions = {},
): PluginModule {
    return {
        name: `legacy/${legacy.info.id}`,
        apply: (ctx: unknown, _config: unknown) => {
            const appCtx = ctx as AppContext;
            if (!opts.routerFactory) return;
            const router = opts.routerFactory(legacy.info.id);
            const maybePromise = legacy.init(router);
            if (maybePromise instanceof Promise) {
                void maybePromise;
            }
            if (legacy.exit) {
                appCtx.effect(() => () => legacy.exit!());
            }
        },
    };
}
