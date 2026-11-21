/**
 * character_state sidecar —— 角色卡文件旁的 `<stem>.state.<ns>.json` 读写面。
 *
 * 抽出源:endpoints/characters.js( legacy /api/characters/state/* 与
 * /api/utopinn/state/char/* 的唯一事实源)。下沉到 services/ 是为了让
 * generate-context 这类非 HTTP 面(变量宏 char 域持久化,GH#2)复用同一
 * 命名/归一/原子写规则,不复制第三份实现,也不往 endpoints 回依赖。
 *
 * 命名契约:
 *   卡文件 <stem>.png|webp|json  →  侧车 <stem>.state.<namespace>.json
 *   namespace 归一:小写 + [^a-z0-9._-]→'_',最长 96。
 *   写 = 整档原子覆写(write-file-atomic);读 = 不存在/坏 JSON → null。
 */
import path from 'node:path';
import fs from 'node:fs';
import { sync as writeFileAtomicSync } from 'write-file-atomic';
import _ from 'lodash';
import { tryParse, tryReadFileSync } from '../util.js';

export const CHARACTER_STATE_FILE_PREFIX = '.state.';
export const CHARACTER_STATE_FILE_SUFFIX = '.json';

/** 卡文件探测扩展名序(与 utopinn-library loadCharacterDocDetailed 同序)。 */
export const CHARACTER_FILE_EXTS = ['.png', '.webp', '.json'];

export function normalizeCharacterStateNamespace(namespace) {
    const raw = String(namespace || '').trim().toLowerCase();
    if (!raw) {
        return '';
    }
    return raw.replace(/[^a-z0-9._-]/g, '_').slice(0, 96);
}

export function getCharacterStateSidecarPath(characterFilePath, namespace) {
    const safeNamespace = normalizeCharacterStateNamespace(namespace);
    if (!safeNamespace) {
        return '';
    }
    const parsed = path.parse(characterFilePath);
    return path.join(parsed.dir, `${parsed.name}${CHARACTER_STATE_FILE_PREFIX}${safeNamespace}${CHARACTER_STATE_FILE_SUFFIX}`);
}

export function readCharacterStateSidecar(characterFilePath, namespace) {
    const stateFilePath = getCharacterStateSidecarPath(characterFilePath, namespace);
    if (!stateFilePath || !fs.existsSync(stateFilePath)) {
        return null;
    }
    const raw = tryReadFileSync(stateFilePath);
    if (!raw) {
        return null;
    }
    const parsed = tryParse(raw);
    if (!_.isObjectLike(parsed) || Array.isArray(parsed)) {
        console.warn(`Invalid character state sidecar JSON: ${stateFilePath}`);
        return null;
    }
    return parsed;
}

/**
 * 整档原子写一个 namespace(与 /state/char/set 同语义)。
 * @returns {string|null} 落盘文件路径;namespace 非法 → null(未写)。
 */
export function writeCharacterStateSidecar(characterFilePath, namespace, data) {
    const stateFilePath = getCharacterStateSidecarPath(characterFilePath, namespace);
    if (!stateFilePath) {
        return null;
    }
    fs.mkdirSync(path.dirname(stateFilePath), { recursive: true });
    writeFileAtomicSync(stateFilePath, JSON.stringify(data), 'utf8');
    return stateFilePath;
}

/**
 * charDir(无扩展名文件干名)→ 实际卡文件路径。
 * 探测序 = CHARACTER_FILE_EXTS(.png 优先,与库读面同序);都不存在 → null。
 * charDir 拒收路径分隔/相对段 —— 不许逃出 characters 目录。
 */
export function resolveCharacterFilePath(charactersDir, charDir) {
    if (typeof charactersDir !== 'string' || !charactersDir) return null;
    const stem = String(charDir ?? '').trim();
    if (!stem || stem === '.' || stem === '..' || /[/\\\x00]/.test(stem)) return null;
    for (const ext of CHARACTER_FILE_EXTS) {
        const filePath = path.join(charactersDir, `${stem}${ext}`);
        if (fs.existsSync(filePath)) return filePath;
    }
    return null;
}

export function getAllCharacterStateSidecarPaths(characterFilePath) {
    const parsed = path.parse(characterFilePath);
    if (!fs.existsSync(parsed.dir)) {
        return [];
    }
    const prefix = `${parsed.name}${CHARACTER_STATE_FILE_PREFIX}`;
    const files = fs.readdirSync(parsed.dir, { withFileTypes: true });
    return files
        .filter(entry => entry.isFile())
        .map(entry => entry.name)
        .filter(fileName => fileName.startsWith(prefix) && fileName.endsWith(CHARACTER_STATE_FILE_SUFFIX))
        .map(fileName => path.join(parsed.dir, fileName));
}

/** 卡文件改名(如 .webp→.png 转换)时迁移全部 state 侧车;碰撞不覆盖。 */
export function renameAllCharacterStateSidecars(sourceCharacterPath, targetCharacterPath) {
    const sourceParsed = path.parse(sourceCharacterPath);
    const targetParsed = path.parse(targetCharacterPath);
    const sourcePrefix = `${sourceParsed.name}${CHARACTER_STATE_FILE_PREFIX}`;
    const targetPrefix = `${targetParsed.name}${CHARACTER_STATE_FILE_PREFIX}`;
    const sourceFiles = getAllCharacterStateSidecarPaths(sourceCharacterPath);
    if (sourceFiles.length === 0) {
        return;
    }

    for (const sourceFilePath of sourceFiles) {
        const sourceName = path.basename(sourceFilePath);
        const namespaceWithSuffix = sourceName.slice(sourcePrefix.length);
        const targetName = `${targetPrefix}${namespaceWithSuffix}`;
        const targetFilePath = path.join(targetParsed.dir, targetName);
        if (fs.existsSync(targetFilePath)) {
            throw new Error(`Character state sidecar rename collision: ${targetFilePath}`);
        }
        fs.copyFileSync(sourceFilePath, targetFilePath);
        fs.unlinkSync(sourceFilePath);
    }
}

export function deleteAllCharacterStateSidecars(characterFilePath) {
    const sidecars = getAllCharacterStateSidecarPaths(characterFilePath);
    for (const sidecarPath of sidecars) {
        try {
            fs.unlinkSync(sidecarPath);
        } catch (error) {
            console.warn('Failed to delete character state sidecar:', sidecarPath, error);
        }
    }
}
