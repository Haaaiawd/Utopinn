// feature:plugins — 插件域(utopinn-plugins + utopinn-script):
// installed 分面复用 ExtensionsView(真插件管理),market 走 mock 目录。
// 合并 plugins-ext 词条(ExtensionsView 的消费键都在)。
import type { Feature, FeatureCtx } from '../kernel/kernel';
import { PluginsView } from '../components/views/SpecViews';
import { PluginsNav } from '../components/sidebar/trees';

export const pluginsFeature: Feature = {
    name: 'plugins',
    apply(ctx: FeatureCtx) {
        ctx.add('nav.rail', { view: 'plugins', icon: 'plugins', order: 30 });
        ctx.add('view', { view: 'plugins', Component: PluginsView });
        ctx.add('sidebar.tree', { rail: 'plugins', order: 10, Component: PluginsNav });
        ctx.locale('plugins', {
            'zh-CN': {
                'plugins.installed': '已安装',
                'plugins.market': '市场',
                'plugins.marketSub': 'SPEC-DATA: 待接 —— 市场目录为 mock,安装按钮只翻本地态。',
                'plugins.installedBtn': '已装',
                'plugins.install': '安装',
                'plugins.mockNote': 'SPEC-DATA: 待接 —— 市场无服务端源。',
                /* —— plugins-ext(ExtensionsView 消费键,原样保留) —— */
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
                'plugins.installed': 'Installed',
                'plugins.market': 'Market',
                'plugins.marketSub': 'SPEC-DATA: market catalog is mock — install only flips local state.',
                'plugins.installedBtn': 'Installed',
                'plugins.install': 'Install',
                'plugins.mockNote': 'SPEC-DATA: no server source for the market.',
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
