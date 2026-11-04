// feature:domains — 非聊天域的视图/nav 注册。各视图组件无 props,
// 领域数据走 useShell()。
import type { Registry } from '../kernel/registry';
import { LibraryView } from '../components/views/LibraryView';
import { RulesView } from '../components/views/RulesView';
import { ExtensionsView } from '../components/views/ExtensionsView';
import { SettingsView } from '../components/views/SettingsView';

export function applyDomainsFeature(r: Registry) {
    r.add('nav.rail', { view: 'stories', icon: 'stories', order: 20 });
    r.add('nav.rail', { view: 'rules', icon: 'rules', order: 30 });
    r.add('nav.rail', { view: 'extensions', icon: 'extensions', order: 40 });
    r.add('view', { view: 'stories', Component: LibraryView });
    r.add('view', { view: 'rules', Component: RulesView });
    r.add('view', { view: 'extensions', Component: ExtensionsView });
    r.add('view', { view: 'settings', Component: SettingsView });
}
