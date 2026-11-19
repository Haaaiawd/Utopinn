/**
 * Library domain — /api/utopinn/{characters,chats…,presets,worlds,personas,settings,secrets}.
 * Verb shapes mirror CLI `apps/cli/utopinn-cli.mjs` library 动词一对一:
 *   chars/char/chats/chat-get/chat-create/chat-put/chat-rename/chat-delete/
 *   append-messages/patch-chat/presets/preset-get/preset-edit/preset-delete/
 *   worlds/world-get/world-edit/world-delete/personas/persona-edit/persona-delete/
 *   settings/settings-patch/secrets/secret-set/secret-delete
 */

import type {
    AppendMessagesRequest,
    AppendMessagesResponse,
    ChatCreateResponse,
    ChatDocumentPutRequest,
    ChatDocumentPutResponse,
    ChatGetResponse,
    ChatPatchRequest,
    ChatPatchResponse,
    ChatRenameResponse,
    CharacterCardDocument,
    JsonPatchOp,
    LibraryCharactersResponse,
    LibraryChatsResponse,
    PersonaListResponse,
    PersonaPutRequest,
    PersonaPutResponse,
    PresetGetResponse,
    PresetListResponse,
    PresetPutResponse,
    SecretSetResponse,
    SecretsResponse,
    SettingsPatchRequest,
    SettingsResponse,
    WorldGetResponse,
    WorldListResponse,
    WorldPutResponse,
} from '@utopinn/protocol';
import type { UtopinnClient } from './index.js';

const P = '/api/utopinn';
const enc = encodeURIComponent;

/** stripExt 语义同 CLI:charDir 不带 .png、chatName 不带 .jsonl。 */
const stripExt = (s: string, ext: string) => String(s ?? '').replace(new RegExp(`\\.${ext}$`, 'i'), '');
const charDirOf = (dir: string) => stripExt(dir, 'png');
const chatNameOf = (name: string) => stripExt(name, 'jsonl');

export class LibraryApi {
    constructor(private readonly client: UtopinnClient) {}

    private chatsPath(charDir: string, chatName?: string): string {
        const base = `${P}/characters/${enc(charDirOf(charDir))}/chats`;
        return chatName === undefined ? base : `${base}/${enc(chatNameOf(chatName))}`;
    }

    // ── characters ───────────────────────────────────────────────────────

    /** CLI `chars`(kernel 面):{items:[{charDir,name,avatar,fileName,fileSize,tags,readable,dateAdded,dateLastChat}]} */
    chars(): Promise<LibraryCharactersResponse> {
        return this.client.request(`${P}/characters`);
    }

    /** CLI `char`:卡文档全文(v1/v2/v3 原样返回;404 → ApiError not_found)。 */
    char(charDir: string): Promise<CharacterCardDocument> {
        return this.client.request(`${P}/characters/${enc(charDirOf(charDir))}`);
    }

    // ── chats ────────────────────────────────────────────────────────────

    /** CLI `chats`(kernel 面):{items:[{name,fileName,messageCount,lastMessage,chatMetadata,updatedAt,integrity}]} */
    chats(charDir: string): Promise<LibraryChatsResponse> {
        return this.client.request(this.chatsPath(charDir));
    }

    /** CLI `chat-get`:utopinn doc {header,messages,integrity};corrupted → {corrupted:true}。 */
    chatGet(charDir: string, chatName: string): Promise<ChatGetResponse> {
        return this.client.request(this.chatsPath(charDir, chatName));
    }

    /** CLI `chat-create`:立即建空会话(201;已存在 → 409 conflict)。 */
    chatCreate(charDir: string, chatName: string, opts: { header?: Record<string, unknown> } = {}): Promise<ChatCreateResponse> {
        return this.client.request(this.chatsPath(charDir, chatName), {
            method: 'PUT',
            body: { header: opts.header ?? { chat_metadata: {} } },
        });
    }

    /**
     * CLI `chat-put`:整文档替换(legacy /save 等价,upsert)。
     * doc:{header,messages} 或 legacy 数组 [header,…floors](自动转 {chat:doc})。
     * integrity 走 CAS;409 → ApiError(code integrity_conflict,body 带 current_integrity)——
     * 可配合 `retryOnIntegrityConflict` 重锚(CLI writeOp 同款语义)。
     */
    chatPut(
        charDir: string,
        chatName: string,
        doc: { header?: Record<string, unknown>; messages?: Record<string, unknown>[] } | Record<string, unknown>[],
        opts: { integrity?: string; force?: boolean; luker_generation_id?: string } = {},
    ): Promise<ChatDocumentPutResponse> {
        const body: ChatDocumentPutRequest = Array.isArray(doc) ? { chat: doc } : { ...doc };
        if (opts.force) body.force = true;
        else if (opts.integrity !== undefined) body.integrity = opts.integrity;
        if (opts.luker_generation_id) body.luker_generation_id = opts.luker_generation_id;
        return this.client.request(`${this.chatsPath(charDir, chatName)}/document`, { method: 'PUT', body });
    }

    /** CLI `chat-rename`:{newName};目标占用 → 409,源不在 → 404。 */
    chatRename(charDir: string, chatName: string, newName: string): Promise<ChatRenameResponse> {
        return this.client.request(`${this.chatsPath(charDir, chatName)}/rename`, {
            method: 'POST',
            body: { newName: chatNameOf(newName) },
        });
    }

    /** CLI `chat-delete`:204;不存在 → 404。 */
    chatDelete(charDir: string, chatName: string): Promise<void> {
        return this.client.request(this.chatsPath(charDir, chatName), { method: 'DELETE' });
    }

    /**
     * CLI 写盘 append 路(send/say/impersonate --write 共用):{messages|message,…}。
     * 缺失即建 + 双去重(队首等值/gen-id 侧车)+ integrity CAS。
     * 响应回新 integrity——客户端应锚存供下次写。
     */
    appendMessages(
        charDir: string,
        chatName: string,
        messages: Record<string, unknown>[],
        opts: Omit<AppendMessagesRequest, 'messages' | 'message'> = {},
    ): Promise<AppendMessagesResponse> {
        const body: AppendMessagesRequest = { messages, ...opts };
        return this.client.request(`${this.chatsPath(charDir, chatName)}/messages`, { method: 'POST', body });
    }

    /**
     * CLI 写盘 patch 路(edit/swipe/continue 共用):{ops:[{op,path:'/body/<i>/…|/header/…'}]}。
     * 409 分两种:integrity CAS(可重锚)vs op 冲突(test/missing-parent)——都是
     * isIntegrityConflict 命中,body.current_integrity 取新锚(CLI 同款判别)。
     */
    patchChat(
        charDir: string,
        chatName: string,
        ops: JsonPatchOp[],
        opts: Omit<ChatPatchRequest, 'ops'> = {},
    ): Promise<ChatPatchResponse> {
        const body: ChatPatchRequest = { ops, ...opts };
        return this.client.request(this.chatsPath(charDir, chatName), { method: 'PATCH', body });
    }

    // ── presets(apiId 族,默认 openai)────────────────────────────────────

    /** CLI `presets` */
    presets(apiId = 'openai'): Promise<PresetListResponse> {
        return this.client.request(`${P}/presets`, { query: { apiId } });
    }

    /** CLI `preset-get` */
    presetGet(name: string, apiId = 'openai'): Promise<PresetGetResponse> {
        return this.client.request(`${P}/presets/${enc(name)}`, { query: { apiId } });
    }

    /** CLI `preset-edit`:整档写回(upsert);body=预设 doc 对象。 */
    presetEdit(name: string, doc: Record<string, unknown>, apiId = 'openai'): Promise<PresetPutResponse> {
        return this.client.request(`${P}/presets/${enc(name)}`, { method: 'PUT', query: { apiId }, body: doc });
    }

    /** CLI `preset-delete`:204;连带清该预设的 state ns(服务端做)。 */
    presetDelete(name: string, apiId = 'openai'): Promise<void> {
        return this.client.request(`${P}/presets/${enc(name)}`, { method: 'DELETE', query: { apiId } });
    }

    // ── worlds ───────────────────────────────────────────────────────────

    /** CLI `worlds` */
    worlds(): Promise<WorldListResponse> {
        return this.client.request(`${P}/worlds`);
    }

    /** CLI `wi` */
    worldGet(name: string): Promise<WorldGetResponse> {
        return this.client.request(`${P}/worlds/${enc(name)}`);
    }

    /** CLI `world-edit`:整档写回 {entries:{}}(upsert;名经 resolveName 归一)。 */
    worldEdit(name: string, doc: { entries: Record<string, unknown> } & Record<string, unknown>): Promise<WorldPutResponse> {
        return this.client.request(`${P}/worlds/${enc(name)}`, { method: 'PUT', body: doc });
    }

    /** CLI `world-delete`:204。 */
    worldDelete(name: string): Promise<void> {
        return this.client.request(`${P}/worlds/${enc(name)}`, { method: 'DELETE' });
    }

    // ── personas ─────────────────────────────────────────────────────────

    /** CLI `personas` */
    personas(): Promise<PersonaListResponse> {
        return this.client.request(`${P}/personas`);
    }

    /**
     * CLI `persona-edit`:body 字段 name/description/position/title/is_default。
     * 服务端嵌套合并进 power_user.personas+persona_descriptions,可增量写。
     */
    personaEdit(avatar: string, fields: PersonaPutRequest): Promise<PersonaPutResponse> {
        return this.client.request(`${P}/personas/${enc(avatar)}`, { method: 'PUT', body: fields });
    }

    /** CLI `persona-delete`:双表摘除;恰是 default 一并清默认位。 */
    personaDelete(avatar: string): Promise<void> {
        return this.client.request(`${P}/personas/${enc(avatar)}`, { method: 'DELETE' });
    }

    // ── settings ─────────────────────────────────────────────────────────

    /**
     * CLI `settings`:脱敏视图。raw=true 走 ?raw=1 未脱敏档
     * (仅旧前端是全文档消费者;薄客户端别用)。
     */
    settings(opts: { raw?: boolean } = {}): Promise<SettingsResponse> {
        return this.client.request(`${P}/settings`, { query: { raw: opts.raw ? '1' : undefined } });
    }

    /**
     * CLI `settings-set`:受限浅合并,顶层键白名单 power_user|extension_settings,
     * 每段值必须是对象(逐键浅合并)。服务端同则校验(400/422)。
     */
    settingsPatch(patch: SettingsPatchRequest): Promise<SettingsResponse> {
        return this.client.request(`${P}/settings`, { method: 'PATCH', body: patch });
    }

    // ── secrets ──────────────────────────────────────────────────────────

    /** CLI `secrets`:全键脱敏态(值恒打码;null = 未设)。 */
    secrets(): Promise<SecretsResponse> {
        return this.client.request(`${P}/secrets`);
    }

    /** CLI `secret-set`:PUT 总是新建条目(服务端铸 id,自动 active;不回显明文)。 */
    secretSet(key: string, value: string, opts: { label?: string } = {}): Promise<SecretSetResponse> {
        return this.client.request(`${P}/secrets/${enc(key)}`, {
            method: 'PUT',
            body: { value, ...(opts.label ? { label: opts.label } : {}) },
        });
    }

    /** CLI `secret-delete`:按 id 删一条;204。 */
    secretDelete(key: string, id: string): Promise<void> {
        return this.client.request(`${P}/secrets/${enc(key)}/${enc(id)}`, { method: 'DELETE' });
    }
}
