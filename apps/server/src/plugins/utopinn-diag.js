/**
 * utopinn-diag —— kernel 自诊断面(B 步自证插件)。
 *
 * GET /api/utopinn/_kernel → {routes, services}
 *   routes:   webServer.list()     当前注册的全部 HTTP/upgrade 位
 *   services: catalog.list()       ServiceCatalog(谁提供了什么)
 *
 * 它自己也是经 webServer.register 贡献的 —— seam 服务自己,
 * 第二个插件的存在同时证明「多插件并行贡献」成立。
 */
export const inject = ['webServer', 'catalog'];

export function apply(ctx) {
    ctx.effect(() => ctx.webServer.register({
        kind: 'exact',
        method: 'GET',
        path: '/api/utopinn/_kernel',
        handler: function (_request, response) {
            return response.send({
                routes: ctx.webServer.list(),
                services: ctx.catalog.list(),
            });
        },
    }));
}
