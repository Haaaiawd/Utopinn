// zip.ts — fflate 薄封装:charx/byaf 都是 zip 容器。
// unzipSync 返回的路径未规范化,这里统一 normalize(对齐 util.js:normalizeZipEntryPath)。
import { unzipSync } from 'fflate';

export function normalizeZipEntryPath(name: string): string {
    return String(name)
        .replace(/\\/g, '/')
        .replace(/\/+/g, '/')
        .replace(/^\.\//, '')
        .replace(/^\//, '');
}

/** 全量解包 → Map<规范化路径, bytes>。目录项跳过。 */
export function unzipEntries(buf: Uint8Array): Map<string, Uint8Array> {
    const files = unzipSync(buf);
    const out = new Map<string, Uint8Array>();
    for (const [name, data] of Object.entries(files)) {
        const n = normalizeZipEntryPath(name);
        if (n.endsWith('/')) continue;
        out.set(n, data);
    }
    return out;
}

/** 按路径取单文件;大小写不敏感的兜底查找(有些打包器大小写飘)。 */
export function unzipFile(buf: Uint8Array, path: string): Uint8Array | null {
    const target = normalizeZipEntryPath(path);
    for (const [name, data] of unzipEntries(buf)) {
        if (name === target || name.toLowerCase() === target.toLowerCase()) return data;
    }
    return null;
}
