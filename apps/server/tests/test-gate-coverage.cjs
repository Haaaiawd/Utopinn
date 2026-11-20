#!/usr/bin/env node
/**
 * test-gate-coverage —— 多设备同步写闸的覆盖防漂移测试。
 *
 * 背景:GATED_ROUTES(src/sync/in-progress-gate.js)是一张手抄表。
 * kernel webServer 每加一条非 GET 的 /api/utopinn/* 路由而漏抄,该写
 * 请求就不持读者槽——sync 快照/恢复(writer 侧)可以把它拦腰撕开。
 * 本周已出过一次(漏 5 条写路由,闸形同虚设)。
 *
 * 做法:起一台隔离 kernel 服(e2e harness),枚举 webServer.list()
 * 路由全集;对每条非 GET 的 /api/utopinn/* 路由,用其 pattern 造一条
 * 代表请求路径喂给 matchGatedRoute()。断言:要么命中闸表(dirty:false
 * 也算——只持读者槽不落脏标记),要么列在本文件的 EXEMPT。
 *
 * EXEMPT 与路由表互相钉死:
 *   - 路由未命中闸表且不在 EXEMPT → FAIL,打印缺失清单;
 *   - EXEMPT 条目指向内核已不存在的路由 → FAIL(死豁免);
 *   - EXEMPT 条目实际已命中闸表 → FAIL(豁免残留,请删条目)。
 * 这样下次漏抄/删路由/补闸,失败信息都直接可读。
 *
 * 跑法:node apps/server/tests/test-gate-coverage.cjs
 *   (或 pnpm --filter @utopinn/server test:drift;环境变量同 e2e harness)
 * 退出码:全过 0;有漏闸/死豁免/豁免残留 1;服务起不来 2。
 */
'use strict';
const { resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const { bootKernelRoutes, parseKernelRoute, probePath, SERVER_DIR } = require('./lib/kernel-enum.cjs');

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * 显式豁免:非 GET 的 /api/utopinn/* 路由,确认不需持闸读者槽。
 * 每条必须有理由——豁免不是漏抄的藏身所,新增路由默认该进闸表。
 * key 与 kernel webServer.list() 串("METHOD|kind|path")逐字相等。
 */
const EXEMPT = new Map(Object.entries({
    // —— 进程态写:不落 userRoot,同步类目之外 ——
    'POST|pattern|/api/utopinn/diag/client':
        '客户端诊断上报进 diag-bus 内存环缓冲,不写用户数据根。',
    'POST|pattern|/api/utopinn/jobs/:id/abort':
        '翻内存 job 的 abort 旗标;job 自身落盘经 runGatedWrite 自带槽。',
    'POST|pattern|/api/utopinn/plugins/:id/enable':
        '写 src/profile.patch.yaml(内核插件清单,userRoot/同步类目之外)。',
    'POST|pattern|/api/utopinn/plugins/:id/disable':
        '同上:patch.yaml 增量行,不动同步数据。',
    'POST|pattern|/api/utopinn/plugins/:id/reload':
        'dispose + cache-bust 重导入插件模块;不写 userRoot。',
    // —— 只读 POST:body 载查询参数,闸只挡写路径,读面与 GET 同级不持槽 ——
    'POST|pattern|/api/utopinn/connection/test':
        '出站探测上游 API;只读 settings/secrets 取凭据,不写盘。',
    'POST|pattern|/api/utopinn/chats/recent':
        '只读聚合(pinned/max 在 body);recent 索引驻内存不落盘。',
    'POST|pattern|/api/utopinn/state/chat/get':
        '只读 chat state sidecar(POST 带 target/namespace)。',
    'POST|pattern|/api/utopinn/state/chat/get-batch':
        '只读 sidecar,单 target 多 namespace 批量。',
    'POST|pattern|/api/utopinn/state/char/get':
        '只读 char state sidecar。',
    'POST|pattern|/api/utopinn/state/char/get-batch':
        '只读 sidecar 批量。',
    'POST|pattern|/api/utopinn/state/preset/get':
        '只读 preset state sidecar。',
    'POST|pattern|/api/utopinn/state/preset/get-batch':
        '只读 sidecar 批量。',
}));

const failures = [];
function fail(title, lines) {
    failures.push(title);
    console.error(`\x1b[31mFAIL\x1b[0m ${title}`);
    for (const line of lines) console.error(`      ${line}`);
}

async function main() {
    const gateUrl = pathToFileURL(resolve(SERVER_DIR, 'src/sync/in-progress-gate.js')).href;
    const { matchGatedRoute } = await import(gateUrl);

    const { base, routes, stop } = await bootKernelRoutes();
    try {
        const httpRoutes = routes.map(parseKernelRoute).filter(Boolean);
        const utopinnWrites = httpRoutes.filter(r => r.path.startsWith('/api/utopinn/')
            && (r.method === '*' || WRITE_METHODS.has(r.method.toUpperCase())));
        const outsiders = httpRoutes.filter(r => !r.path.startsWith('/api/utopinn/'));

        const ungated = [];      // 漏闸:非 GET 且不命中闸表、未豁免
        const overExempt = [];   // 豁免残留:条目已命中闸表
        for (const route of utopinnWrites) {
            const probe = probePath(route.path, route.kind);
            const hit = matchGatedRoute(probe);
            if (hit && EXEMPT.has(route.key)) {
                overExempt.push(`${route.key}  (probe ${probe} 命中闸表 —— 从 EXEMPT 删此条)`);
            } else if (!hit && !EXEMPT.has(route.key)) {
                ungated.push(`${route.key}  (probe ${probe} 无闸表命中 —— 补 GATED_ROUTES 或加 EXEMPT 并写明理由)`);
            }
        }

        if (ungated.length) {
            fail(`${ungated.length} 条非 GET /api/utopinn 路由未覆盖闸表`, ungated);
        }
        if (overExempt.length) {
            fail(`${overExempt.length} 条 EXEMPT 豁免残留(路由已命中闸表)`, overExempt);
        }

        // 死豁免:EXEMPT 点名了内核不再注册的路由。
        const routeKeys = new Set(routes);
        const deadExempt = [...EXEMPT.keys()].filter(key => !routeKeys.has(key));
        if (deadExempt.length) {
            fail(`${deadExempt.length} 条 EXEMPT 指向不存在的路由(死豁免)`, deadExempt);
        }

        if (outsiders.length) {
            console.log(`note: ${outsiders.length} 条 kernel HTTP 路由在 /api/utopinn 面外(本测试不覆盖):`);
            for (const r of outsiders) console.log(`      ${r.key}`);
        }

        const gatedCount = utopinnWrites.filter(r => matchGatedRoute(probePath(r.path, r.kind))).length;
        const exemptCount = [...EXEMPT.keys()].filter(k => routeKeys.has(k)).length;
        console.log(`server ${base}`);
        console.log(`kernel 路由 ${routes.length} 条(含 upgrade 位);非 GET /api/utopinn ${utopinnWrites.length} 条`);
        console.log(`  闸表命中 ${gatedCount} · 豁免 ${exemptCount} · 漏闸 ${ungated.length}`);
    } finally {
        await stop();
    }

    if (failures.length) {
        console.error(`\n${failures.length} 项失败`);
        process.exit(1);
    }
    console.log('\n\x1b[32mPASS\x1b[0m 全部非 GET /api/utopinn 路由均有闸表条目或显式豁免');
    process.exit(0);
}

main().catch((error) => {
    console.error(`\x1b[31mERROR\x1b[0m ${error?.stack ?? error}`);
    process.exit(2);
});
