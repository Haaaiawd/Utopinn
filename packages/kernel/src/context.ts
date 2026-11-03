import { Context, Service, Inject } from 'cordis';
import type { PluginModule } from './plugin.js';

export { Context, Service, Inject };

/**
 * 服务角色登记(plugin-architecture.md §服务四分):
 *   core    — 单实现,随声明走(chats/users/settings)
 *   seam    — 可换,Definition/Provider/Consumer 三角(promptBuilder/variableStore/conversationRenderer)
 *   bundle  — profile 选一个(generation 编排器/panelBridge)
 *   service — 输出侧(injectedPrompts/telemetry)
 */
export type ServiceRole = 'core' | 'seam' | 'bundle' | 'service';

export interface ServiceRegistration {
    role: ServiceRole;
    name: string;
    providedBy: string;
}

/** 已登记服务清单(诊断页数据源:谁提供/谁消费/degraded) */
export class ServiceCatalog {
    private regs = new Map<string, ServiceRegistration>();

    register(reg: ServiceRegistration): () => void {
        const prev = this.regs.get(reg.name);
        this.regs.set(reg.name, reg);
        return () => {
            if (this.regs.get(reg.name) === reg) {
                if (prev) this.regs.set(reg.name, prev);
                else this.regs.delete(reg.name);
            }
        };
    }

    list(): ServiceRegistration[] {
        return [...this.regs.values()];
    }

    owner(name: string): string | undefined {
        return this.regs.get(name)?.providedBy;
    }
}

/** 应用根上下文:cordis Context + Uberge 约定面 */
export interface AppContext extends Context {
    catalog: ServiceCatalog;
}

export function createAppContext(): AppContext {
    const root = new Context() as AppContext;
    const catalog = new ServiceCatalog();
    root.provide('catalog', catalog);
    root.catalog = catalog;
    return root;
}

/**
 * seam 登记助手:Definition/Provider/Consumer 三角中的 Provider 侧。
 * 可逆——dispose 时回退上一个 provider(seam 替换测试依赖此语义)。
 */
export function provideSeam(
    ctx: AppContext,
    role: ServiceRole,
    name: string,
    providedBy: string,
    impl: unknown,
): () => void {
    (ctx as unknown as Record<string, unknown>)[name] = impl;
    const undo = ctx.catalog.register({ role, name, providedBy });
    ctx.effect(() => undo);
    return undo;
}

/**
 * 事件五模式约定(契约化在事件声明处,不在调用处):
 *   emit      即发即忘 —— generation/stream
 *   serial    有序串联 —— chat/messagePersisted(MVU settle 挂这)
 *   parallel  并发
 *   bail      短路 —— 准入校验
 *   waterfall 变换链,必须 next() —— generation/preBuild、settle
 *
 * waterfall 真实语义(实证):ctx.waterfall(name, ...args, inner)
 *   args 固定传给每个监听者(...args, next);inner=末参,无参,产出基值;
 *   next() 深入一层(只能调一次),变换在各层返回值回溯中叠加。
 *   用例:preBuild(req, ()=>defaultBuild(req)) —— req 不动,draft 被逐层改写。
 */
export const DispatchMode = {
    Emit: 'emit',
    Serial: 'serial',
    Parallel: 'parallel',
    Bail: 'bail',
    Waterfall: 'waterfall',
} as const;
export type DispatchMode = (typeof DispatchMode)[keyof typeof DispatchMode];
