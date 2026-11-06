/**
 * Message / MessageCollection / ChatCompletion —— openai.js 5286-5960 的纯化移植。
 * 差异:媒体/工具调用/推理签名不进 V1 计数路径(留 typed 字段,不展开 wire 字段)。
 * token 计数经注入的 TokenCounter seam(ST 口径见 tokens.ts)。
 */
import type { PromptLike } from './types.js';

export interface TokenCounter {
    /** 单条消息成本(含 role/name/tool_calls 开销),对应 ST countTokensOpenAIAsync(full=true) */
    count(message: Record<string, unknown> & { role: string }): Promise<number>;
}

/** 上游 openai.js TokenBudgetExceededError 同形:must-fit 条目超预算 = 硬失败。 */
export class TokenBudgetExceededError extends Error {
    constructor(identifier: string) {
        super(`Token budget exceeded: ${identifier}`);
        this.name = 'TokenBudgetExceeded';
    }
}

let counter: TokenCounter = { count: async (m) => Math.ceil(String(m.content ?? '').length / 4) };
export function setTokenCounter(c: TokenCounter): void {
    counter = c;
}
export function getTokenCounter(): TokenCounter {
    return counter;
}

/** 工具调用载荷(openai.js ToolInvocation) */
export interface ToolInvocation {
    id: string;
    name: string;
    parameters?: unknown;
    result?: string;
    signature?: string;
    reasoning?: string;
    [key: string]: unknown;
}

/** 媒体附件(mediaDisplay LIST/GALLERY 时内联进消息) */
export interface MediaAttachment {
    url: string;
    type?: string; // 'image' | 'video' | 'audio'
    [key: string]: unknown;
}

/** 宿主注入的媒体能力(fetch/压缩/时长/质量),未给 = 内联关闭 */
export interface MediaProvider {
    fetchDataUrl(url: string): Promise<string | null>;
    compressImage?(dataUrl: string): Promise<string>;
    imageTokenCost?(dataUrl: string, quality: string): Promise<number>;
    videoDuration?(dataUrl: string): Promise<number>;
    audioDuration?(dataUrl: string): Promise<number>;
    imageQuality?: string;
}

let mediaProvider: MediaProvider | null = null;
export function setMediaProvider(p: MediaProvider | null): void {
    mediaProvider = p;
}
export function getMediaProvider(): MediaProvider | null {
    return mediaProvider;
}

export class Message {
    static tokensPerImage = 85;

    role!: string;
    content!: unknown; // string | multimodal parts[]
    name?: string;
    identifier!: string;
    tokens = 0;
    injected?: boolean;
    tool_calls?: unknown[];
    signature?: string | null;
    reasoning?: string | null;
    reasoning_blocks?: unknown[] | null;
    reasoning_details?: unknown[] | null;

    static async createAsync(
        role: string,
        content: unknown,
        identifier: string,
        name?: string,
    ): Promise<Message> {
        const m = new Message();
        m.role = role || 'system';
        m.content = content ?? '';
        m.identifier = identifier;
        m.name = name;
        m.tokens = await counter.count(m.toTokenCountPayload());
        return m;
    }

    static async fromPromptAsync(prompt: PromptLike): Promise<Message> {
        // 上游 openai.js:3792 — fromPromptAsync 不传 prompt.name;
        // 名字只经 setName(=names_behavior COMPLETION 的 chat 路径)进入
        // 计数载荷与 wire。透传会让每条 prompt 消息多 ~1 token 且带上
        // 上游没有的 name 字段(audit L1)。
        return Message.createAsync(prompt.role, prompt.content, prompt.identifier);
    }

    static async createManyAsync(
        defs: ({
            role: string;
            content?: unknown;
            identifier?: string;
            name?: string;
            injected?: boolean;
        } & Record<string, unknown>)[],
    ): Promise<Message[]> {
        const out: Message[] = [];
        for (const d of defs) {
            const m = new Message();
            m.role = d.role || 'system';
            m.content = d.content ?? '';
            m.identifier = d.identifier ?? 'anon';
            m.name = d.name;
            for (const [k, v] of Object.entries(d)) {
                if (!['role', 'content', 'identifier', 'name', 'injected'].includes(k)) {
                    (m as unknown as Record<string, unknown>)[k] = v;
                }
            }
            m.injected = d.injected;
            m.tokens = await counter.count(m.toTokenCountPayload());
            out.push(m);
        }
        return out;
    }

    static formatToolCalls(invocations: ToolInvocation[], includeSignature: boolean): unknown[] {
        return invocations.map((i) => ({
            id: i.id,
            type: 'function',
            function: {
                arguments: i.parameters,
                name: i.name,
            },
            ...(includeSignature && i.signature ? { signature: i.signature } : {}),
        }));
    }

    async setToolCalls(invocations: ToolInvocation[], includeSignature: boolean, includeReasoning = false): Promise<void> {
        this.tool_calls = Message.formatToolCalls(invocations, includeSignature);
        const fallbackReasoning =
            invocations.find((i) => typeof i.reasoning === 'string' && i.reasoning.length > 0)?.reasoning || null;
        this.reasoning = includeReasoning ? fallbackReasoning : null;
        this.tokens = await counter.count({
            role: this.role,
            tool_calls: JSON.stringify(this.tool_calls),
            ...(this.reasoning ? { reasoning: this.reasoning } : {}),
        });
    }

    async setName(name: string): Promise<void> {
        this.name = name;
        this.tokens = await counter.count(this.toTokenCountPayload());
    }

    hasTokenCountPayload(): boolean {
        return (
            (typeof this.content === 'string' && this.content.length > 0) ||
            Array.isArray(this.content) ||
            Array.isArray(this.tool_calls) ||
            Boolean(this.name)
        );
    }

    toTokenCountPayload(): Record<string, unknown> & { role: string } {
        return {
            role: this.role,
            ...(Array.isArray(this.tool_calls) ? { tool_calls: JSON.stringify(this.tool_calls) } : {}),
            ...(this.content !== undefined ? { content: this.content } : {}),
            ...(this.name ? { name: this.name } : {}),
            ...(this.signature ? { signature: this.signature } : {}),
        };
    }

    ensureContentIsArray(): unknown[] {
        const textContent = this.content;
        if (!Array.isArray(this.content)) {
            this.content = [];
            if (typeof textContent === 'string') {
                (this.content as unknown[]).push({ type: 'text', text: textContent });
            }
        }
        return this.content as unknown[];
    }

    async addImage(image: string): Promise<void> {
        this.ensureContentIsArray();
        const provider = mediaProvider;
        if (!provider) return;
        if (!image.startsWith('data:')) {
            const fetched = await provider.fetchDataUrl(image);
            if (fetched === null) return;
            image = fetched;
        }
        if (provider.compressImage) image = await provider.compressImage(image);
        const quality = provider.imageQuality ?? 'auto';
        (this.content as unknown[]).push({ type: 'image_url', image_url: { url: image, detail: quality } });
        try {
            this.tokens += provider.imageTokenCost
                ? await provider.imageTokenCost(image, quality)
                : Message.tokensPerImage;
        } catch {
            this.tokens += Message.tokensPerImage;
        }
    }

    async addVideo(video: string): Promise<void> {
        this.ensureContentIsArray();
        const provider = mediaProvider;
        if (!provider) return;
        if (!video.startsWith('data:')) {
            const fetched = await provider.fetchDataUrl(video);
            if (fetched === null) return;
            video = fetched;
        }
        const quality = provider.imageQuality ?? 'auto';
        (this.content as unknown[]).push({ type: 'video_url', video_url: { url: video, detail: quality } });
        try {
            const duration = provider.videoDuration ? await provider.videoDuration(video) : 40;
            this.tokens += 263 * Math.ceil(duration);
        } catch {
            this.tokens += 263 * 40;
        }
    }

    async addAudio(audio: string): Promise<void> {
        this.ensureContentIsArray();
        const provider = mediaProvider;
        if (!provider) return;
        if (!audio.startsWith('data:')) {
            const fetched = await provider.fetchDataUrl(audio);
            if (fetched === null) return;
            audio = fetched;
        }
        (this.content as unknown[]).push({ type: 'audio_url', audio_url: { url: audio } });
        try {
            const duration = provider.audioDuration ? await provider.audioDuration(audio) : 300;
            this.tokens += 32 * Math.ceil(duration);
        } catch {
            this.tokens += 32 * 300;
        }
    }

    getTokens(): number {
        return this.tokens;
    }
}

export class MessageCollection {
    identifier: string;
    collection: (Message | MessageCollection)[] = [];

    constructor(identifier: string) {
        this.identifier = identifier;
    }

    add(item: Message | MessageCollection): void {
        this.collection.push(item);
    }

    getTokens(): number {
        let sum = 0;
        for (let i = 0; i < this.collection.length; i++) {
            sum += this.collection[i]?.getTokens() ?? 0;
        }
        return sum;
    }

    flatten(): Message[] {
        // 原版 reduce 会跳过 positional add 留下的稀疏空洞,for...of 不跳 —— 必须显式跳过
        const out: Message[] = [];
        for (let i = 0; i < this.collection.length; i++) {
            const item = this.collection[i];
            if (!item) continue;
            if (item instanceof MessageCollection) out.push(...item.flatten());
            else out.push(item);
        }
        return out;
    }
}

export class ChatCompletion {
    tokenBudget = 0;
    messages = new MessageCollection('root');
    overriddenPrompts: string[] = [];
    private logLines: string[] = [];
    loggingEnabled = true;

    get log(): string[] {
        return this.logLines;
    }

    private write(line: string): void {
        if (this.loggingEnabled) this.logLines.push(line);
    }

    setTokenBudget(context: number, response: number): void {
        this.tokenBudget = context - response;
        this.write(`Token budget: ${this.tokenBudget} (context ${context} - response ${response})`);
    }

    setOverriddenPrompts(prompts: string[]): void {
        this.overriddenPrompts = prompts;
    }

    add(collection: Message | MessageCollection, position: number | null = null): this {
        this.checkTokenBudget(collection, collection.identifier);
        if (position !== null && position !== -1 && position !== undefined) {
            this.messages.collection[position] = collection;
        } else {
            this.messages.collection.push(collection);
        }
        this.decreaseTokenBudgetBy(collection.getTokens());
        this.write(`Added ${collection.identifier}. Remaining: ${this.tokenBudget}`);
        return this;
    }

    insert(message: Message, identifier: string, position: string | number = 'end'): void {
        this.checkTokenBudget(message, message.identifier);
        const index = this.findMessageIndex(identifier);
        // 上游门槛 content||tool_calls:空消息(含预置 tokens 的占位)不插入。
        if (message.content || message.tool_calls) {
            const coll = this.messages.collection[index] as MessageCollection;
            if (position === 'start') coll.collection.unshift(message);
            else if (position === 'end') coll.collection.push(message);
            else if (typeof position === 'number') coll.collection.splice(position, 0, message);
            this.decreaseTokenBudgetBy(message.getTokens());
            this.write(`Inserted ${message.identifier} into ${identifier}. Remaining: ${this.tokenBudget}`);
        }
    }

    insertAtStart(message: Message, identifier: string): void {
        this.insert(message, identifier, 'start');
    }

    insertAtEnd(message: Message, identifier: string): void {
        this.insert(message, identifier, 'end');
    }

    private findMessageIndex(identifier: string): number {
        const coll = this.messages.collection;
        for (let i = 0; i < coll.length; i++) {
            if (coll[i]?.identifier === identifier) return i;
        }
        throw new Error(`Collection ${identifier} not found`);
    }

    canAfford(message: Message | MessageCollection): boolean {
        return this.tokenBudget - message.getTokens() >= 0;
    }

    canAffordAll(messages: (Message | MessageCollection)[]): boolean {
        return messages.every((m) => this.canAfford(m)) &&
            this.tokenBudget - messages.reduce((s, m) => s + m.getTokens(), 0) >= 0;
    }

    reserveBudget(item: Message | MessageCollection | number): void {
        const tokens = typeof item === 'number' ? item : item.getTokens();
        this.decreaseTokenBudgetBy(tokens);
        this.write(`Reserved ${tokens}. Remaining: ${this.tokenBudget}`);
    }

    freeBudget(item: Message | MessageCollection | number): void {
        const tokens = typeof item === 'number' ? item : item.getTokens();
        this.tokenBudget += tokens;
        this.write(`Freed ${tokens}. Remaining: ${this.tokenBudget}`);
    }

    has(identifier: string): boolean {
        const coll = this.messages.collection;
        for (let i = 0; i < coll.length; i++) {
            if (coll[i]?.identifier === identifier) return true;
        }
        return false;
    }

    private checkTokenBudget(collection: Message | MessageCollection, identifier: string): void {
        if (!this.canAfford(collection)) {
            // 上游硬失败:mandatory prompts 超预算 → TokenBudgetExceededError,
            // Generate() catch 后向用户报 "Mandatory prompts exceed the context size"。
            throw new TokenBudgetExceededError(identifier);
        }
    }

    private decreaseTokenBudgetBy(tokens: number): void {
        this.tokenBudget -= tokens;
    }

    /** 连续无名 system 消息合并(排除 newMainChat/newChat/groupNudge,空 system 丢弃) */
    async squashSystemMessages(): Promise<void> {
        const excludeList = ['newMainChat', 'newChat', 'groupNudge'];
        const flat = this.messages.flatten();
        const out: Message[] = [];
        let last: Message | null = null;
        const shouldSquash = (m: Message) =>
            !excludeList.includes(m.identifier) && m.role === 'system' && !m.name;

        for (const m of flat) {
            if (m.role === 'system' && !m.content) continue;
            if (shouldSquash(m) && last && shouldSquash(last)) {
                last.content += '\n' + m.content;
                last.tokens = await counter.count(last.toTokenCountPayload());
            } else {
                out.push(m);
                last = m;
            }
        }
        this.messages.collection = out;
    }
}
