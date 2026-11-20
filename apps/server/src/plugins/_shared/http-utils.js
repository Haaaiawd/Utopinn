/**
 * _shared/http-utils —— 插件面共享 HTTP 小件。
 *
 * 原状:六个插件直接 import { safeName, sendError } from './utopinn-library.js'
 * —— 最大的资源域插件兼作了公共库,模块层方向反了(domain-map §2.7)。
 * 现把这两件纯函数提到 plugins/_shared/:无 fiber 依赖、无路由归属,
 * 任何插件面都可引用。utopinn-library.js 保留自己的同名副本(该文件归
 * 另一格维护,不引本模块以避免跨格依赖;两份实现保持语义一致)。
 *
 *   safeName(raw, field)        路由参数资源名校验 → trim 后安全名 | 抛 400
 *   sendError(response, e, pfx) 统一错误出口:InvalidArgument→400 /
 *                               NotFound→404 / Conflict·patch→409 /
 *                               ReadOnly→503 / 其余→500(console.error 留痕)
 */
import {
    ConflictError,
    InvalidArgumentError,
    NotFoundError,
    PatchMissingParentError,
    PatchTestFailedError,
    StorageReadOnlyError,
    UnsupportedPatchOpError,
} from '../../storage/errors.js';

/** charDir/chatName 里禁止的字符:路径分隔符与 NUL(防目录穿越)。 */
const UNSAFE_NAME_RE = /[/\\\x00]/;
const MAX_NAME_LEN = 128;

/**
 * 校验路由参数里的资源名(charDir/chatName/preset/world 名)。
 * @param {string} raw
 * @param {string} field 错误消息用的字段名
 * @returns {string} trim 后的安全名;非法时抛 InvalidArgumentError → 400
 */
export function safeName(raw, field) {
    const name = String(raw ?? '').trim();
    if (!name) throw new InvalidArgumentError(`${field} is required`);
    if (UNSAFE_NAME_RE.test(name) || name === '.' || name === '..') {
        throw new InvalidArgumentError(`${field} contains unsafe characters`);
    }
    if (Buffer.byteLength(name, 'utf8') > MAX_NAME_LEN * 4) {
        // 参数侧给宽一点的上限(兼容旧数据的长文件名),写路径仍由 Repo 层收 128
        throw new InvalidArgumentError(`${field} is too long`);
    }
    return name;
}

/** 统一错误出口:InvalidArgumentError→400,NotFoundError→404,ConflictError→409,patch 语义错→对应映射,其余→500。 */
export function sendError(response, error, logPrefix) {
    if (error instanceof InvalidArgumentError) {
        return response.status(400).send({ error: error.message });
    }
    if (error instanceof NotFoundError) {
        return response.status(404).send({ error: error.message });
    }
    if (error instanceof ConflictError || error instanceof PatchTestFailedError || error instanceof PatchMissingParentError) {
        return response.status(409).send({ error: error.message });
    }
    if (error instanceof UnsupportedPatchOpError) {
        return response.status(400).send({ error: error.message });
    }
    if (error instanceof StorageReadOnlyError) {
        return response.status(503).send({ error: 'storage_read_only' });
    }
    console.error(`${logPrefix} failed:`, error);
    return response.status(500).send({ error: String(error?.message ?? error) });
}
