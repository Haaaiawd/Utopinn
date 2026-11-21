/**
 * embedded-world —— 卡内嵌 character_book 的物化名推导与读取(单点事实源)。
 *
 * 上游口径(Luker/SillyTavern world-info.js importEmbeddedWorldInfo):
 *   bookName = card.data.character_book.name || `${card.data.name}'s Lorebook`
 *   → saveWorldInfo 物化 + extensions.world 绑定写回卡面(writeExtensionField)。
 *   内嵌书自带 name 时用它;否则用「角色名's Lorebook」;角色名也缺时
 *   本服务用 'Unnamed' 兜底——任何带条目的内嵌书都必须得到一个名字,
 *   不许像旧实现那样 extensions.world 为空就静默丢整本书(issue #10)。
 *
 * 物化(worlds/<name>.json)与 extensions.world 绑定需要的是存储名:
 * sanitize-filename 收口 + .json/.jsonl 尾缀剥除 + 128B UTF-8 截断
 * (repo put 拒绝 sanitize 会改写或 .json 结尾的名字;SQL 主键 VARCHAR(128))。
 * 运行时装配(generate-context/mvu-settle)、TH 读面与导入物化共用同一
 * 推导 —— 三条路永远指向同一个名字。对导入早于本修复的存量卡(内嵌书
 * 未物化、无绑定),装配层按派生名查 worlds/,查不到再用
 * convertEmbeddedBook 即时转换顶上——同一个名字,两种供给方式。
 */
import sanitize from 'sanitize-filename';

import { convertCharacterBook } from '@utopinn/core';
import { cardData } from '@utopinn/formats';

/** 世界书名长度上限:与 storage/name-validation.js MAX_NAME_LEN 同口径。 */
const MAX_WORLD_NAME_BYTES = 128;
/** 上游派生名后缀:`${name}'s Lorebook`。 */
const LOREBOOK_SUFFIX = '\'s Lorebook';
/** 书名字段里混入的文件名尾缀(repo put 会拒 .json/.jsonl 结尾的名)。 */
const FILE_EXT_RE = /\.(json|jsonl)$/i;

/**
 * data.character_book.entries 条数;兼容 CCv2 数组形态与少数对象图形态。
 * @param {object} card
 * @returns {number}
 */
export function embeddedBookEntryCount(card) {
    const book = cardData(card)?.character_book;
    const entries = book?.entries;
    if (Array.isArray(entries)) return entries.length;
    if (entries && typeof entries === 'object') return Object.keys(entries).length;
    return 0;
}

/** UTF-8 安全截断:不劈多字节字符。 */
function truncateUtf8(str, maxBytes) {
    if (Buffer.byteLength(str, 'utf8') <= maxBytes) return str;
    let out = '';
    let bytes = 0;
    for (const ch of str) {
        const w = Buffer.byteLength(ch, 'utf8');
        if (bytes + w > maxBytes) break;
        out += ch;
        bytes += w;
    }
    return out;
}

/**
 * 内嵌书的物化名(存储名):上游推导 book.name || "<名>'s Lorebook",
 * 再做 sanitize/剥后缀/128B 收口。
 * @param {object} card 卡对象(v1 平铺或 v2/v3 spec)
 * @param {{nameHint?: string}} [options] 卡名全缺时的回退名(文件名干名;preview 用)
 * @returns {string|null} 无内嵌条目 → null;否则必非空('Unnamed' 兜底)。
 */
export function embeddedWorldName(card, { nameHint = '' } = {}) {
    if (embeddedBookEntryCount(card) === 0) return null;
    const data = cardData(card) ?? {};
    const book = (data.character_book && typeof data.character_book === 'object' && !Array.isArray(data.character_book))
        ? data.character_book : {};
    const fromBook = sanitize(String(book.name ?? '').trim().replace(FILE_EXT_RE, ''));
    if (fromBook) return truncateUtf8(fromBook, MAX_WORLD_NAME_BYTES);
    const base = sanitize(String(data.name ?? card?.name ?? nameHint ?? '').trim()) || 'Unnamed';
    const suffixBytes = Buffer.byteLength(LOREBOOK_SUFFIX, 'utf8');
    return `${truncateUtf8(base, MAX_WORLD_NAME_BYTES - suffixBytes)}${LOREBOOK_SUFFIX}`;
}

/**
 * 卡面生效的主世界书名:extensions.world 显式绑定优先;缺绑但有内嵌书
 * 时落到派生名(与 import 写回绑定的同一个名)。无书也无绑 → null。
 * @param {object} card
 * @param {{nameHint?: string}} [options]
 * @returns {string|null}
 */
export function primaryWorldName(card, { nameHint = '' } = {}) {
    const bound = String(cardData(card)?.extensions?.world ?? '').trim();
    if (bound) return bound;
    return embeddedWorldName(card, { nameHint });
}

/**
 * 内嵌书有条目但 extensions.world 缺绑 → 把派生名写回卡面绑定
 * (上游 `$('#character_world').val(bookName)` + writeExtensionField 的
 * 服务端等价)。仅限写卡路径调用(commit 序列化之前)——装配/读面用
 * primaryWorldName,不要 mutate。绑定先于物化落盘是故意的:即使物化
 * 失败或撞上既有同名书被跳过,卡面仍指向一个确定的名字,装配层
 * 按它解析(既有书 / 内存即时转换兜底),不留无指向的幽灵绑定。
 * @param {object} card 已整形待落盘的卡(prepareCardForStorage 之后)
 * @param {{nameHint?: string}} [options]
 * @returns {{worldName: string|null, fallback: boolean}|null}
 *   null = 无内嵌条目;fallback=true 表示名字是派生的(非卡面原绑)。
 */
export function bindEmbeddedWorld(card, { nameHint = '' } = {}) {
    if (embeddedBookEntryCount(card) === 0) return null;
    const data = cardData(card);
    const ext = (data.extensions && typeof data.extensions === 'object' && !Array.isArray(data.extensions))
        ? data.extensions : (data.extensions = {});
    const bound = String(ext.world ?? '').trim();
    if (bound) return { worldName: bound, fallback: false };
    const derived = embeddedWorldName(card, { nameHint });
    if (derived) ext.world = derived;
    return { worldName: derived, fallback: true };
}

/**
 * 内嵌书 → world doc(convertCharacterBook 输出)。对象图形态的
 * entries 先铺平成数组——convertCharacterBook 走 .forEach,原样喂
 * 对象图会直接 TypeError(组装层一旦撞上就是整轮 generate 崩)。
 * @param {object} card
 * @returns {object|null} {entries:{uid:entry}, originalData} 或 null(无书/空书)
 */
export function convertEmbeddedBook(card) {
    const book = cardData(card)?.character_book;
    if (!book || typeof book !== 'object' || Array.isArray(book)) return null;
    const entries = Array.isArray(book.entries) ? book.entries : Object.values(book.entries ?? {});
    if (!entries.length) return null;
    return convertCharacterBook({ ...book, entries });
}
