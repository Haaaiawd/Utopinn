#!/usr/bin/env node
/**
 * test-cli-routes —— CLI 具名路由表的漂移测试。
 *
 * 背景:NAMED_UTOPINN_ROUTES(apps/cli/utopinn-cli.mjs)是第二张手抄表。
 * doctor 的 "capability coverage" 拿它 diff kernel 路由全集,报
 * raw-only 差集。kernel 加路由不抄 → 新面只能靠 raw 逃生舱;CLI 留
 * 死名 → named 计数虚高(已发生过:漏 5 条被 doctor 抓出)。
 *
 * 做法:起一台隔离 kernel 服(e2e harness),枚举 webServer.list()
 * HTTP 路由(排除 "upgrade|" 升级位,与 doctor 同口径);从 CLI 源文件
 * 解析 NAMED_UTOPINN_ROUTES 字面量(Set 块是稳定的 'METHOD|kind|path'
 * 单引号串列表,文件不可 import——顶层是 argv 派发)。
 *
 * 断言双向相等:
 *   kernel HTTP 路由 ⊆ NAMED —— 漏抄 → 列出未具名路由;
 *   NAMED ⊆ kernel HTTP 路由 —— 死名 → 列出服务端已无的路由。
 *
 * 跑法:node apps/server/tests/test-cli-routes.cjs
 *   (或 pnpm --filter @utopinn/server test:drift;环境变量同 e2e harness)
 * 退出码:全过 0;有未具名/死名 1;服务起不来或 CLI 表解析失败 2。
 */
'use strict';
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { bootKernelRoutes } = require('./lib/kernel-enum.cjs');

const CLI_PATH = resolve(__dirname, '..', '..', 'cli', 'utopinn-cli.mjs');
const SET_MARKER = 'NAMED_UTOPINN_ROUTES = new Set([';

const failures = [];
function fail(title, lines) {
    failures.push(title);
    console.error(`\x1b[31mFAIL\x1b[0m ${title}`);
    for (const line of lines) console.error(`      ${line}`);
}

/**
 * 从 CLI 源文件提取 NAMED_UTOPINN_ROUTES 字面量。
 * Set 块内行注释(// …)先剥掉再取单引号串;路由串只含 | 与 /,不含 ' 或 //。
 */
function parseNamedRoutes(source) {
    const start = source.indexOf(SET_MARKER);
    if (start < 0) throw new Error(`CLI 源里找不到 ${SET_MARKER}`);
    const end = source.indexOf(']);', start);
    if (end < 0) throw new Error('NAMED_UTOPINN_ROUTES Set 块未闭合(找不到 "]);")');
    const block = source.slice(start, end);
    const named = new Set();
    for (const line of block.split('\n')) {
        const code = line.replace(/\/\/.*$/, '');
        for (const m of code.matchAll(/'((?:[^'\\]|\\.)*)'/g)) {
            named.add(m[1]);
        }
    }
    if (named.size === 0) throw new Error('NAMED_UTOPINN_ROUTES 解析出 0 条 —— 字面量格式变了?');
    return named;
}

async function main() {
    const named = parseNamedRoutes(readFileSync(CLI_PATH, 'utf8'));
    const { base, routes, stop } = await bootKernelRoutes();
    try {
        // doctor 同口径:HTTP 路由全集(滤掉 upgrade| 升级位)。
        const httpRoutes = routes.filter(r => !String(r).startsWith('upgrade|'));

        const unnamed = httpRoutes.filter(r => !named.has(r));
        if (unnamed.length) {
            fail(`${unnamed.length} 条 kernel 路由在 CLI 无具名(doctor 会报 raw-only)`, unnamed);
        }

        const dead = [...named].filter(r => !httpRoutes.includes(r));
        if (dead.length) {
            fail(`${dead.length} 条 CLI 具名指向服务端不存在的路由(死名)`, dead);
        }

        console.log(`server ${base}`);
        console.log(`kernel HTTP 路由 ${httpRoutes.length} 条 · CLI 具名 ${named.size} 条`);
        console.log(`  未具名 ${unnamed.length} · 死名 ${dead.length}`);
    } finally {
        await stop();
    }

    if (failures.length) {
        console.error(`\n${failures.length} 项失败`);
        process.exit(1);
    }
    console.log('\n\x1b[32mPASS\x1b[0m CLI 具名表与 kernel 路由全集一一对应');
    process.exit(0);
}

main().catch((error) => {
    console.error(`\x1b[31mERROR\x1b[0m ${error?.stack ?? error}`);
    process.exit(2);
});
