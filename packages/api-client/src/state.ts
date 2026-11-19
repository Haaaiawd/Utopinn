/**
 * State domain — /api/utopinn/state/{chat|char|preset} sidecar 三族。
 * CLI `state <family> <op>` 动词的一对一映射(cmdState,utopinn-cli.mjs):
 *   - get 默认 POST body 形;via:'get' 走 GET+query 的 ETag 私有化读
 *     (?account 必须=认证 handle,默认 'default-user')。
 *   - patch 收 JSON-Patch:数组 | {operations} | {operation} | 裸单 op——
 *     asPatchOps 归一与服务端收形一致。
 *   - 不对称照 wire:char 独有 set(整态覆写,doc 必须 JSON 对象);
 *     preset 独有 delete-all(清全 ns)/ rename(随名迁移,撞档 409)。
 *   - delete 恒显式点名;chat delete 缺失也算成功 {deleted:true},
 *     char/preset 缺失 → {deleted:false}(不是错误)。
 */

import type {
    ChatStateTarget,
    CharStateTarget,
    JsonPatchOp,
    PresetStateTarget,
    StateDeleteAllResponse,
    StateDeleteResponse,
    StateGetBatchResponse,
    StateGetResponse,
    StatePatchResponse,
    StateRenameResponse,
    StateSetResponse,
} from '@utopinn/protocol';
import type { UtopinnClient } from './index.js';

const P = '/api/utopinn/state';
const enc = encodeURIComponent;
const stripExt = (s: string, ext: string) => String(s ?? '').replace(new RegExp(`\\.${ext}$`, 'i'), '');

/** CLI `asPatchOps` 同款归一:数组 | {operations:[…]|operation:{…}} | 裸单 op。 */
export function asPatchOps(
    doc: JsonPatchOp[] | { operations?: JsonPatchOp[] | JsonPatchOp; operation?: JsonPatchOp } | JsonPatchOp,
): JsonPatchOp[] | null {
    if (Array.isArray(doc)) return doc;
    if (doc && typeof doc === 'object') {
        const d = doc as { operations?: JsonPatchOp[] | JsonPatchOp; operation?: JsonPatchOp };
        if (Array.isArray(d.operations)) return d.operations;
        if (d.operation && typeof d.operation === 'object' && !Array.isArray(d.operation)) return [d.operation];
        const single = doc as JsonPatchOp;
        if (typeof single.op === 'string' && typeof single.path === 'string') return [doc as JsonPatchOp];
    }
    return null;
}

/** 目标构造 helper——CLI 的 ctx→target 语义(charDir 无 .png、chatName 无 .jsonl)。 */
export const StateTargets = {
    /** 单卡会话:{avatar_url:'<dir>.png', file_name:'<chat>.jsonl'} */
    chat(charDir: string, chatName: string): ChatStateTarget {
        return {
            avatar_url: `${stripExt(charDir, 'png')}.png`,
            file_name: `${stripExt(chatName, 'jsonl')}.jsonl`,
        };
    },
    /** 群聊会话:{is_group:true, id:<groupChatId>} */
    groupChat(id: string): ChatStateTarget {
        return { is_group: true, id: stripExt(id, 'jsonl') };
    },
    /** 卡级:{avatar_url:'<dir>.png'} */
    char(charDir: string): CharStateTarget {
        return { avatar_url: `${stripExt(charDir, 'png')}.png` };
    },
    /** 预设级:{apiId, name}(--api 族,默认 openai) */
    preset(name: string, apiId = 'openai'): PresetStateTarget {
        return { apiId, name };
    },
};

/** get 的 GET 变体选项(--via get:ETag 私有化读;?account 必须=认证 handle)。 */
export interface StateGetOptions {
    via?: 'post' | 'get';
    /** --via get 时的 ?account(默认 'default-user',跨 handle 会 403)。 */
    account?: string;
}

function getOpts(client: UtopinnClient, family: 'chat' | 'char' | 'preset', target: object, namespace: string, opts: StateGetOptions): Promise<StateGetResponse> {
    if ((opts.via ?? 'post') === 'get') {
        const query: Record<string, string> = {
            namespace,
            account: opts.account ?? 'default-user',
        };
        if (family === 'chat') {
            const t = target as ChatStateTarget;
            if ('is_group' in t && t.is_group) {
                query.is_group = 'true';
                query.id = t.id;
            } else {
                const c = t as { avatar_url: string; file_name: string; char_name?: string };
                query.is_group = 'false';
                query.avatar_url = c.avatar_url;
                query.file_name = c.file_name;
                if (c.char_name) query.char_name = c.char_name;
            }
        } else if (family === 'char') {
            // 服务端 GET 变体读 query.avatar(getQueryCharacterAvatar)
            query.avatar = (target as CharStateTarget).avatar_url;
            query.avatar_url = (target as CharStateTarget).avatar_url;
        } else {
            const t = target as PresetStateTarget;
            query.apiId = t.apiId;
            query.name = t.name;
        }
        return client.request(`${P}/${family}/get`, { query });
    }
    return client.request(`${P}/${family}/get`, { method: 'POST', body: { ...target, namespace } });
}

class ChatStateApi {
    constructor(private readonly client: UtopinnClient) {}
    /** get(默认 POST body;via:'get' 走 ETag 资源读)。 */
    get(target: ChatStateTarget, namespace: string, opts: StateGetOptions = {}): Promise<StateGetResponse> {
        return getOpts(this.client, 'chat', target, namespace, opts);
    }
    getBatch<T = unknown>(target: ChatStateTarget, namespaces: string[]): Promise<StateGetBatchResponse<T>> {
        return this.client.request(`${P}/chat/get-batch`, { method: 'POST', body: { ...target, namespaces } });
    }
    /** 409 → test/missing-parent(integrity_conflict 类)。 */
    patch(target: ChatStateTarget, namespace: string, ops: JsonPatchOp[] | { operations?: JsonPatchOp[] | JsonPatchOp; operation?: JsonPatchOp } | JsonPatchOp): Promise<StatePatchResponse> {
        const operations = asPatchOps(ops);
        if (!operations?.length) return Promise.reject(new Error('state chat patch: empty/invalid ops (array|{operations|operation}|single op)'));
        return this.client.request(`${P}/chat/patch`, { method: 'POST', body: { ...target, namespace, operations } });
    }
    /** 缺失也算成功 → {deleted:true}。 */
    delete(target: ChatStateTarget, namespace: string): Promise<StateDeleteResponse> {
        return this.client.request(`${P}/chat/delete`, { method: 'POST', body: { ...target, namespace } });
    }
}

class CharStateApi {
    constructor(private readonly client: UtopinnClient) {}
    get(target: CharStateTarget, namespace: string, opts: StateGetOptions = {}): Promise<StateGetResponse> {
        return getOpts(this.client, 'char', target, namespace, opts);
    }
    getBatch<T = unknown>(target: CharStateTarget, namespaces: string[]): Promise<StateGetBatchResponse<T>> {
        return this.client.request(`${P}/char/get-batch`, { method: 'POST', body: { ...target, namespaces } });
    }
    /** char 独有:整态覆写;data 必须 JSON 对象;卡不在 → 404。 */
    set(target: CharStateTarget, namespace: string, data: Record<string, unknown>): Promise<StateSetResponse> {
        if (!data || typeof data !== 'object' || Array.isArray(data)) {
            return Promise.reject(new Error('state char set: data must be a JSON object'));
        }
        return this.client.request(`${P}/char/set`, { method: 'POST', body: { ...target, namespace, data } });
    }
    patch(target: CharStateTarget, namespace: string, ops: JsonPatchOp[] | { operations?: JsonPatchOp[] | JsonPatchOp; operation?: JsonPatchOp } | JsonPatchOp): Promise<StatePatchResponse> {
        const operations = asPatchOps(ops);
        if (!operations?.length) return Promise.reject(new Error('state char patch: empty/invalid ops'));
        return this.client.request(`${P}/char/patch`, { method: 'POST', body: { ...target, namespace, operations } });
    }
    /** 缺失 → {deleted:false}(不是错误)。 */
    delete(target: CharStateTarget, namespace: string): Promise<StateDeleteResponse> {
        return this.client.request(`${P}/char/delete`, { method: 'POST', body: { ...target, namespace } });
    }
}

class PresetStateApi {
    constructor(private readonly client: UtopinnClient) {}
    get(target: PresetStateTarget, namespace: string, opts: StateGetOptions = {}): Promise<StateGetResponse> {
        return getOpts(this.client, 'preset', target, namespace, opts);
    }
    getBatch<T = unknown>(target: PresetStateTarget, namespaces: string[]): Promise<StateGetBatchResponse<T>> {
        return this.client.request(`${P}/preset/get-batch`, { method: 'POST', body: { ...target, namespaces } });
    }
    patch(target: PresetStateTarget, namespace: string, ops: JsonPatchOp[] | { operations?: JsonPatchOp[] | JsonPatchOp; operation?: JsonPatchOp } | JsonPatchOp): Promise<StatePatchResponse> {
        const operations = asPatchOps(ops);
        if (!operations?.length) return Promise.reject(new Error('state preset patch: empty/invalid ops'));
        return this.client.request(`${P}/preset/patch`, { method: 'POST', body: { ...target, namespace, operations } });
    }
    delete(target: PresetStateTarget, namespace: string): Promise<StateDeleteResponse> {
        return this.client.request(`${P}/preset/delete`, { method: 'POST', body: { ...target, namespace } });
    }
    /** preset 独有:清全 ns → {deleted:<count>}。 */
    deleteAll(target: PresetStateTarget): Promise<StateDeleteAllResponse> {
        return this.client.request(`${P}/preset/delete-all`, { method: 'POST', body: { apiId: target.apiId, name: target.name } });
    }
    /** preset 独有:ns 随名迁移;同名 {renamed:0};撞档 → 409(exists 类)。 */
    rename(apiId: string, oldName: string, newName: string): Promise<StateRenameResponse> {
        return this.client.request(`${P}/preset/rename`, { method: 'POST', body: { apiId, oldName, newName } });
    }
}

export class StateApi {
    readonly chat: ChatStateApi;
    readonly char: CharStateApi;
    readonly preset: PresetStateApi;
    constructor(client: UtopinnClient) {
        this.chat = new ChatStateApi(client);
        this.char = new CharStateApi(client);
        this.preset = new PresetStateApi(client);
    }
}
