/**
 * shared-library —— 实例级共享卡池(形态 A:只读池 + copy-on-write)。
 *
 * `<dataRoot>/_library/characters/` 放共享卡(PNG/webp/JSON,单文件卡片,
 * 平铺不递归)。定位与 `_shared/secrets.json` 同风格 —— 在任何 user root
 * 之外,天然不进 per-user backup / settings doc / sync 面。
 *
 * 语义(调研定案):
 *   - 读面合并:卡列表/详情/生成/状态侧车读「用户私有目录 ∪ _library」,
 *     同名(同 charDir stem)冲突时私有优先 —— 私有卡天然遮蔽共享卡。
 *   - 编辑即物化:对共享卡的写(PATCH/regex 写/显式 install)先把整卡
 *     拷进用户 characters 目录,之后按私有卡走;绝不原地改共享档。
 *   - 红线:聊天/变量/secrets/jobs/CardApp 运行时永远 per-user;写锚
 *     (resolveCharacterWriteAnchor)对共享卡返回用户目录合成路径,任何
 *     侧车/状态写都落不到 _library。
 *
 * 守卫:charDir 穿越校验(./../路径分隔/NUL)与 _library 保留名 —
 *   `_library` 不许作为 charDir 被寻址(大小写不敏感,池内同名卡文件也
 *   不可见)。
 */

import fs from 'node:fs';
import path from 'node:path';

import { read as readCharacterCard } from '../character-card-parser.js';
import { NotFoundError } from '../storage/errors.js';
import { readCharacterStateSidecar, resolveCharacterFilePath } from './character-state.js';

/** 共享池根目录名(实例级,非 per-user)。 */
export const SHARED_LIBRARY_DIRNAME = '_library';
/** 共享卡子目录(预留未来 worlds/presets 同形池)。 */
export const SHARED_CHARACTERS_SUBDIR = 'characters';

/**
 * `<dataRoot>/_library/characters`。
 * DATA_ROOT 未就绪(纯单测)时由 directories.root(<dataRoot>/<handle>)
 * 反推 dataRoot;两者皆无 → null,共享层恒 miss(与 getSharedSecretsRoot 同策略)。
 * @param {import('../users.js').UserDirectoryList} [directories]
 * @returns {string|null}
 */
export function getSharedCharactersDir(directories) {
    const dataRoot = globalThis.DATA_ROOT
        || (typeof directories?.root === 'string' && directories.root ? path.dirname(directories.root) : '');
    return dataRoot ? path.join(dataRoot, SHARED_LIBRARY_DIRNAME, SHARED_CHARACTERS_SUBDIR) : null;
}

/**
 * 共享池可用干名:基本形(非空/非 . ../无分隔 NUL)+ 保留名闸。
 * `_library` 作为 charDir 寻址恒拒 —— 防把池目录本身当卡读;大小写不敏感
 * 收住大小写异写绕闸(case-insensitive FS 上同文件)。
 */
export function isSafeSharedStem(charDir) {
    const stem = String(charDir ?? '').trim();
    if (!stem || stem === '.' || stem === '..' || /[/\\\x00]/.test(stem)) return false;
    return stem.toLowerCase() !== SHARED_LIBRARY_DIRNAME;
}

/**
 * 共享池内卡文件寻址:stem 守卫 + .png/.webp/.json 探测序(与私有面同序)。
 * @returns {{filePath:string, fileName:string, ext:string}|null}
 */
export function resolveSharedCharacterFile(directories, charDir) {
    const dir = getSharedCharactersDir(directories);
    if (!dir || !isSafeSharedStem(charDir)) return null;
    const filePath = resolveCharacterFilePath(dir, charDir);
    if (!filePath) return null;
    return { filePath, fileName: path.basename(filePath), ext: path.extname(filePath).toLowerCase() };
}

/**
 * 合并寻址:私有 characters 优先(同名遮蔽),再共享池。
 * @returns {{filePath:string, fileName:string, ext:string, shared:boolean}|null}
 */
export function resolveCharacterFileMerged(directories, charDir) {
    const privatePath = resolveCharacterFilePath(directories?.characters, charDir);
    if (privatePath) {
        return { filePath: privatePath, fileName: path.basename(privatePath), ext: path.extname(privatePath).toLowerCase(), shared: false };
    }
    const shared = resolveSharedCharacterFile(directories, charDir);
    return shared ? { ...shared, shared: true } : null;
}

/**
 * 共享池内任意文件的安全路径(thumbnail / 静态面兜底用)。
 * 文件名守卫同 resolveCharacterFilePath 的穿越闸:拒分隔/NUL/./..;
 * `_library` 干名同样拒(与 isSafeSharedStem 一致)。
 * @param {string} fileName 文件名(可带子目录,如 sprites 场景;v1 池平铺只喂单文件名)
 * @returns {string|null} 存在即绝对路径,否则 null
 */
export function resolveSharedLibraryFilePath(directories, fileName) {
    const dir = getSharedCharactersDir(directories);
    if (!dir) return null;
    const name = String(fileName ?? '').trim();
    if (!name || name === '.' || name === '..' || /[\x00]/.test(name)) return null;
    const filePath = path.join(dir, name);
    const resolved = path.resolve(filePath);
    if (resolved !== path.resolve(dir) && !resolved.startsWith(path.resolve(dir) + path.sep)) return null;
    const stem = path.parse(name).name;
    if (stem.toLowerCase() === SHARED_LIBRARY_DIRNAME) return null;
    return fs.existsSync(resolved) ? resolved : null;
}

/**
 * 单目录卡解析:<charDir>.png(或 .webp)优先,退回 <charDir>.json。
 * 与 utopinn-library loadCharacterDocDetailed 同一探测序 —— 那是本函数
 * 的私有目录特化。
 * @param {string} dir 卡目录绝对路径
 * @param {string} charDir
 * @returns {Promise<{card: object|null, source: {kind:'image', filePath:string, ext:string}|{kind:'json', filePath:string}|null}>}
 */
export async function loadCharacterDocFromDir(dir, charDir) {
    if (typeof dir !== 'string' || !dir) return { card: null, source: null };
    for (const ext of ['.png', '.webp']) {
        const filePath = path.join(dir, `${charDir}${ext}`);
        try {
            const raw = await fs.promises.readFile(filePath);
            return { card: JSON.parse(readCharacterCard(raw)), source: { kind: 'image', filePath, ext } };
        } catch {
            // 该扩展名不存在或不含卡数据 → 继续尝试下一个
        }
    }
    try {
        const filePath = path.join(dir, `${charDir}.json`);
        const raw = await fs.promises.readFile(filePath, 'utf8');
        return { card: JSON.parse(raw), source: { kind: 'json', filePath } };
    } catch {
        return { card: null, source: null };
    }
}

/**
 * 合并读卡:私有目录在场(任一卡扩展名文件)即私有源 —— 私有不可解析时
 * 也不落共享(同名遮蔽是文件级,不是「私有坏了借共享」)。
 * @returns {Promise<{card: object|null, source: object|null, shared: boolean}>}
 */
export async function loadCharacterDocMerged(directories, charDir) {
    if (resolveCharacterFilePath(directories?.characters, charDir)) {
        const doc = await loadCharacterDocFromDir(directories.characters, charDir);
        return { ...doc, shared: false };
    }
    if (!isSafeSharedStem(charDir)) return { card: null, source: null, shared: false };
    const libDir = getSharedCharactersDir(directories);
    if (!libDir || !resolveCharacterFilePath(libDir, charDir)) {
        return { card: null, source: null, shared: false };
    }
    const doc = await loadCharacterDocFromDir(libDir, charDir);
    return { ...doc, shared: true };
}

/**
 * 物化:共享卡整档拷进用户 characters 目录(copy-on-write 落点)。
 *   - 目标干名只在「私有卡文件」层面避让(.png/.webp/.json 任一在场即撞);
 *     chats/<stem> 目录不挡 —— 那些会话本来就是这张卡聊出来的,物化后
 *     应继续挂在同 stem 下。
 *   - `<stem>.state.*.json` 发布侧车随迁(目标已存在不覆盖):物化后卡转
 *     私有,读面不再回落 _library,不迁会丢发布者随卡的初始态。
 *   - 扩展名保持源档(.webp 原样拷,不转码)。
 * @returns {Promise<{charDir:string, fileName:string, filePath:string, source:{filePath:string,fileName:string,ext:string}}>}
 * @throws {NotFoundError} 共享卡不存在
 */
export async function materializeSharedCharacter(directories, charDir) {
    const shared = resolveSharedCharacterFile(directories, charDir);
    if (!shared) {
        throw new NotFoundError(`Shared character not found: ${charDir}`);
    }
    await fs.promises.mkdir(directories.characters, { recursive: true });

    let stem = charDir;
    for (let i = 1; resolveCharacterFilePath(directories.characters, stem); i++) {
        stem = `${charDir}${i}`;
    }
    const fileName = `${stem}${shared.ext}`;
    const filePath = path.join(directories.characters, fileName);
    await fs.promises.copyFile(shared.filePath, filePath, fs.constants.COPYFILE_EXCL);

    // 发布侧车随迁:<stem>.state.<ns>.json;撞名(用户已有同干名侧车)不覆盖。
    if (stem === charDir) {
        const libDir = path.dirname(shared.filePath);
        const prefix = `${charDir}.state.`;
        let entries = [];
        try { entries = await fs.promises.readdir(libDir, { withFileTypes: true }); } catch { /* 池不可读 → 跳过随迁 */ }
        for (const entry of entries) {
            if (!entry.isFile() || !entry.name.startsWith(prefix) || !entry.name.endsWith('.json')) continue;
            const targetPath = path.join(directories.characters, entry.name);
            try {
                await fs.promises.copyFile(path.join(libDir, entry.name), targetPath, fs.constants.COPYFILE_EXCL);
            } catch { /* 已存在/失败不阻塞物化 —— 卡档已是事实源 */ }
        }
    }
    return { charDir: stem, fileName, filePath, source: shared };
}

/**
 * 写锚:char_state 侧车这类「按 stem 命名、落点必须 per-user」的写面用。
 * 返回的 filePath 只供 getCharacterStateSidecarPath 取 dir+stem ——
 *   私有卡在场 → 实档;仅共享卡在场 → 用户目录同名合成锚(文件不必存在,
 *   侧车名只取干名);都不在 → null(调用方按「卡不存在」语义处理)。
 * 绝不返回 _library 路径 —— 共享档不可写。
 */
export function resolveCharacterWriteAnchor(directories, charDir) {
    const privatePath = resolveCharacterFilePath(directories?.characters, charDir);
    if (privatePath) return privatePath;
    const shared = resolveSharedCharacterFile(directories, charDir);
    if (!shared) return null;
    return path.join(directories.characters, shared.fileName);
}

/**
 * char_state 侧车合并读:用户目录同名侧车优先(用户自己的状态压倒一切),
 * 共享卡在场时再回落发布侧车(<lib>/<stem>.state.<ns>.json)。
 * @param {string} charDir 卡干名(调用方有 avatar 文件名时先剥扩展名)
 * @param {string} namespace 已 normalize 的 ns
 * @returns {object|null}
 */
export function readCharacterStateMerged(directories, charDir, namespace) {
    const stem = String(charDir ?? '').trim();
    if (!stem) return null;
    // 干名锚定即可 —— 侧车名只取 stem,合成 .png 锚与实档等价。
    const userAnchor = path.join(directories.characters, `${stem}.png`);
    const own = readCharacterStateSidecar(userAnchor, namespace);
    if (own != null) return own;
    const shared = resolveSharedCharacterFile(directories, stem);
    if (!shared) return null;
    return readCharacterStateSidecar(shared.filePath, namespace);
}
