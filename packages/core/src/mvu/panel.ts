/**
 * MVU 状态栏固定模板渲染 —— 服务端面板 seam(capability C3)。
 *
 * 状态板 = stat_data × 卡内固定模板,服务端渲染为 panel 资产;
 * 不让模型逐轮重输 HTML(格式漂移+费 token)。模板引擎与 TH 兼容:
 *
 *   {{getvar::<lodash path>}}   —— 对"聊天变量字典"求值
 *                                  (settle 镜像后含 stat_data/schema/display_data/…)
 *   {{stat_data.<lodash path>}} —— {{getvar::stat_data.<path>}} 的速写
 *   {{{…}}}                     —— 三花括号不转义(卡自带 HTML 片段)
 *   双花括号默认 HTML 转义;未命中路径 → 空串(TH getvar 未命中行为)。
 *   其他 {{…}} 形态原样保留(交给下游宏/STscript 管线)。
 *
 * 本模块是纯函数:无 fs/DOM/网络;卡资产来源与面板挂载由调用方注入。
 * 参照:capability mvu-runtime C3「状态板 = 服务端渲染的系统面板」。
 */
import { get, toPath } from './lodash.js';

const ESCAPE_MAP: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
};

export function escapeHtmlForPanel(value: string): string {
    return value.replace(/[&<>"']/g, ch => ESCAPE_MAP[ch]!);
}

/** 值→显示串:原始值 String();对象/数组 JSON.stringify(TH 插值近似)。 */
function valueToDisplay(value: unknown): string {
    if (value === null || value === undefined) {
        return '';
    }
    if (typeof value === 'object') {
        try {
            return JSON.stringify(value);
        } catch {
            return String(value);
        }
    }
    return String(value);
}

export interface MvuPanelRenderOptions {
    /** 未命中路径时的回填串(默认 '')。 */
    fallback?: string;
    /** 传 false 时双花括号也不转义(仅调试/受信模板)。 */
    escapeHtml?: boolean;
}

const GETVAR_RE = /\{\{\{\s*getvar::([^}]+?)\s*\}\}\}|\{\{\s*getvar::([^}]+?)\s*\}\}/g;
const STAT_DATA_RE = /\{\{\{\s*stat_data\.([^}]+?)\s*\}\}\}|\{\{\s*stat_data\.([^}]+?)\s*\}\}/g;

/**
 * 渲染状态板模板。
 * @param template 卡内固定模板(HTML/markup)。
 * @param chatVariables 聊天变量字典(chat_metadata.variables 同构;
 *   `stat_data` 位于顶层,与 settle 的 chatVariablesPatch 镜像一致)。
 * @returns 渲染产物(占位符已替换的字符串)。
 */
export function renderMvuStatusPanel(
    template: string,
    chatVariables: Record<string, unknown>,
    options: MvuPanelRenderOptions = {},
): string {
    const fallback = options.fallback ?? '';
    const escapeHtml = options.escapeHtml !== false;

    const resolve = (path: string): string => {
        const value = get(chatVariables, toPath(path));
        const display = value === undefined ? fallback : valueToDisplay(value);
        return display;
    };

    let out = String(template ?? '');
    // 先 stat_data 速写(等价 getvar::stat_data.*),再通用 getvar。
    // 捕获组 1=三花括号(不转义),组 2=双花括号(转义)。
    out = out.replace(STAT_DATA_RE, (_m, triple, double) => {
        const rendered = resolve(`stat_data.${triple ?? double}`);
        return triple !== undefined
            ? rendered
            : escapeHtml ? escapeHtmlForPanel(rendered) : rendered;
    });
    out = out.replace(GETVAR_RE, (_m, triple, double) => {
        const rendered = resolve(triple ?? double);
        return triple !== undefined
            ? rendered
            : escapeHtml ? escapeHtmlForPanel(rendered) : rendered;
    });
    return out;
}
