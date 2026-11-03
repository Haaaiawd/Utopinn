/**
 * STscript 内部小工具 — 移植自 ref/Luker:
 * utils.js(isTrueBoolean/isFalseBoolean/uuidv4/delay/escapeRegex/stringToRange/
 * escapeHtml)、script.js(removeMacros/extractMessageBias)、
 * RossAscends-mods.js(getMessageTimeStamp)。
 * convertValueType 因依赖 SlashCommandClosure 而放在 var-store.ts。
 */

/**
 * utils.js isTrueBoolean:'on'|'true'|'1'(忽略大小写与首尾空白)。
 * 原版对非 string 非 nullish 输入会抛 TypeError;这里用可选链容忍为 false,
 * 对解析器产出的全部字符串输入行为一致。
 */
export function isTrueBoolean(arg: unknown): boolean {
    return ['on', 'true', '1'].includes((arg as string | null | undefined)?.trim?.()?.toLowerCase() ?? '');
}

/** utils.js isFalseBoolean:'off'|'false'|'0'(同上)。 */
export function isFalseBoolean(arg: unknown): boolean {
    return ['off', 'false', '0'].includes((arg as string | null | undefined)?.trim?.()?.toLowerCase() ?? '');
}

/** utils.js uuidv4 — 优先 crypto.randomUUID,退回模板随机。 */
export function uuidv4(): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

/** utils.js delay — setTimeout Promise。 */
export function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/** RossAscends-mods.js getMessageTimeStamp — ISO 时间串。 */
export function getMessageTimeStamp(timestamp: number = Date.now()): string {
    const date = new Date(timestamp);
    return date.toISOString();
}

/** script.js removeMacros — 剥掉所有 {{...}} 并 trim。 */
export function removeMacros(str: string | null | undefined): string {
    return (str ?? '').replace(/\{\{[\s\S]*?\}\}/gm, '').trim();
}

/**
 * script.js extractMessageBias — 原版用 Handlebars 注册 `bias` helper 收集
 * `{{bias ...}}` 文本;这里以等价扫描提取参数,去掉成对引号,join ' ',
 * 前缀补一个空格(与原版 ` ${biasMatches.join(' ')}` 一致)。
 */
export function extractMessageBias(message: string | null | undefined): string {
    if (!message) {
        return '';
    }

    const biasMatches: string[] = [];
    // {{bias "text"}} / {{bias 'text'}} / {{bias text}} — 等价 Handlebars 首个位置参数
    const re = /\{\{\s*bias\s+("([^"]*)"|'([^']*)'|[^}\s]+)\s*\}\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(message)) !== null) {
        const token = m[1] ?? '';
        biasMatches.push(m[2] ?? m[3] ?? token);
    }

    if (biasMatches.length > 0) {
        return ` ${biasMatches.join(' ')}`;
    }
    return '';
}

/** utils.js stringToRange — "a-b" 或单值 → {start,end};越界/非法返回 null。 */
export function stringToRange(input: unknown, min: number, max: number): { start: number; end: number } | null {
    let start: number, end: number;
    const str = typeof input === 'string' ? input : String(input);

    if (str.includes('-')) {
        const parts = str.split('-');
        start = parts[0] ? parseInt(parts[0], 10) : NaN;
        end = parts[1] ? parseInt(parts[1], 10) : NaN;
    } else {
        start = end = parseInt(str, 10);
    }

    if (isNaN(start) || isNaN(end) || start > end || start < min || end > max) {
        return null;
    }

    return { start, end };
}

/** utils.js escapeHtml — doReturn 的 *-text 通道用。 */
export function escapeHtml(str: unknown): string {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}
