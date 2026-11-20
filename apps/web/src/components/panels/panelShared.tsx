// 板块共享件 —— ctx 解析(s.chat → 服务端 target)、远端数据 hook、
// 通用空态/错误态、MVU stat_data 铺平。SPEC-DATA 时代面板吃 shell 假数据;
// 真接后数据一律经 api 层进来,这里只收编共用的取数/落空骨架。
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useI18n } from '../../i18n';
import { Icon, type IconName } from '../Icon';
import type { ChatStateTarget } from '../../api/state';
import type { ThCallTarget } from '../../api/th';
import type { ChatSummary } from '../../types';

/**
 * 当前会话 → chat_state / mvu / th 服务端 target。
 * 无选中会话(或会话缺 charDir/chatName,如未接的舞台形态占位行)→ null,
 * 面板据此渲染「选卡后可用」引导空态,不许拿默认卡名硬造请求。
 */
export function chatStateTarget(chat: ChatSummary | null): ChatStateTarget | null {
    if (!chat?.charDir || !chat?.chatName) return null;
    return { avatar_url: `${chat.charDir}.png`, file_name: `${chat.chatName}.jsonl` };
}

/** 同上 → /th/call 的 target 形(charDir/chatName 原名,不带扩展)。 */
export function thCallTarget(chat: ChatSummary | null): ThCallTarget | null {
    if (!chat?.charDir || !chat?.chatName) return null;
    return { charDir: chat.charDir, chatName: chat.chatName };
}

/** 会话身份键 —— 换会话时取数 effect 的依赖。无 ctx → null(不取数)。 */
export function chatKey(chat: ChatSummary | null): string | null {
    return chat?.charDir && chat?.chatName ? `${chat.charDir}/${chat.chatName}` : null;
}

export interface Remote<T> {
    data: T | null;
    error: string | null;
    loading: boolean;
    reload: () => void;
}

/**
 * key → Promise 的取数 hook:key=null 不发请求(无 ctx 引导态);
 * key 变化清空 data 并重取(防上一 ctx 的残留数据闪进新面板),乱序
 * 回包用 seq 丢弃;reload 保留旧 data 重取(错误重试/写后刷新不闪屏)。
 */
export function useRemote<T>(key: string | null, load: () => Promise<T>): Remote<T> {
    const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({
        data: null, error: null, loading: false,
    });
    const seq = useRef(0);
    const loadRef = useRef(load);
    loadRef.current = load;

    const run = useCallback((keepData: boolean) => {
        const my = ++seq.current;
        setState((prev) => ({ data: keepData ? prev.data : null, error: null, loading: true }));
        loadRef.current()
            .then((d) => { if (seq.current === my) setState({ data: d, error: null, loading: false }); })
            .catch((e) => {
                if (seq.current === my) {
                    setState({ data: null, error: e instanceof Error ? e.message : String(e), loading: false });
                }
            });
    }, []);

    useEffect(() => {
        if (key === null) {
            seq.current += 1; // 作废在途请求
            setState({ data: null, error: null, loading: false });
            return;
        }
        run(false); // key 换了 → 旧 data 属上一 ctx,清掉
    }, [key, run]);

    return { ...state, reload: useCallback(() => run(true), [run]) };
}

/** 引导空态:无 ctx(未选会话)或真·空数据共用,icon + 一行话,不装假。 */
export function PanelEmpty({ icon, children }: { icon: IconName; children: ReactNode }) {
    return (
        <div className="flex h-full min-h-[160px] flex-col items-center justify-center gap-2.5 p-6 text-center">
            <Icon name={icon} size={20} className="text-[color:var(--fg-faint)]" />
            <div className="text-[11.5px] leading-relaxed text-[color:var(--fg-faint)]">{children}</div>
        </div>
    );
}

/** 取数失败态:错误原文 + 重试 —— 诚实路径,不吞错不降级成假数据。 */
export function PanelError({ error, onRetry }: { error: string; onRetry: () => void }) {
    const { t } = useI18n();
    return (
        <div className="flex h-full min-h-[160px] flex-col items-center justify-center gap-2.5 p-6 text-center">
            <Icon name="warning" size={18} className="text-[color:var(--fg-faint)]" />
            <div className="max-w-full break-all font-mono-ui text-[10.5px] leading-relaxed text-[color:var(--fg-faint)]">{error}</div>
            <button className="ghost-btn h-6 px-2.5 text-[10.5px]" onClick={onRetry}>{t('panel.retry')}</button>
        </div>
    );
}

/* ----------------------------------------------------------------------- */
/* MVU stat_data 铺平                                                        */
/* ----------------------------------------------------------------------- */

export interface MvuVarRow {
    /** lodash 式路径(嵌套对象拍平成点号连接)。 */
    path: string;
    /** 展示值(primitive 原样;数组/对象收摘要;[v,"说明"] 元组取 v)。 */
    text: string;
    /** 数值型才给 —— 供面板做数值显示/运算判断。 */
    num?: number;
    /** ValueWithDescription 的说明串。 */
    desc?: string;
}

function fmtMvuValue(v: unknown): string {
    if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(2);
    if (typeof v === 'string') return v;
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (v === null || v === undefined) return '—';
    if (Array.isArray(v)) return `[${v.length}]`;
    return `{${Object.keys(v as object).length}}`;
}

const isVwd = (v: unknown): v is [unknown, string] =>
    Array.isArray(v) && v.length === 2 && typeof v[1] === 'string';

/**
 * stat_data(嵌套对象/数组/[值,"说明"] 元组,可挂 $meta)→ 扁平行表。
 * $-前缀元键跳过;非叶子给摘要不递归数组;深度/行数双上限防爆屏。
 */
export function flattenStatData(root: unknown, maxDepth = 4, maxRows = 80): MvuVarRow[] {
    const rows: MvuVarRow[] = [];
    const walk = (node: unknown, path: string, depth: number) => {
        if (rows.length >= maxRows) return;
        if (node === null || typeof node !== 'object') {
            rows.push({ path, text: fmtMvuValue(node), num: typeof node === 'number' ? node : undefined });
            return;
        }
        if (isVwd(node)) {
            const [v, desc] = node;
            rows.push({
                path, desc,
                text: fmtMvuValue(v),
                num: typeof v === 'number' ? v : undefined,
            });
            return;
        }
        if (Array.isArray(node) || depth >= maxDepth) {
            rows.push({ path, text: fmtMvuValue(node) });
            return;
        }
        const entries = Object.entries(node as Record<string, unknown>).filter(([k]) => !k.startsWith('$'));
        if (entries.length === 0) {
            rows.push({ path, text: '{}' });
            return;
        }
        for (const [k, v] of entries) walk(v, path ? `${path}.${k}` : k, depth + 1);
    };
    if (root !== null && typeof root === 'object' && !Array.isArray(root)) {
        for (const [k, v] of Object.entries(root as Record<string, unknown>)) {
            if (k.startsWith('$')) continue;
            walk(v, k, 1);
        }
    } else {
        walk(root, '', 0);
    }
    return rows;
}
