// State sidecar 三族:/api/utopinn/state/{chat|char|preset}
// (apps/server/src/plugins/utopinn-library.js L1179-1859;legacy /api/{chats,
// characters,presets}/state/* 的孪生面,helper 同源)。
//
// 资源模型:Luker `.<ns>.luker-state.json` 命名空间 sidecar,CardApp/MVU/
// notes 等面板的私有 JSON 袋。target 三形:
//   chat   → {avatar_url:'<charDir>.png', file_name:'<chat>.jsonl'} | {is_group:true, id}
//   char   → {avatar_url:'<charDir>.png'}(过 validateAvatarUrlMiddleware)
//   preset → {apiId, name}
//
// 读面取舍:每条 get 都有 GET(ETag/sendJsonResource 资源读,需 ?account=
// <handle> —— 薄客户端不知道自己 handle,POST 同语义)与 POST 两形,本文件
// 只暴露 POST 变体,应答同形 {ok, data}。
//
// CAS 语义:state 写面没有 integrity 字段 —— 乐观锁载体是 JSON-Patch
// `test` op(服务端把 test 失败/missing-parent/replace-remove 路径不存在
// 归一映射成 409):调用方在 ops 里前置 test 断言即得 CAS;409 经 assertOk
// 抛 ApiError(status 409)。chat 文档级 integrity CAS 在 append/document
// 写面,不在本文件域。
import { apiPost } from './client';
import type {
    ChatStateTarget,
    JsonPatchOp,
    StateDeleteAllResponse,
    StateDeleteResponse,
    StateGetBatchResponse,
    StateGetResponse,
    StatePatchResponse,
    StateRenameResponse,
    StateSetResponse,
} from '@utopinn/protocol';

export type {
    ChatStateTarget,
    JsonPatchOp,
    StateDeleteResponse,
    StateGetBatchResponse,
    StateGetResponse,
    StatePatchResponse,
};

const P = '/api/utopinn/state';

// ---------------------------------------------------------------------------
// chat_state —— 绑定到单个聊天文件(或群聊 id)的 sidecar。
// patch 宽容面:父聊天缺席也允许写 sidecar(legacy 语义,服务端引擎 tx 直写)。
// ---------------------------------------------------------------------------

/** POST /api/utopinn/state/chat/get —— {ok,data|null}(ns 未建 → data:null)。 */
export async function getChatState<T = unknown>(target: ChatStateTarget, namespace: string): Promise<StateGetResponse<T>> {
    return apiPost(`${P}/chat/get`, { ...target, namespace });
}

/** POST /api/utopinn/state/chat/get-batch —— 单 target 多 ns 一次取 → {ok,data:{ns:doc|null}}。 */
export async function getChatStateBatch<T = unknown>(target: ChatStateTarget, namespaces: string[]): Promise<StateGetBatchResponse<T>> {
    return apiPost(`${P}/chat/get-batch`, { ...target, namespaces });
}

/**
 * POST /api/utopinn/state/chat/patch —— JSON-Patch 合并写。
 * ops 里前置 {op:'test',...} 即乐观锁;冲突/校验错 → ApiError(409/400)。
 */
export async function patchChatState(target: ChatStateTarget, namespace: string, operations: JsonPatchOp[]): Promise<StatePatchResponse> {
    return apiPost(`${P}/chat/patch`, { ...target, namespace, operations });
}

/** POST /api/utopinn/state/chat/delete —— 删一个 ns;缺失也算成功(恒 deleted:true)。 */
export async function deleteChatState(target: ChatStateTarget, namespace: string): Promise<StateDeleteResponse> {
    return apiPost(`${P}/chat/delete`, { ...target, namespace });
}

// ---------------------------------------------------------------------------
// char_state —— `<charName>.state.<ns>.json` 与卡同目录,按 avatar 文件名定位。
// avatarUrl 是头像文件名(`<charDir>.png`),服务端 sanitize + 路径白名单。
// ---------------------------------------------------------------------------

/** POST /api/utopinn/state/char/get —— {ok,data|null}。 */
export async function getCharState<T = unknown>(avatarUrl: string, namespace: string): Promise<StateGetResponse<T>> {
    return apiPost(`${P}/char/get`, { avatar_url: avatarUrl, namespace });
}

/** POST /api/utopinn/state/char/get-batch —— {ok,data:{ns:doc|null}}。 */
export async function getCharStateBatch<T = unknown>(avatarUrl: string, namespaces: string[]): Promise<StateGetBatchResponse<T>> {
    return apiPost(`${P}/char/get-batch`, { avatar_url: avatarUrl, namespaces });
}

/**
 * POST /api/utopinn/state/char/set —— char 独有:整态覆写一个 ns。
 * data 必须是 JSON 对象;卡不存在 → ApiError(404)。
 */
export async function setCharState(avatarUrl: string, namespace: string, data: Record<string, unknown>): Promise<StateSetResponse> {
    return apiPost(`${P}/char/set`, { avatar_url: avatarUrl, namespace, data });
}

/**
 * POST /api/utopinn/state/char/patch —— JSON-Patch 合并写。
 * 卡不存在 → 404;结果非对象 → 400;test/missing-parent → ApiError(409)。
 */
export async function patchCharState(avatarUrl: string, namespace: string, operations: JsonPatchOp[]): Promise<StatePatchResponse> {
    return apiPost(`${P}/char/patch`, { avatar_url: avatarUrl, namespace, operations });
}

/** POST /api/utopinn/state/char/delete —— {ok,deleted};ns 缺失 → deleted:false(不是错误)。 */
export async function deleteCharState(avatarUrl: string, namespace: string): Promise<StateDeleteResponse> {
    return apiPost(`${P}/char/delete`, { avatar_url: avatarUrl, namespace });
}

// ---------------------------------------------------------------------------
// preset_state —— per-(apiId, name) 的 state ns(PresetRepo 引擎面)。
// 独有 delete-all/rename:预设删档/改名时 ns 随动(预设本体写面连带做,
// 这两条供手工清档/迁移)。apiId 经服务端白名单(PRESET_FOLDER_BY_API_ID)。
// ---------------------------------------------------------------------------

/** POST /api/utopinn/state/preset/get —— {ok,data|null}。 */
export async function getPresetState<T = unknown>(apiId: string, name: string, namespace: string): Promise<StateGetResponse<T>> {
    return apiPost(`${P}/preset/get`, { apiId, name, namespace });
}

/** POST /api/utopinn/state/preset/get-batch —— {ok,data:{ns:doc|null}}。 */
export async function getPresetStateBatch<T = unknown>(apiId: string, name: string, namespaces: string[]): Promise<StateGetBatchResponse<T>> {
    return apiPost(`${P}/preset/get-batch`, { apiId, name, namespaces });
}

/** POST /api/utopinn/state/preset/patch —— test/missing-parent → ApiError(409)。 */
export async function patchPresetState(apiId: string, name: string, namespace: string, operations: JsonPatchOp[]): Promise<StatePatchResponse> {
    return apiPost(`${P}/preset/patch`, { apiId, name, namespace, operations });
}

/** POST /api/utopinn/state/preset/delete —— {ok,deleted};缺失 → deleted:false。 */
export async function deletePresetState(apiId: string, name: string, namespace: string): Promise<StateDeleteResponse> {
    return apiPost(`${P}/preset/delete`, { apiId, name, namespace });
}

/** POST /api/utopinn/state/preset/delete-all —— 清该预设全部 ns → {ok,deleted:<count>}。 */
export async function deleteAllPresetState(apiId: string, name: string): Promise<StateDeleteAllResponse> {
    return apiPost(`${P}/preset/delete-all`, { apiId, name });
}

/**
 * POST /api/utopinn/state/preset/rename —— ns 随名迁移。
 * 同名 → {ok,renamed:0};目标撞档 → ApiError(409 'Preset state rename collision.')。
 */
export async function renamePresetState(apiId: string, oldName: string, newName: string): Promise<StateRenameResponse> {
    return apiPost(`${P}/preset/rename`, { apiId, oldName, newName });
}
