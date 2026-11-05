/**
 * FsEngine per-handle 事务串行化回归钉(audit persistence — fs TOCTOU)。
 * fs 引擎没有真事务:get→check→put 三步 await 交错会丢写。
 * withTransaction 现在链 per-handle tail,与 SqliteEngine 同构。
 * 跑法:node --test tests/storage/fs-engine-serialization.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTempFsEngine } from './harness/fs-harness.js';

test('concurrent read-modify-write txs lose no updates (TOCTOU)', async () => {
    const h = await makeTempFsEngine();
    try {
        const key = { kind: 'chat', handle: h.handle, charDir: 'A', name: 'c' };
        await h.engine.withTransaction(h.handle, async (tx) => {
            await tx.putResource(key, {
                header: { n: 0 }, body: [], integrity: 'I0', updatedAt: 1, createdAt: 1,
            });
        });

        // N 个并发 read-modify-write:每个把 header.n +1 写回。
        // 无串行化时全部读到 n=0 → 都写 n=1 → final=1;串行化后 final=N。
        const N = 8;
        await Promise.all(Array.from({ length: N }, () =>
            h.engine.withTransaction(h.handle, async (tx) => {
                const cur = await tx.getResource(key);
                await new Promise((r) => setTimeout(r, 5)); // 撑大交错窗口
                await tx.putResource(key, { ...cur, header: { n: cur.header.n + 1 } });
            }),
        ));

        const final = await h.engine.withTransaction(h.handle, (tx) => tx.getResource(key));
        assert.equal(final.header.n, N);
    } finally {
        h.cleanup();
    }
});

test('CAS putResourceIfMatch under concurrency: exactly one winner', async () => {
    const h = await makeTempFsEngine();
    try {
        const key = { kind: 'chat', handle: h.handle, charDir: 'A', name: 'c2' };
        await h.engine.withTransaction(h.handle, async (tx) => {
            await tx.putResource(key, {
                header: {}, body: [], integrity: 'V1', updatedAt: 1, createdAt: 1,
            });
        });

        const results = await Promise.all(Array.from({ length: 6 }, (_, i) =>
            h.engine.withTransaction(h.handle, async (tx) => {
                const r = await tx.putResourceIfMatch(key, 'V1', {
                    header: { winner: i }, body: [], integrity: `W${i}`, updatedAt: 2, createdAt: 1,
                });
                return r.updated;
            }),
        ));
        assert.equal(results.filter(Boolean).length, 1, 'exactly one CAS may win');
    } finally {
        h.cleanup();
    }
});

test('a failing tx does not poison the next caller on the tail', async () => {
    const h = await makeTempFsEngine();
    try {
        await assert.rejects(
            h.engine.withTransaction(h.handle, async () => { throw new Error('boom'); }),
            /boom/,
        );
        // 下一个同 handle 事务必须正常执行(尾链吞掉上个失败)。
        const ok = await h.engine.withTransaction(h.handle, (tx) => tx.getResource(
            { kind: 'chat', handle: h.handle, charDir: 'A', name: 'none' },
        ));
        assert.equal(ok, null);
    } finally {
        h.cleanup();
    }
});
