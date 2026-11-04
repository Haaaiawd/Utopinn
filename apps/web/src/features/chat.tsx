// feature:chat — 聊天域。注册 nav、视图、session/diag 板块、
// prose 渲染器、ctbar 沉浸动作、本域词条。壳不认识它,只认贡献点。
import { useI18n } from '../i18n';
import type { Feature, FeatureCtx } from '../kernel/kernel';
import { useShell } from '../kernel/context';
import { ChatView } from '../components/chat/ChatView';
import { ProseRenderer } from '../components/chat/renderers/ProseRenderer';
import { SessionBody, DiagBody } from '../components/panels/bodies';
import { Icon } from '../components/Icon';
import { IconButton } from '../components/ui/icon-button';

function ImmersiveAction() {
    const { t } = useI18n();
    const { immersive } = useShell();
    return <IconButton label={t('menu.view.immersive')} icon={<Icon name="focus" size={16} />} onClick={immersive} />;
}

export const chatFeature: Feature = {
    name: 'chat',
    apply(ctx: FeatureCtx) {
        ctx.add('nav.rail', { view: 'chat', icon: 'chat', order: 10 });
        ctx.add('view', { view: 'chat', Component: ChatView });
        ctx.add('panel.type', { type: 'session', icon: 'user', wired: true, Body: SessionBody });
        ctx.add('panel.type', { type: 'diag', icon: 'pulse', wired: true, Body: DiagBody });
        ctx.add('renderer', { id: 'prose', order: 10, Component: ProseRenderer });
        ctx.add('ctbar.chat', { id: 'immersive', order: 90, Component: ImmersiveAction });
        ctx.locale('chat', {
            'zh-CN': {
                'nav.chat': '聊天',
                'sidebar.newChat': '新会话',
                'sidebar.search': '搜索',
                'sidebar.recent': '最近',
                'menu.view.immersive': '沉浸模式',

                'chat.tabs.conversation': '对话',
                'chat.tabs.preview': '提示词预览',
                'chat.preview.empty': '还没有预览。切到此 tab 会按需跑一次 /api/uberge/preview。',
                'chat.preview.mock': '模拟数据 — 服务器未连接',
                'chat.preview.failed': '预览失败',
                'chat.send': '发送',
                'chat.send.draftOnly': '本地草稿 — 服务器离线或生成中',
                'chat.send.failed': '发送失败',
                'chat.input.placeholder': '输入消息…(Enter 发送,Shift+Enter 换行)',
                'chat.swipe': '版本',
                'chat.action.edit': '编辑',
                'chat.action.regen': '重新生成',
                'chat.action.more': '更多',
                'chat.action.unwired': '未接线',
                'chat.rename': '重命名会话',
                'chat.rename.failed': '重命名失败',
                'chat.delete': '删除会话',
                'chat.delete.failed': '删除失败',
                'chat.delete.confirm': '删除这个会话?此操作不可撤销。',

                'panel.type.session': '本局',
                'panel.type.diag': '诊断',
                'panel.session.authorNote': '作者注',
                'panel.session.cfg': 'CFG',
                'panel.session.logprobs': 'Logprobs',
                'panel.session.unwired': '会话级注入位 — 骨架占位',
                'panel.diag.noData': '跑一次「提示词预览」后,这里显示 sources 与 trace。',
                'diag.sources': '来源',
                'diag.trace': '组装轨迹',
                'diag.preset': '预设',
                'diag.model': '模型',
                'diag.wi': '世界书命中',
                'diag.chatCount': '历史消息',
                'diag.budget': 'Token 预算',
                'diag.remaining': '剩余预算',
                'diag.dropped': '丢弃历史',
                'diag.injected': '注入条数',
                'diag.collections': '集合',
                'diag.col.tokens': 'tokens',
                'diag.col.count': '条数',
                'diag.messages': '组装消息',
                'diag.raw': '原始 JSON',
            },
            en: {
                'nav.chat': 'Chat',
                'sidebar.newChat': 'New chat',
                'sidebar.search': 'Search',
                'sidebar.recent': 'Recent',
                'menu.view.immersive': 'Immersive mode',

                'chat.tabs.conversation': 'Conversation',
                'chat.tabs.preview': 'Prompt preview',
                'chat.preview.empty': 'No preview yet. Switching here runs /api/uberge/preview on demand.',
                'chat.preview.mock': 'mock data — server unreachable',
                'chat.preview.failed': 'Preview failed',
                'chat.send': 'Send',
                'chat.send.draftOnly': 'local draft — server offline or streaming',
                'chat.send.failed': 'send failed',
                'chat.input.placeholder': 'Type a message… (Enter to send, Shift+Enter for newline)',
                'chat.swipe': 'swipe',
                'chat.action.edit': 'Edit',
                'chat.action.regen': 'Regenerate',
                'chat.action.more': 'More',
                'chat.action.unwired': 'not wired',
                'chat.rename': 'Rename chat',
                'chat.rename.failed': 'rename failed',
                'chat.delete': 'Delete chat',
                'chat.delete.failed': 'delete failed',
                'chat.delete.confirm': 'Delete this chat? This cannot be undone.',

                'panel.type.session': 'Session',
                'panel.type.diag': 'Diagnostics',
                'panel.session.authorNote': "Author's note",
                'panel.session.cfg': 'CFG',
                'panel.session.logprobs': 'Logprobs',
                'panel.session.unwired': 'Session-level injection slots — skeleton placeholder',
                'panel.diag.noData': 'Run "Prompt preview" and sources + trace land here.',
                'diag.sources': 'Sources',
                'diag.trace': 'Assembly trace',
                'diag.preset': 'Preset',
                'diag.model': 'Model',
                'diag.wi': 'WI injected',
                'diag.chatCount': 'History',
                'diag.budget': 'Token budget',
                'diag.remaining': 'Remaining',
                'diag.dropped': 'Dropped history',
                'diag.injected': 'Injected',
                'diag.collections': 'Collections',
                'diag.col.tokens': 'tokens',
                'diag.col.count': 'msgs',
                'diag.messages': 'Assembled messages',
                'diag.raw': 'Raw JSON',
            },
        });
    },
};
