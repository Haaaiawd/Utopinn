// feature:plugins — 插件域:rail + view(内核锁定 / 可停用 / 市场三段,真 API)+ plugins 域树。
// 视图体在 components/views/plugins.tsx;设置「Cordis 插件」页签共享 PluginsSections。
import type { Feature } from '../kernel/kernel';
import { PluginsView } from '../components/views/plugins';
import { PluginsTree } from '../components/sidebar/trees';

export const pluginsFeature: Feature = {
    name: 'plugins',
    apply(ctx) {
        ctx.add('nav.rail', { view: 'plugins', icon: 'plugins', order: 40 });
        ctx.add('view', { view: 'plugins', Component: PluginsView });
        ctx.add('sidebar.tree', { rail: 'plugins', order: 10, Component: PluginsTree });
        ctx.locale('plugins', {
            'zh-CN': {
                'plugins.remove': '移除', 'plugins.installed': '已安装', 'plugins.install': '安装',
                'plugins.sub': '安装、启用和配置 Cordis 后端服务、Stage 形态与右栏面板插件',
                'plugins.refresh': '刷新', 'plugins.refreshed': '插件清单已刷新',
                'plugins.core': '内核插件(锁定不可停用)', 'plugins.locked': '核心锁定',
                'plugins.lockedHint': '内核插件不可关闭 —— 启停要改 profile.patch.yaml',
                'plugins.sys': '可停用系统插件', 'plugins.reload': '热重载插件',
                'plugins.reloadDone': '已热重载插件', 'plugins.actFailed': '插件操作失败',
                'plugins.none': '此组没有插件', 'plugins.market': 'Stage 形态与扩展市场',
                'plugins.marketHint': '计划中 · C12 ui.contrib',
                'plugins.bundled': '已内置', 'plugins.planned': '计划中',
                /* 详情卡(rail 页详情面) */
                'plugins.detail.back': '返回总览', 'plugins.detail.contribs': 'UI 贡献清单',
                'plugins.detail.noContribs': '无 UI 贡献', 'plugins.detail.gone': '该插件不在当前清单中 —— 可能刚被移除或改名',
                'plugins.detail.planned': '计划中 · 安装面未备(C12 只读 manifest)',
            },
            en: {
                'plugins.remove': 'Remove', 'plugins.installed': 'Installed', 'plugins.install': 'Install',
                'plugins.sub': 'Install, enable and configure Cordis backend services, stage forms and workbench panel plugins',
                'plugins.refresh': 'Refresh', 'plugins.refreshed': 'Plugin list refreshed',
                'plugins.core': 'Kernel plugins (locked, cannot be disabled)', 'plugins.locked': 'Core locked',
                'plugins.lockedHint': 'Kernel plugins cannot be toggled — enablement lives in profile.patch.yaml',
                'plugins.sys': 'Optional system plugins', 'plugins.reload': 'Hot-reload plugin',
                'plugins.reloadDone': 'Plugin hot-reloaded', 'plugins.actFailed': 'Plugin action failed',
                'plugins.none': 'No plugins in this group', 'plugins.market': 'Stage forms & extension market',
                'plugins.marketHint': 'Planned · C12 ui.contrib',
                'plugins.bundled': 'Bundled', 'plugins.planned': 'Planned',
                /* 详情卡(rail 页详情面) */
                'plugins.detail.back': 'Back to overview', 'plugins.detail.contribs': 'UI contributions',
                'plugins.detail.noContribs': 'No UI contributions', 'plugins.detail.gone': 'This plugin is not in the current list — it may have just been removed or renamed',
                'plugins.detail.planned': 'Planned · install surface not ready (C12 read-only manifest)',
            },
        });
    },
};
