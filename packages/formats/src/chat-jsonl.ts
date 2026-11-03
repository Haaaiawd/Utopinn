// chat-jsonl.ts — ST 聊天文件(JSONL)读写。
// 形态:首行 {"chat_metadata":{...}},其后每行一条消息
//   {name,is_user,is_system,send_date,mes,swipes?,swipe_id?,extra?}。
// 行为以 apps/server/src/endpoints/chats.js 的读写路径为准。

export interface ChatMessage {
    name?: string;
    is_user?: boolean;
    is_system?: boolean;
    send_date?: string | number;
    mes?: string;
    swipes?: string[];
    swipe_id?: number;
    extra?: Record<string, unknown>;
    [k: string]: unknown;
}

export interface ParsedChat {
    /** 首行 chat_metadata 对象(无头文件时为 null) */
    metadata: Record<string, unknown> | null;
    /** 元数据行之外的消息(原样对象,未做字段归一化) */
    messages: ChatMessage[];
    /** 无法解析为 JSON 的行,按原样保留(导出时原样回写) */
    rawLines?: string[];
}

const isMetadataLine = (o: unknown): o is { chat_metadata: Record<string, unknown> } =>
    !!o && typeof o === 'object' && Object.hasOwn(o, 'chat_metadata');

export function parseChatJsonl(text: string): ParsedChat {
    const lines = String(text).split('\n');
    let metadata: Record<string, unknown> | null = null;
    const messages: ChatMessage[] = [];
    const rawLines: string[] = [];
    for (const line of lines) {
        const t = line.trim();
        if (!t) continue;
        let obj: unknown;
        try { obj = JSON.parse(t); } catch { rawLines.push(line); continue; }
        if (isMetadataLine(obj)) {
            metadata = (obj as { chat_metadata: Record<string, unknown> }).chat_metadata;
        } else if (obj && typeof obj === 'object') {
            messages.push(obj as ChatMessage);
        } else {
            rawLines.push(line);
        }
    }
    const out: ParsedChat = { metadata, messages };
    if (rawLines.length) out.rawLines = rawLines;
    return out;
}

export function serializeChatJsonl(metadata: Record<string, unknown> | null, messages: ChatMessage[]): string {
    const objs: unknown[] = [];
    if (metadata !== null) objs.push({ chat_metadata: metadata });
    objs.push(...messages);
    return objs.map(o => JSON.stringify(o)).join('\n');
}

/** 最后一条非头消息(对齐 chats.js:getLastChatMessage)。 */
export function getLastChatMessage(text: string): ChatMessage | null {
    const lines = String(text).split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
        const t = lines[i]?.trim();
        if (!t) continue;
        let obj: unknown;
        try { obj = JSON.parse(t); } catch { continue; }
        if (!obj || typeof obj !== 'object' || isMetadataLine(obj)) continue;
        return obj as ChatMessage;
    }
    return null;
}
