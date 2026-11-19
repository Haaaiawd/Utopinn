// feature:studio — 工坊域(资产管理):rail + 分面视图 + 侧栏导航。
// library 分面复用 LibraryView(真卡管理);presets/worlds 走 ctx mock 目录;
// secrets/recent 是诚实占位(SPEC-DATA)。
import type { Feature, FeatureCtx } from '../kernel/kernel';
import { StudioView } from '../components/views/SpecViews';
import { StudioNav } from '../components/sidebar/trees';

export const studioFeature: Feature = {
    name: 'studio',
    apply(ctx: FeatureCtx) {
        ctx.add('nav.rail', { view: 'studio', icon: 'studio', order: 20 });
        ctx.add('view', { view: 'studio', Component: StudioView });
        ctx.add('sidebar.tree', { rail: 'studio', order: 10, Component: StudioNav });
        ctx.locale('studio', {
            'zh-CN': {
                'studio.library': '卡片库',
                'studio.presets': '预设',
                'studio.worlds': '世界书',
                'studio.secrets': '密钥',
                'studio.recent': '最近导入',
                'studio.stubSub': '资产管理域 —— 左树切分面。',
                'studio.secrets.stub': 'SPEC-DATA: 待接 —— 密钥管理端点未出。',
                'studio.recent.stub': 'SPEC-DATA: 待接 —— 导入历史端点未出。',
                'studio.entries': '{n} 条',
            },
            en: {
                'studio.library': 'Cards',
                'studio.presets': 'Presets',
                'studio.worlds': 'Lorebooks',
                'studio.secrets': 'Secrets',
                'studio.recent': 'Recent imports',
                'studio.stubSub': 'Asset domain — pick a facet on the left.',
                'studio.secrets.stub': 'SPEC-DATA: secrets endpoint pending.',
                'studio.recent.stub': 'SPEC-DATA: import-history endpoint pending.',
                'studio.entries': '{n} entries',
            },
        });
    },
};
