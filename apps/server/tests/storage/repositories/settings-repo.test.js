import { CONTRACT_HARNESSES } from '../harness/contract-harness.js';
import { SettingsRepo } from '../../../src/storage/repositories/settings-repo.js';
import { NotFoundError } from '../../../src/storage/errors.js';

describe.each(CONTRACT_HARNESSES)('SettingsRepo on $name', ({ make }) => {
    let h, repo;
    beforeEach(async () => {
        h = await make();
        repo = new SettingsRepo({ engine: h.engine });
    });
    afterEach(() => h.cleanup());

    test('get returns null when no settings file', async () => {
        expect(await repo.get(h.handle)).toBeNull();
    });

    test('save writes whole doc; get reads it back', async () => {
        await repo.save(h.handle, { user_avatar: 'a.png', power_user: { x: 1 } });
        expect(await repo.get(h.handle)).toEqual({ user_avatar: 'a.png', power_user: { x: 1 } });
    });

    test('save overwrites existing doc', async () => {
        await repo.save(h.handle, { a: 1 });
        await repo.save(h.handle, { b: 2 });
        expect(await repo.get(h.handle)).toEqual({ b: 2 });
    });

    test('patch applies json-patch ops and returns new doc', async () => {
        await repo.save(h.handle, { a: 1, b: { c: 2 } });
        const next = await repo.patch(h.handle, [
            { op: 'replace', path: '/a', value: 9 },
            { op: 'add', path: '/b/d', value: 3 },
        ]);
        expect(next).toEqual({ a: 9, b: { c: 2, d: 3 } });
        expect(await repo.get(h.handle)).toEqual({ a: 9, b: { c: 2, d: 3 } });
    });

    test('patch throws when test op fails (signals 409 at endpoint)', async () => {
        await repo.save(h.handle, { a: 1 });
        await expect(repo.patch(h.handle, [{ op: 'test', path: '/a', value: 99 }]))
            .rejects.toThrow(/json patch test failed/);
    });

    test('patch on missing settings throws NotFoundError', async () => {
        await expect(repo.patch(h.handle, [{ op: 'replace', path: '/a', value: 1 }]))
            .rejects.toBeInstanceOf(NotFoundError);
    });

    test('update runs read-modify-write inside the tx critical section', async () => {
        await repo.save(h.handle, { a: 1 });
        // 慢 fn 占住临界区;若 fn 不在 tx 内跑,fast 会基于过期快照
        // 覆写 → _tortoise 或 _hare 必丢其一。
        const slow = repo.update(h.handle, async (doc) => {
            await new Promise((r) => setTimeout(r, 30));
            return { ...doc, _tortoise: 1 };
        });
        const fast = repo.update(h.handle, (doc) => ({ ...doc, _hare: 2 }));
        await Promise.all([slow, fast]);
        expect(await repo.get(h.handle)).toEqual({ a: 1, _tortoise: 1, _hare: 2 });
    });

    test('update uses base for missing/non-object doc; fn throw writes nothing', async () => {
        const wrote = await repo.update(h.handle, (doc) => ({ ...doc, x: 1 }));
        expect(wrote).toEqual({ x: 1 });
        expect(await repo.get(h.handle)).toEqual({ x: 1 });

        await expect(repo.update(h.handle, () => { throw new Error('boom'); }))
            .rejects.toThrow('boom');
        expect(await repo.get(h.handle)).toEqual({ x: 1 }); // 全滚,盘上不动
    });
});
