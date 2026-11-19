// TH/STscript 桥面:/api/utopinn/th/call + /api/utopinn/script/run
// (apps/server/src/plugins/utopinn-th.js / utopinn-script.js;两者共享
// services/stscript-env.js 的 env 构造 —— CardApp postMessage 桥与
// QuickReply/斜杠脚本的服务端落点都在这)。
//
//   POST /th/call     body:{method, args?, target?:{charDir?, chatName?}}
//   POST /script/run  body:{script, charDir?, chatName?}
//
// th/call 已实现方法面(其余 → 200 {ok:false,unsupported:true,method}):
//   变量:getVariables / replaceVariables / insertOrAssignVariables /
//         deleteVariable(args.type|scope = 'chat'|'global'|'message',
//         lodash 式 args.path;chat 域 = chat_metadata.variables)
//   消息:getChatMessages(start?, end?)
//   脚本:triggerSlash(script)
//   身份:getCharacter / getCurrentCharacterName
//   楼层:getLastMessageId / getCurrentMessageId
//   卡嵌脚本:getEmbeddedScripts
//
// 语义失败(scope/target 缺失、卡/聊天不在、args 非法)服务端按
// {ok:false,error} + 非 2xx 回 —— 这里还原成同形 {ok:false,error,status}
// 返回(与 200 的 unsupported 同一条处理路),只有传输层失败才抛 ApiError。
import { ApiError, apiFetch, apiPost } from './client';
import type {
    ScriptRunResponse,
    ThCallRequest,
    ThCallResponse,
    ThCallTarget,
} from '@utopinn/protocol';

export type { ScriptRunResponse, ThCallResponse, ThCallTarget } from '@utopinn/protocol';

/** TH 方法名 —— 已知面列出供补全,开放 string 兼容生态方法(→ unsupported 回执)。 */
export type ThMethod =
    | 'getVariables' | 'replaceVariables' | 'insertOrAssignVariables' | 'deleteVariable'
    | 'getChatMessages' | 'triggerSlash'
    | 'getCharacter' | 'getCurrentCharacterName'
    | 'getLastMessageId' | 'getCurrentMessageId' | 'getEmbeddedScripts'
    | (string & {});

/** POST /api/utopinn/script/run —— 服务端跑 STscript;ops/UI sink 回执随响应。 */
export async function runScript(
    script: string,
    ctx?: { charDir?: string; chatName?: string },
): Promise<ScriptRunResponse> {
    return apiPost('/api/utopinn/script/run', { script, ...ctx });
}

/**
 * POST /api/utopinn/th/call —— TavernHelper 语义转发。
 * 返回三形:{ok:true,result?}|{ok:false,unsupported:true,method}|{ok:false,error,status?}。
 * 调用方判 r.ok 分支,不要 try/catch 语义错误(它们不走异常通道)。
 */
export async function thCall(
    method: ThMethod,
    args?: Record<string, unknown>,
    target?: ThCallTarget,
): Promise<ThCallResponse> {
    const body: ThCallRequest = { method, target, args };
    const res = await apiFetch('/api/utopinn/th/call', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
    const parsed = (await res.json().catch(() => null)) as ThCallResponse | null;
    if (!res.ok) {
        const unreachable = res.status === 502 && res.headers.has('x-utopinn-proxy-error');
        if (parsed && typeof parsed === 'object' && parsed.ok === false) {
            return { ...parsed, status: res.status } as ThCallResponse;
        }
        throw new ApiError(unreachable ? 'upstream_unavailable' : res.statusText, res.status);
    }
    // 200 但体非 JSON 属异常情况;兜底成 unsupported 语义的失败回执。
    if (!parsed || typeof parsed !== 'object') {
        return { ok: false, error: 'malformed_response', status: res.status };
    }
    return parsed;
}
