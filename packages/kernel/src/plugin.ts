/**
 * 插件契约(直接映射 cordis 三形态):
 *   function(ctx, config) => void
 *   class P extends Service { constructor(ctx, config) }
 *   { apply(ctx, config) }
 * 共享静态/字段:name、Config(schemastery Schema)、inject、provide、intercept
 */

export interface PluginModule<C = unknown> {
    name?: string;
    apply?: (ctx: unknown, config: C) => void;
    inject?: string[] | Record<string, string[]>;
    provide?: string[];
    intercept?: string[];
    Config?: unknown;
    default?: unknown;
}

export interface PluginEntry {
    /** 插件 id(profile 行名,可被 patch 行整体替换) */
    id: string;
    /** 模块路径(import specifier)或已加载的模块对象 */
    module: string | PluginModule | ((ctx: unknown, config: unknown) => void);
    /** 插件 config(经 schemastery 校验后传入 apply) */
    config?: Record<string, unknown>;
    /** 禁用但保留行位(不装载) */
    disabled?: boolean;
}

export interface PluginManifest {
    name: string;
    version: string;
    description?: string;
    provides?: string[];
    inject?: string[];
    /** UI 贡献点声明(见 plugin-architecture.md §插件UI贡献点) */
    contributes?: {
        settingsCard?: Record<string, unknown>;
        navPage?: { id: string; title: string; icon?: string };
        paletteCmd?: { id: string; title: string }[];
        conversationRenderer?: { id: string; name: string }[];
        sessionPanelItem?: { id: string; title: string }[];
        statusPanel?: { id: string; title: string }[];
    };
}
