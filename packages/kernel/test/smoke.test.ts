import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAppContext, provideSeam } from '../src/context.js';
import { loadProfile, loadProfileFile, applyPatch, dumpConfig } from '../src/loader.js';
import { fileURLToPath } from 'node:url';
import { adaptLegacyPlugin } from '../src/legacy-adapter.js';
import type { PluginModule } from '../src/plugin.js';

const order: string[] = [];
const mk = (id: string, mod: PluginModule = {}) => ({
    id,
    module: { apply: () => { order.push(id); }, ...mod },
});

test('profile 按序装载', async () => {
    const ctx = createAppContext();
    const res = await loadProfile(ctx, {
        name: 'p',
        plugins: [mk('a'), mk('b'), mk('c')],
    });
    assert.deepEqual(order, ['a', 'b', 'c']);
    assert.equal(res.filter((r) => r.status === 'active').length, 3);
});

test('inject 缺失 → degraded 不崩不静默,后续行继续', async () => {
    const ctx = createAppContext();
    order.length = 0;
    const res = await loadProfile(ctx, {
        name: 'p',
        plugins: [
            mk('needs-svc', { inject: ['nonexistent'] }),
            mk('after'),
        ],
    });
    assert.equal(res[0].status, 'degraded');
    assert.match(res[0].reason!, /nonexistent/);
    assert.equal(res[1].status, 'active');
    assert.deepEqual(order, ['after']);
});

test('patch: 按 id 整行替换 + 追加 + disabled 保位', async () => {
    const base = [mk('a'), mk('b', { apply: () => order.push('b-old') })];
    const patch = [
        { id: 'b', module: { apply: () => order.push('b-new') } },
        mk('c'),
        { id: 'a', module: {}, disabled: true },
    ];
    order.length = 0;
    const ctx = createAppContext();
    const res = await loadProfile(ctx, { name: 'p', plugins: base }, patch);
    assert.deepEqual(order, ['b-new', 'c']);
    assert.equal(res[0].status, 'disabled');
    const dump = dumpConfig({ name: 'p', plugins: base }, patch);
    assert.match(dump, /- a/);
    assert.match(dump, /\+ c/);
});

test('waterfall: 变换链 — 请求参数固定,draft 经返回值回溯变形', async () => {
    const ctx = createAppContext();
    // cordis waterfall(name, ...args, inner):args 固定传给每个监听者,
    // inner(末参,无参)产出基值,next() 深入一层,变换在返回回溯中叠加
    ctx.on('gen.preBuild' as never, (async (next: () => Promise<string>) => {
        return (await next()) + '|A';
    }) as never);
    ctx.on('gen.preBuild' as never, (async (next: () => Promise<string>) => {
        return (await next()) + '|B';
    }) as never);
    const out = await ctx.waterfall('gen.preBuild' as never, () => 'base');
    assert.equal(out, 'base|B|A');
});

test('waterfall 带请求参数:每监听器收到同一份 req', async () => {
    const ctx = createAppContext();
    const seen: string[] = [];
    ctx.on('gen.preBuild' as never, (async (req: { card: string }, next: () => Promise<string[]>) => {
        seen.push(req.card);
        return [...(await next()), 'x'];
    }) as never);
    const out = await ctx.waterfall(
        'gen.preBuild' as never,
        { card: 'c1' } as never,
        (() => [] as string[]) as never,
    );
    assert.deepEqual(seen, ['c1']);
    assert.deepEqual(out, ['x']);
});

test('effect 清理:seam provider 卸载后回退', async () => {
    const ctx = createAppContext();
    const dispose = ctx.effect(() =>
        provideSeam(ctx, 'seam', 'promptBuilder', 'legacy', { build: () => 'legacy' }),
    );
    assert.equal(ctx.catalog.owner('promptBuilder'), 'legacy');
    await (dispose as () => Promise<void>)();
    assert.equal(ctx.catalog.owner('promptBuilder'), undefined);
});

test('profile.yaml:相对路径装载 + config 传入 + disabled 保位', async () => {
    const ctx = createAppContext();
    const yaml = fileURLToPath(
        new URL('../../test/fixtures/profile.yaml', import.meta.url),
    );
    const res = await loadProfileFile(ctx, yaml);
    assert.equal(res.find((r) => r.id === 'hello')?.status, 'active');
    assert.equal(res.find((r) => r.id === 'skipme')?.status, 'disabled');
    const g = globalThis as Record<string, unknown>;
    assert.equal(g.__helloLoaded, 1);
    assert.deepEqual(g.__helloConfig, { greeting: 'hi' });
});

test('catalog 记录服务角色清单', async () => {
    const ctx = createAppContext();
    ctx.effect(() => {
        const a = provideSeam(ctx, 'core', 'chats', 'tavern-core', {});
        const b = provideSeam(ctx, 'seam', 'promptBuilder', 'tavern-core', {});
        const c = provideSeam(ctx, 'bundle', 'generation', 'generation-orch', {});
        return () => { a(); b(); c(); };
    });
    const roles = Object.fromEntries(ctx.catalog.list().map((r) => [r.name, r.role]));
    assert.deepEqual(roles, { chats: 'core', promptBuilder: 'seam', generation: 'bundle' });
});

test('legacy ST 插件 adapter:init 拿 router,exit 走 effect', async () => {
    const ctx = createAppContext();
    const calls: string[] = [];
    const routes: string[] = [];
    const fakeRouter = (id: string) => ({
        get: (p: string) => routes.push(id + ':' + p),
        post: (p: string) => routes.push(id + ':' + p),
    });
    const res = await loadProfile(ctx, {
        name: 'p',
        plugins: [{
            id: 'legacy-img',
            module: adaptLegacyPlugin({
                info: { id: 'legacy-img', name: 'Image Store' },
                init: (r: unknown) => { calls.push('init'); (r as { get: (p: string) => void }).get('/list'); },
                exit: () => { calls.push('exit'); },
            }, { routerFactory: fakeRouter }),
        }],
    });
    assert.equal(res[0].status, 'active');
    assert.deepEqual(calls, ['init']);
    assert.deepEqual(routes, ['legacy-img:/list']);
});
