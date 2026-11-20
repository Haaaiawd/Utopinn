// feature:plugins — 插件域:rail + view(内置开关 + 市场网格)+ plugins 域树。
import type { Feature } from '../kernel/kernel';
import { PluginsView } from '../components/views/SpecViews';
import { PluginsTree } from '../components/sidebar/trees';

export const pluginsFeature: Feature = {
    name: 'plugins',
    apply(ctx) {
        ctx.add('nav.rail', { view: 'plugins', icon: 'plugins', order: 40 });
        ctx.add('view', { view: 'plugins', Component: PluginsView });
        ctx.add('sidebar.tree', { rail: 'plugins', order: 10, Component: PluginsTree });
        ctx.locale('plugins', {
            'zh-CN': { 'plugins.remove': '移除', 'plugins.installed': '已安装', 'plugins.install': '安装' },
            en: { 'plugins.remove': 'Remove', 'plugins.installed': 'Installed', 'plugins.install': 'Install' },
        });
    },
};
