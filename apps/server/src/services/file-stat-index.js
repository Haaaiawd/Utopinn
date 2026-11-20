/**
 * file-stat-index —— 单文件粒度的"stat 三元组"惰性失效索引。
 *
 * 与 card-list-cache(按 stem 缓存浅字段)同源的设计,但键是具体文件
 * 绝对路径而非 charDir stem:同 stem 下不同文件(.png/.webp/.json)有独立
 * 条目,各自带自己的指纹,互不误伤。
 *
 * 失效语义:只信 stat —— {fileName, size, mtimeMs, ctimeMs} 与
 * card-list-cache 同款指纹(复用 normalizeFingerprint/sameFingerprint)。
 * 不枚举写路径挂钩:legacy edit、library PATCH、手动丢文件、外部 mv,
 * 一律靠 stat 不匹配触发 loader() 重解析。
 *
 * - loader(absPath) => value:每次未命中调一次;value 原样存入条目
 *   (可含 scripts: null 之类的"负缓存"标记,由调用方解释)。
 * - 并发 miss 按 dir+absPath 归并成同一个 in-flight promise。
 * - fingerprint 记 stat() 时点的三元组:解析期间文件被 rename 替换时,
 *   条目指纹仍是旧文件的,下一发请求自然 miss —— 宁漏不脏。
 * - maxEntries LRU 兜底防爆(touch-on-hit)。
 *
 * 工厂函数:状态活在 apply() 闭包,fiber dispose 随插件回收,不留模块级残态。
 */
import fs from 'node:fs';
import path from 'node:path';

import { normalizeFingerprint, sameFingerprint } from './card-list-cache.js';

const DEFAULT_MAX_ENTRIES = 4096;

export function createFileStatIndex({ maxEntries = DEFAULT_MAX_ENTRIES } = {}) {
    const tables = new Map(); // scopeDir -> Map<absPath, {fingerprint, value}>
    const pending = new Map();  // `${dir}\n${absPath}` -> Promise<value>

    function tableFor(dir) {
        let table = tables.get(dir);
        if (!table) {
            table = new Map();
            tables.set(dir, table);
        }
        return table;
    }

    function fingerprintOf(absPath, st) {
        return normalizeFingerprint([{
            fileName: path.basename(absPath),
            size: st.size,
            mtimeMs: st.mtimeMs,
            ctimeMs: st.ctimeMs,
        }]);
    }

    function setEntry(dir, absPath, fingerprint, value) {
        const table = tableFor(dir);
        if (table.has(absPath)) table.delete(absPath); // touch:保持 LRU 序
        table.set(absPath, { fingerprint, value });
        while (table.size > maxEntries) {
            table.delete(table.keys().next().value);
        }
    }

    return {
        /**
         * 取一个文件的缓存值;指纹未命中/负指纹 → loader() 实算并回填。
         * @param {string} dir 隔离键(如 characters 目录,天然含 handle 隔离)
         * @param {string} absPath 候选文件绝对路径
         * @param {() => Promise<*>} loader 实解析;返回的 value 原样入条目
         * @returns {Promise<{missing?: boolean, value?: *, cached?: boolean}>}
         */
        async get(dir, absPath, loader) {
            const st = await fs.promises.stat(absPath).catch(() => null);
            if (!st || !st.isFile()) return { missing: true };
            const table = tableFor(dir);
            const fp = fingerprintOf(absPath, st);
            const hit = table.get(absPath);
            if (hit && sameFingerprint(hit.fingerprint, fp)) {
                // touch:刷新 LRU 序
                table.delete(absPath);
                table.set(absPath, hit);
                return { value: hit.value, cached: true };
            }
            const pKey = `${dir}\n${absPath}`;
            let p = pending.get(pKey);
            if (!p) {
                p = Promise.resolve()
                    .then(() => loader(absPath))
                    // 记 stat 时点指纹:解析期间文件被改名替换时条目自然失配,
                    // 下次 get 走重解析 —— 宁漏不脏。
                    .then((value) => { setEntry(dir, absPath, fp, value); return value; })
                    .finally(() => { if (pending.get(pKey) === p) pending.delete(pKey); });
                pending.set(pKey, p);
            }
            const value = await p;
            return { value, cached: false };
        },

        /**
         * 写路径顺手回填(优化,非正确性依赖):拿当前磁盘 stat 立指纹。
         * 文件此刻不可 stat 时静默跳过 —— 下一发 get 会惰性重建。
         */
        put(dir, absPath, value) {
            const st = fs.statSync(absPath, { throwIfNoEntry: false });
            if (!st || !st.isFile()) return false;
            setEntry(dir, absPath, fingerprintOf(absPath, st), value);
            return true;
        },

        /** 清掉 dir 下不在 alivePaths 里的条目(卡删除/改名/换扩展名回收)。 */
        sweep(dir, alivePaths) {
            const table = tables.get(dir);
            if (!table) return;
            for (const key of table.keys()) {
                if (!alivePaths.has(key)) table.delete(key);
            }
        },

        /** 诊断用:某目录下缓存条数。 */
        size(dir) {
            return tables.get(dir)?.size ?? 0;
        },
    };
}
