// Registry — cordis effect 语义的内存版:add() 返回 disposer,
// feature 模块卸载一刀全拆;useSyncExternalStore 订阅让运行时
// 新增贡献(将来的插件 manifest hydrate)能驱动重渲。
import type { Contributions } from './contributions';

export type Disposer = () => void;

const EMPTY: readonly unknown[] = [];

export class Registry {
    private readonly map = new Map<string, readonly unknown[]>();
    private readonly listeners = new Set<() => void>();

    add<K extends keyof Contributions>(point: K, contrib: Contributions[K]): Disposer {
        const prev = this.map.get(point) ?? EMPTY;
        this.map.set(point, [...prev, contrib]);
        this.emit();
        return () => {
            this.map.set(point, (this.map.get(point) ?? EMPTY).filter((c) => c !== contrib));
            this.emit();
        };
    }

    list<K extends keyof Contributions>(point: K): readonly Contributions[K][] {
        return (this.map.get(point) ?? EMPTY) as readonly Contributions[K][];
    }

    find<K extends keyof Contributions>(point: K, pred: (c: Contributions[K]) => boolean) {
        return this.list(point).find(pred);
    }

    readonly subscribe = (fn: () => void) => {
        this.listeners.add(fn);
        return () => { this.listeners.delete(fn); };
    };

    private emit() {
        for (const fn of this.listeners) fn();
    }
}
