// config.yaml 轻量读写器(纯函数,零外部 YAML 依赖)——
// 只解析/原位改写顶层标量键与一层嵌套键(storage.mode / protocol.ipv4|ipv6),
// 保留原文件全部注释、键序与缩进;表单开关与原文 textarea 共享同一份 content 串,
// 服务端 /api/users/config/save 内置完整 yaml.parse + validateConfigSafety 兜底。

export interface ConfigAccessFlags {
    listen: boolean;
    whitelistMode: boolean;
    basicAuthMode: boolean;
    perUserBasicAuth: boolean;
    enableUserAccounts: boolean;
    enableServerPlugins: boolean;
    securityOverride: boolean;
}

export interface ConfigSummary {
    dataRoot: string;
    port: string;
    storageMode: string;
    ipv4: string;
    ipv6: string;
    access: ConfigAccessFlags;
}

/** 剥除标量值尾部行内注释与成对引号。 */
function cleanScalar(raw: string): string {
    const trimmed = raw.trim();
    if (!trimmed) return '';
    if ((trimmed.startsWith('"') && trimmed.indexOf('"', 1) > 0)
        || (trimmed.startsWith("'") && trimmed.indexOf("'", 1) > 0)) {
        const q = trimmed[0]!;
        const end = trimmed.indexOf(q, 1);
        return trimmed.slice(1, end);
    }
    return trimmed.replace(/\s+#.*$/, '').trim();
}

/** 读顶层 `key: value` 行(要求行首无缩进)。 */
export function readYamlTopScalar(content: string, key: string): string | null {
    const lines = content.split(/\r?\n/);
    const prefix = `${key}:`;
    for (const line of lines) {
        if (!line || line[0] === ' ' || line[0] === '\t' || line[0] === '#') continue;
        if (line.startsWith(prefix)) {
            const after = line.slice(prefix.length);
            if (after === '' || after[0] === ' ' || after[0] === '\t') {
                return cleanScalar(after);
            }
        }
    }
    return null;
}

/** 读一层嵌套 `section:\n  childKey: value`。 */
export function readYamlNestedScalar(content: string, section: string, childKey: string): string | null {
    const lines = content.split(/\r?\n/);
    let inSection = false;
    const secPrefix = `${section}:`;
    for (const line of lines) {
        if (!line.trim() || line.trimStart().startsWith('#')) continue;
        const indent = line.length - line.trimStart().length;
        if (indent === 0) {
            inSection = line.startsWith(secPrefix) && (line.length === secPrefix.length || /\s/.test(line[secPrefix.length]!));
            continue;
        }
        if (inSection) {
            const trimmed = line.trimStart();
            if (trimmed.startsWith(`${childKey}:`)) {
                const after = trimmed.slice(childKey.length + 1);
                if (after === '' || after[0] === ' ' || after[0] === '\t') {
                    return cleanScalar(after);
                }
            }
        }
    }
    return null;
}

export function readYamlBool(content: string, key: string, fallback: boolean): boolean {
    const v = readYamlTopScalar(content, key);
    if (v === null) return fallback;
    const low = v.toLowerCase();
    if (low === 'true') return true;
    if (low === 'false') return false;
    return fallback;
}

/** 原位替换顶层布尔键的值,保留行尾注释与换行风格;若键缺失则追加到文末。 */
export function setYamlTopBool(content: string, key: string, value: boolean): string {
    const eol = content.includes('\r\n') ? '\r\n' : '\n';
    const lines = content.split(/\r?\n/);
    const prefix = `${key}:`;
    const nextVal = value ? 'true' : 'false';
    let replaced = false;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (!line || line[0] === ' ' || line[0] === '\t' || line[0] === '#') continue;
        if (line.startsWith(prefix)) {
            const after = line.slice(prefix.length);
            if (after === '' || after[0] === ' ' || after[0] === '\t') {
                const commentMatch = after.match(/(\s+#.*)$/);
                const comment = commentMatch ? commentMatch[1] : '';
                lines[i] = `${key}: ${nextVal}${comment}`;
                replaced = true;
                break;
            }
        }
    }

    if (!replaced) {
        const base = content.endsWith('\n') || content === '' ? content : `${content}${eol}`;
        return `${base}${key}: ${nextVal}${eol}`;
    }
    return lines.join(eol);
}

/** 提取 config.yaml 关键摘要供总览与配置访问区消费。 */
export function parseConfigSummary(content: string): ConfigSummary {
    return {
        dataRoot: readYamlTopScalar(content, 'dataRoot') ?? './data',
        port: readYamlTopScalar(content, 'port') ?? '8000',
        storageMode: readYamlNestedScalar(content, 'storage', 'mode') ?? 'fs',
        ipv4: readYamlNestedScalar(content, 'protocol', 'ipv4') ?? 'true',
        ipv6: readYamlNestedScalar(content, 'protocol', 'ipv6') ?? 'false',
        access: {
            listen: readYamlBool(content, 'listen', false),
            whitelistMode: readYamlBool(content, 'whitelistMode', true),
            basicAuthMode: readYamlBool(content, 'basicAuthMode', false),
            perUserBasicAuth: readYamlBool(content, 'perUserBasicAuth', false),
            enableUserAccounts: readYamlBool(content, 'enableUserAccounts', false),
            enableServerPlugins: readYamlBool(content, 'enableServerPlugins', false),
            securityOverride: readYamlBool(content, 'securityOverride', false),
        },
    };
}

/** 对比前后 config.yaml 文本中涉及安全/网络/插件装载的关键布尔键变更。 */
export function diffCriticalConfigKeys(before: string, after: string): { key: keyof ConfigAccessFlags; from: boolean; to: boolean }[] {
    const a = parseConfigSummary(before).access;
    const b = parseConfigSummary(after).access;
    const keys: (keyof ConfigAccessFlags)[] = [
        'listen',
        'whitelistMode',
        'basicAuthMode',
        'perUserBasicAuth',
        'enableUserAccounts',
        'enableServerPlugins',
        'securityOverride',
    ];
    const out: { key: keyof ConfigAccessFlags; from: boolean; to: boolean }[] = [];
    for (const k of keys) {
        if (a[k] !== b[k]) out.push({ key: k, from: a[k], to: b[k] });
    }
    return out;
}

/** 字节 → 可读单位(B / KB / MB / GB)。 */
export function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes < 0) return '—';
    if (bytes < 1024) return `${Math.round(bytes)} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** 秒 → 运行时长短串(如 3d 4h / 2h 15m / 42s)。 */
export function formatUptime(sec: number): string {
    if (!Number.isFinite(sec) || sec < 0) return '—';
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
}
