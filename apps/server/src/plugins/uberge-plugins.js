/**
 * uberge-plugins —— 插件管理 API(TASK-021 服务端执行面)。
 *
 *   GET  /api/uberge/plugins              合并态清单(profile × patch × 运行时)
 *   POST /api/uberge/plugins/:id/enable   patch 落盘 disabled:false + 重新 apply
 *   POST /api/uberge/plugins/:id/disable  patch 落盘 disabled:true + fiber.dispose()
 *   POST /api/uberge/plugins/:id/reload   dispose + cache-bust 重导入 + apply
 *
 * 自锁保护:本插件的 disable/reload 会拆了自己的路由面(或把自己关进
 * disabled 而无路可开)—— 一律 400 拒绝;真要关它,改 profile.patch.yaml。
 */
export const inject = ['webServer', 'pluginManager'];

const SELF = 'uberge-plugins';

export function apply(ctx) {
    const pm = ctx.pluginManager;
    const reg = (path, handler) =>
        ctx.effect(() => ctx.webServer.register({ kind: 'pattern', method: 'POST', path, handler }));

    ctx.effect(() => ctx.webServer.register({
        kind: 'pattern',
        method: 'GET',
        path: '/api/uberge/plugins',
        handler: async function (request, response) {
            if (!request.user?.profile?.admin) {
                return response.status(403).send({ error: 'Unauthorized' });
            }
            return response.send({ items: await pm.list() });
        },
    }));

    const act = (verb) => async function (request, response) {
        if (!request.user?.profile?.admin) {
            return response.status(403).send({ error: 'Unauthorized' });
        }
        const id = request.params?.id;
        if (id === SELF && verb !== 'enable') {
            return response.status(400).send({ error: `cannot ${verb} the plugin manager itself` });
        }
        const r = await pm[verb](id);
        if (!r.ok) return response.status(r.code ?? 500).send({ error: r.error });
        return response.send(r);
    };

    reg('/api/uberge/plugins/:id/enable', act('enable'));
    reg('/api/uberge/plugins/:id/disable', act('disable'));
    reg('/api/uberge/plugins/:id/reload', act('reload'));
}
