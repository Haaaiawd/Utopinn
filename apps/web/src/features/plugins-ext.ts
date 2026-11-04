// feature:plugins-ext — TASK-021 插件管理面的词条(独立文件,
// 不与 domains.ts 争行)。ExtensionsView 的消费键全在这里。
import type { Feature, FeatureCtx } from '../kernel/kernel';

export const pluginsExtFeature: Feature = {
    name: 'plugins-ext',
    apply(ctx: FeatureCtx) {
        ctx.locale('plugins-ext', {
            'zh-CN': {
                'ext.plugins': '服务端插件',
                'ext.plugins.desc': 'Cordis 插件在服务端装载 —— 启停落 profile.patch.yaml,reload 热重载。',
                'ext.plugins.empty': '插件清单读不到 —— 服务端离线或管理面未装载。',
                'ext.plugin.enable': '启用',
                'ext.plugin.disable': '停用',
                'ext.plugin.reload': '重载',
                'ext.plugin.status.active': '运行中',
                'ext.plugin.status.disabled': '已停用',
                'ext.plugin.status.failed': '装载失败',
                'ext.plugin.status.degraded': '降级运行',
                'ext.plugin.status.unknown': '未装载',
                'ext.plugin.patched': '手调',
                'ext.plugin.actFailed': '插件操作失败',
            },
            en: {
                'ext.plugins': 'Server plugins',
                'ext.plugins.desc': 'Cordis plugins load server-side — toggles persist to profile.patch.yaml, reload hot-swaps.',
                'ext.plugins.empty': 'Plugin list unavailable — server offline or manager not loaded.',
                'ext.plugin.enable': 'Enable',
                'ext.plugin.disable': 'Disable',
                'ext.plugin.reload': 'Reload',
                'ext.plugin.status.active': 'Active',
                'ext.plugin.status.disabled': 'Disabled',
                'ext.plugin.status.failed': 'Failed',
                'ext.plugin.status.degraded': 'Degraded',
                'ext.plugin.status.unknown': 'Not loaded',
                'ext.plugin.patched': 'patched',
                'ext.plugin.actFailed': 'Plugin action failed',
            },
        });
    },
};
