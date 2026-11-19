// feature:studio — 工作室域:rail + view(世界书双栏)+ studio 域树。
import type { Feature } from '../kernel/kernel';
import { StudioView } from '../components/views/SpecViews';
import { StudioTree } from '../components/sidebar/trees';

export const studioFeature: Feature = {
    name: 'studio',
    apply(ctx) {
        ctx.add('nav.rail', { view: 'studio', icon: 'bookOpen', order: 30 });
        ctx.add('view', { view: 'studio', Component: StudioView });
        ctx.add('sidebar.tree', { rail: 'studio', order: 10, Component: StudioTree });
    },
};
