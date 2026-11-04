// Kernel — cordis 语义的 web 微内核:服务(provide/get)+ inject 依赖等待
// + effect 作用域。feature 是 {name, inject, apply} 三元组:apply 拿到的
// ctx 把该 feature 的全部注册收进一个作用域,卸载一刀全拆。
// 服务与贡献点分层:服务是"对象级依赖"(api/壳能力),贡献点是"表面注册"。
// inject 语义:deps 未齐排入 waiters;某 provide 落地时 flush 重评。
// 已 apply 的依赖方不随后续 unprovide 回滚( cordis 的 fiber 语义同理——
// 依赖方自行用 effect 处理服务替换)。
import type { Contributions } from './contributions';
import { Registry, type Disposer } from './registry';

type Dicts = Record<string, Record<string, string>>;

/** feature 在 apply 里拿到的上下文 —— 本作用域内创建的一切注册皆可拆。 */
export interface FeatureCtx {
    readonly registry: Registry;
    add<K extends keyof Contributions>(point: K, contrib: Contributions[K]): Disposer;
    /** 作用域内执行,返回的 disposer 计入卸载。 */
    effect(fn: () => Disposer | void): void;
    /** 等待服务到位再执行;嵌套 inject 的清理也计入本作用域。 */
    inject(deps: readonly string[], fn: (ctx: FeatureCtx) => void): Disposer;
    provide<T>(name: string, svc: T): Disposer;
    get<T>(name: string): T | undefined;
    /** 词条注册(locale 贡献点的糖)。 */
    locale(ns: string, dicts: Dicts): Disposer;
}

/** 静态 feature 模块的导出形状(仿 dsh ui-* 包的 inject+apply)。 */
export interface Feature {
    name: string;
    /** 依赖的服务名;齐了才 apply。 */
    inject?: readonly string[];
    apply(ctx: FeatureCtx): void;
}

interface Waiter {
    deps: readonly string[];
    fn: (ctx: FeatureCtx) => void;
    cleanups: Disposer[];
    disposed: boolean;
}

export class Kernel {
    readonly registry = new Registry();
    private readonly services = new Map<string, unknown>();
    private readonly waiters = new Set<Waiter>();

    applyFeature(f: Feature): Disposer {
        return this.inject(f.inject ?? [], f.apply);
    }

    provide<T>(name: string, svc: T): Disposer {
        this.services.set(name, svc);
        this.flush();
        return () => { this.services.delete(name); };
    }

    get<T>(name: string): T | undefined {
        return this.services.get(name) as T | undefined;
    }

    inject(deps: readonly string[], fn: (ctx: FeatureCtx) => void): Disposer {
        const w: Waiter = { deps, fn, cleanups: [], disposed: false };
        if (this.ready(deps)) this.fire(w);
        else this.waiters.add(w);
        return () => {
            w.disposed = true;
            this.waiters.delete(w);
            for (const d of w.cleanups.splice(0)) d();
        };
    }

    private ready(deps: readonly string[]) {
        return deps.every((d) => this.services.has(d));
    }

    private flush() {
        for (const w of [...this.waiters]) {
            if (w.disposed || !this.ready(w.deps)) continue;
            this.waiters.delete(w);
            this.fire(w);
        }
    }

    private fire(w: Waiter) {
        if (w.disposed) return;
        w.fn(this.scope(w));
    }

    private scope(w: Waiter): FeatureCtx {
        const collect = (d?: Disposer | void): Disposer => {
            if (typeof d === 'function') { w.cleanups.push(d); return d; }
            return () => undefined;
        };
        return {
            registry: this.registry,
            add: <K extends keyof Contributions>(point: K, contrib: Contributions[K]) =>
                collect(this.registry.add(point, contrib)),
            effect: (fn) => { collect(fn()); },
            inject: (deps, fn) => collect(this.inject(deps, fn)),
            provide: (name, svc) => collect(this.provide(name, svc)),
            get: (name) => this.get(name),
            locale: (ns, dicts) => collect(this.registry.add('locale', { ns, dicts })),
        };
    }
}
