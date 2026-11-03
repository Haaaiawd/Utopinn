/**
 * Message / MessageCollection / ChatCompletion —— openai.js 5286-5960 的纯化移植。
 * 差异:媒体/工具调用/推理签名不进 V1 计数路径(留 typed 字段,不展开 wire 字段)。
 * token 计数经注入的 TokenCounter seam(ST 口径见 tokens.ts)。
 */
import type { PromptLike } from './types.js';

export interface TokenCounter {
    /** 单条消息成本(含 role/name 开销),对应 ST countTokensOpenAIAsync(full=true) */
    count(message: { role: string; content: string; name?: string }): Promise<number>;
}

let counter: TokenCounter = { count: async (m) => Math.ceil(String(m.content ?? '').length / 4) };
export function setTokenCounter(c: TokenCounter): void {
    counter = c;
}
export function getTokenCounter(): TokenCounter {
    return counter;
}

export class Message {
    role!: string;
    content!: string;
    name?: string;
    identifier!: string;
    tokens = 0;
    injected?: boolean;

    static async createAsync(
        role: string,
        content: string | undefined,
        identifier: string,
        name?: string,
    ): Promise<Message> {
        const m = new Message();
        m.role = role;
        m.content = content ?? '';
        m.identifier = identifier;
        m.name = name;
        m.tokens = await counter.count(m);
        return m;
    }

    static async fromPromptAsync(prompt: PromptLike): Promise<Message> {
        const m = await Message.createAsync(prompt.role, prompt.content, prompt.identifier, prompt.name);
        return m;
    }

    static async createManyAsync(
        defs: { role: string; content: string; identifier?: string; name?: string; injected?: boolean }[],
    ): Promise<Message[]> {
        const out: Message[] = [];
        for (const d of defs) {
            const m = await Message.createAsync(d.role, d.content, d.identifier ?? 'anon', d.name);
            m.injected = d.injected;
            out.push(m);
        }
        return out;
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
        const index = this.findMessageIndex(identifier);
        if (message.content || message.tokens) {
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
            this.write(`WARN: ${identifier} exceeds budget (${collection.getTokens()} > ${this.tokenBudget})`);
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
                last.tokens = await counter.count(last);
            } else {
                out.push(m);
                last = m;
            }
        }
        this.messages.collection = out;
    }
}
