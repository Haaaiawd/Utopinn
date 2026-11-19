// feature:library — 资产域(utopinn-library):home rail + 资产画廊 +
// 会话/卡侧栏树(home/chat 两个 rail 共一棵 PlayTree)。
// 树是真数据(chats/cards);舞台形态会话行是 mock 种子(SPEC-DATA)。
import type { Feature, FeatureCtx } from '../kernel/kernel';
import { HomeGallery, HubView } from '../components/views/SpecViews';
import { PlayTree } from '../components/sidebar/trees';

export const libraryFeature: Feature = {
    name: 'library',
    apply(ctx: FeatureCtx) {
        ctx.add('nav.rail', { view: 'home', icon: 'home', order: 5 });
        ctx.add('view', { view: 'home', Component: HomeGallery });
        // 移动 hub 页 = 同一资产域的窄屏形态。
        ctx.add('view', { view: 'hub', Component: HubView });
        // home/chat 两个 rail 共一棵树:会话 + 舞台会话(mock 行)。
        ctx.add('sidebar.tree', { rail: 'home', order: 10, Component: PlayTree });
        ctx.add('sidebar.tree', { rail: 'chat', order: 10, Component: PlayTree });
        ctx.locale('library', {
            'zh-CN': {
                'rail.home': '主页',
                'rail.chat': '聊天',
                'rail.studio': '工坊',
                'rail.plugins': '插件',
                'nav.home': '主页',
                'nav.hub': '工坊',
                'nav.studio': '工坊',
                'nav.plugins': '插件',
                'tree.sessions': '会话',
                'tree.stages': '舞台形态',
                'tree.empty': '还没有会话。',
                'tree.mockNote': 'SPEC-DATA: 待接 —— 卡库为 mock 行,服务器未连接。',
                'home.greeting': '晚上好,旅人。',
                'home.sub': '挑一张卡,或继续上次的会话。',
                'home.continue': '继续',
                'home.cards': '角色卡',
                'home.empty': '卡库是空的 —— 去「导入」放第一张卡。',
                'hub.recent': '最近会话',
            },
            en: {
                'rail.home': 'Home',
                'rail.chat': 'Chat',
                'rail.studio': 'Studio',
                'rail.plugins': 'Plugins',
                'nav.home': 'Home',
                'nav.hub': 'Studio',
                'nav.studio': 'Studio',
                'nav.plugins': 'Plugins',
                'tree.sessions': 'Sessions',
                'tree.stages': 'Stage forms',
                'tree.empty': 'No sessions yet.',
                'tree.mockNote': 'SPEC-DATA: card library shows mock rows — server unreachable.',
                'home.greeting': 'Good evening, traveler.',
                'home.sub': 'Pick a card, or continue a session.',
                'home.continue': 'Continue',
                'home.cards': 'Characters',
                'home.empty': 'The library is empty — import your first card.',
                'hub.recent': 'Recent sessions',
            },
        });
    },
};
