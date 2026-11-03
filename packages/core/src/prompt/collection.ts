/**
 * PromptCollection —— PromptManager 集合语义的纯数据版。
 * 顺序 = promptOrder(调用方解析好的最终序,含卡级覆盖);
 * index(source) 返回该 identifier 在序中的位次,不在序中=尾部。
 */
import type { PromptLike } from './types.js';

export interface PromptOrderEntry {
    identifier: string;
    enabled?: boolean;
}

export class PromptCollection {
    /**
     * 序位对齐的稀疏数组:orderIndex 列出的 identifier 占固定位,未列序追加。
     * 遍历必须用 items() 或跳过空洞的数组方法(find/filter/some/map 均跳,
     * for...of / findIndex 不跳)。
     * 原版语义:enabled/disabled 记在**序条目**上(getPromptOrderForCharacter),
     * 不在 prompt 本体 —— isPromptDisabledForActiveCharacter 查序条目。
     */
    collection: PromptLike[] = [];
    private orderIndex = new Map<string, number>();
    private orderEnabled = new Map<string, boolean>();

    constructor(prompts: PromptLike[] = [], promptOrder: (PromptOrderEntry | string)[] = []) {
        promptOrder.forEach((entry, i) => {
            const id = typeof entry === 'string' ? entry : entry.identifier;
            this.orderIndex.set(id, i);
            if (typeof entry === 'object' && entry?.enabled === false) this.orderEnabled.set(id, false);
        });
        this.collection.length = promptOrder.length;
        for (const p of prompts) {
            const slot = this.orderIndex.get(p.identifier);
            if (slot !== undefined) this.collection[slot] = p;
            else this.collection.push(p);
        }
    }

    /** 稠密遍历入口 */
    *items(): Generator<PromptLike> {
        for (let i = 0; i < this.collection.length; i++) {
            const p = this.collection[i];
            if (p) yield p;
        }
    }

    has(identifier: string): boolean {
        for (const p of this.items()) if (p.identifier === identifier) return true;
        return false;
    }

    get(identifier: string): PromptLike | undefined {
        for (const p of this.items()) if (p.identifier === identifier) return p;
        return undefined;
    }

    /** 原版 prompts.index(source):marker 在序中的位次;不在序中=-1 */
    index(identifier: string): number {
        return this.orderIndex.get(identifier) ?? -1;
    }

    add(prompt: PromptLike): void {
        const existing = this.index(prompt.identifier);
        if (existing !== -1) this.collection[existing] = prompt;
        else this.collection.push(prompt);
    }

    override(prompt: PromptLike, index: number): void {
        if (index >= 0) this.collection[index] = prompt;
        else this.collection.push(prompt);
    }

    isPromptDisabledForActiveCharacter(identifier: string): boolean {
        return this.orderEnabled.get(identifier) === false;
    }
}
