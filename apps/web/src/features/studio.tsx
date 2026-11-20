// feature:studio — 工作室域:rail + view(六类端稿页)+ studio 域树。
// 另注移动端资产工坊 hub view(端稿 renderMobileHubPage)—— 走 view 贡献点,
// 不硬编进 App;MobileFrame 按 s.view==='hub' 从 registry 解析。
import type { Feature } from '../kernel/kernel';
import { StudioView, MobileHubView } from '../components/views/studio';
import { StudioTree } from '../components/sidebar/trees';

export const studioFeature: Feature = {
    name: 'studio',
    apply(ctx) {
        ctx.add('nav.rail', { view: 'studio', icon: 'bookOpen', order: 30 });
        ctx.add('view', { view: 'studio', Component: StudioView });
        // 移动端资产工坊 —— view:'hub' 贡献(VIEW_IDS 已含 'hub')。
        ctx.add('view', { view: 'hub', Component: MobileHubView });
        ctx.add('sidebar.tree', { rail: 'studio', order: 10, Component: StudioTree });
    },
};
