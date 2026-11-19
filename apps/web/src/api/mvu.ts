// MVU(变量结算)面:/api/utopinn/mvu/*(apps/server/src/plugins/utopinn-mvu.js)。
//   POST /settle        对目标楼层(默认末楼)手动重结算 —— /mvu sync 指令落点。
//   POST /resettle      全量重放投影(编辑/删楼/换 swipe 后重建 stat_data)。
//   GET  /state         chat_metadata.variables + chat_state 'mvu' 回执日志 ——
//                       composer MVU chip / mvu 面板 / 楼层 delta 徽标的数据源。
//   POST /panel/render  状态栏模板 × 变量字典 → 服务端渲染面板 HTML。
// target 与 chat_state 同形:{avatar_url,file_name} | {is_group,id}
// (别名 char_dir/chat_name/group_id 服务端也认,这里统一主名)。
import { apiGet, apiPost } from './client';
import type {
    MvuPanelRenderResponse,
    MvuResettleResponse,
    MvuSettleResponse,
    MvuStateResponse,
    MvuTarget,
} from '@utopinn/protocol';

export type { MvuStateResponse, MvuTarget } from '@utopinn/protocol';

/** target → 服务端 targetArgs 认的 query/body 键(avatar_url+file_name | is_group+id)。 */
function mvuTargetFields(target: MvuTarget): Record<string, string | boolean> {
    if (target.is_group) {
        return { is_group: true, id: target.id };
    }
    return { avatar_url: target.avatar_url, file_name: target.file_name };
}

/**
 * GET /api/utopinn/mvu/state —— 变量视图 {ok,status,chatVariables,statData?,floorVariables?,state}。
 * 聊天不在 → ApiError(404 'Chat not found.')。
 */
export async function getMvuState(target: MvuTarget): Promise<MvuStateResponse> {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(mvuTargetFields(target))) q.set(k, String(v));
    return apiGet(`/api/utopinn/mvu/state?${q.toString()}`);
}

/**
 * POST /api/utopinn/mvu/settle —— 手动重结算。
 * message_index 缺省=末楼;update_chat_variables 缺省 true(false=只结算不回写)。
 */
export async function settleMvu(
    target: MvuTarget,
    opts?: { message_index?: number; update_chat_variables?: boolean },
): Promise<MvuSettleResponse> {
    return apiPost('/api/utopinn/mvu/settle', { ...mvuTargetFields(target), ...opts });
}

/** POST /api/utopinn/mvu/resettle —— 全量重放投影(无 message_index)。 */
export async function resettleMvu(
    target: MvuTarget,
    opts?: { update_chat_variables?: boolean },
): Promise<MvuResettleResponse> {
    return apiPost('/api/utopinn/mvu/resettle', { ...mvuTargetFields(target), ...opts });
}

/**
 * POST /api/utopinn/mvu/panel/render —— 模板 × 变量 → {ok,html}。
 * scope 缺省时服务端从 target 聊天的 chatVariables 取(此时 target 必给);
 * escape_html 缺省 true;fallback = 变量缺失时的占位文本。
 */
export async function renderMvuPanel(
    template: string,
    opts?: {
        scope?: Record<string, unknown>;
        target?: MvuTarget;
        fallback?: string;
        escape_html?: boolean;
    },
): Promise<MvuPanelRenderResponse> {
    const { scope, target, fallback, escape_html } = opts ?? {};
    return apiPost('/api/utopinn/mvu/panel/render', {
        template,
        ...(scope !== undefined ? { scope } : {}),
        ...(target ? mvuTargetFields(target) : {}),
        ...(fallback !== undefined ? { fallback } : {}),
        ...(escape_html !== undefined ? { escape_html } : {}),
    });
}
