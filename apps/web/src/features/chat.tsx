// feature:chat — 聊天域:rail 项 + chat view(CenterStage 出口)+ 会话树
//  + stage.form 'chat' 兜底 + 'char' 角色页(TASK-026 三级路径中层)
//  + renderer 'utopinn.prose'(消息四惯例,贡献点契约:默认聊天形态归本 feature)。
import type { Feature } from '../kernel/kernel';
import { CenterStage, ChatStage } from '../components/stage/CenterStage';
import { ProseFloor } from '../components/stage/prose';
import { ChatTree } from '../components/sidebar/trees';
import { HomeView } from '../components/views/SpecViews';
import { CharView } from '../components/views/charpage';

export const chatFeature: Feature = {
    name: 'chat',
    apply(ctx) {
        /* 规范稿 rail 序:home,cards→chat,studio,plugins 品牌图标键 */
        ctx.add('nav.rail', { view: 'home', icon: 'home', order: 10 });
        ctx.add('nav.rail', { view: 'chat', icon: 'chat', order: 20 });
        ctx.add('view', { view: 'chat', Component: CenterStage });
        ctx.add('view', { view: 'home', Component: HomeView });
        /* TASK-026:卡格 → 角色页 → 会话三级路径的中间层(非 rail 视图)。 */
        ctx.add('view', { view: 'char', Component: CharView });
        ctx.add('stage.form', { kind: 'chat', order: 0, Component: ChatStage });
        /* 消息惯例默认渲染器:order 0 兜底,三方 renderer 贡献可整面替换。 */
        ctx.add('renderer', { id: 'utopinn.prose', order: 0, Component: ProseFloor });
        ctx.add('sidebar.tree', { rail: 'chat', order: 10, Component: ChatTree });
        ctx.locale('chat', {
            'zh-CN': {
                'home.sub': '角色卡画廊 —— 点卡进角色页',
                'nav.char': '角色页',
                'charpage.edit': '编辑卡',
                'charpage.greeting': '开场白',
                'charpage.chats.empty': '还没有会话',
                'charpage.chats.emptyDesc': '新建一段对话,这个角色就从卡面变成正在发生的故事。',
                'charpage.floors': '楼',
                'charpage.docFailed': '卡文档读取失败',
                'charpage.nodir': '未选中角色',
                'charpage.nodir.desc': '从卡面大厅点一张卡,先落进它的角色页。',
                'charpage.chip.world': '主绑世界书 —— 点按管理',
                'charpage.chip.embedded': '内嵌书',
                'charpage.chip.embedded.t': '卡内嵌世界书条目 —— 点按编辑卡',
                'charpage.chip.extraBooks': '辅绑世界书',
                'charpage.chip.regex': '卡级正则脚本(启用/总条数)',
                'charpage.chip.regex.off': '卡级正则存在但未放行',
                'stage.chip.world': '卡主绑世界书 —— 点按管理',
                'stage.chip.embedded': '卡内嵌世界书条目 —— 点按编辑卡',
                'stage.chip.regex': '卡级正则脚本(启用/总条数) —— 点按管理',
                'stage.chip.regex.off': '卡级正则存在但未放行 —— 点按管理',
                'stage.chip.regex.short': '正则',
            },
            en: {
                'home.sub': 'Card gallery — tap a card for its page',
                'nav.char': 'Character',
                'charpage.edit': 'Edit card',
                'charpage.greeting': 'Greeting',
                'charpage.chats.empty': 'No chats yet',
                'charpage.chats.emptyDesc': 'Start a chat — the card stops being a file and becomes a story.',
                'charpage.floors': 'floors',
                'charpage.docFailed': 'Failed to read card document',
                'charpage.nodir': 'No character selected',
                'charpage.nodir.desc': 'Pick a card in the gallery — it opens here first.',
                'charpage.chip.world': 'Primary bound lorebook — manage',
                'charpage.chip.embedded': 'Embedded book',
                'charpage.chip.embedded.t': 'Entries embedded in the card — edit card',
                'charpage.chip.extraBooks': 'Extra lorebooks',
                'charpage.chip.regex': 'Card-scoped regex scripts (enabled/total)',
                'charpage.chip.regex.off': 'Card regex present but not allowed',
                'stage.chip.world': 'Card-bound lorebook — manage',
                'stage.chip.embedded': 'Embedded lorebook entries — edit card',
                'stage.chip.regex': 'Card-scoped regex (enabled/total) — manage',
                'stage.chip.regex.off': 'Card regex present but not allowed — manage',
                'stage.chip.regex.short': 'regex',
            },
        });
    },
};
