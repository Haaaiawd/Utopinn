// feature:chat — 聊天域:rail 项 + chat view(CenterStage 出口)+ 会话树
//  + stage.form 'chat' 兜底(贡献点契约:默认聊天形态归本 feature)。
import type { Feature } from '../kernel/kernel';
import { CenterStage, ChatStage } from '../components/stage/CenterStage';
import { ChatTree } from '../components/sidebar/trees';
import { HomeView } from '../components/views/SpecViews';

export const chatFeature: Feature = {
    name: 'chat',
    apply(ctx) {
        /* 规范稿 rail 序:home,cards→chat,studio,plugins 品牌图标键 */
        ctx.add('nav.rail', { view: 'home', icon: 'home', order: 10 });
        ctx.add('nav.rail', { view: 'chat', icon: 'chat', order: 20 });
        ctx.add('view', { view: 'chat', Component: CenterStage });
        ctx.add('view', { view: 'home', Component: HomeView });
        ctx.add('stage.form', { kind: 'chat', order: 0, Component: ChatStage });
        ctx.add('sidebar.tree', { rail: 'chat', order: 10, Component: ChatTree });
        ctx.locale('chat', {
            'zh-CN': {
                'home.sub': '角色卡画廊 —— 点卡进会话',
                'common.mockData': '模拟数据 — 服务器未连接',
            },
            en: {},
        });
    },
};
