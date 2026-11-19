// feature:panels — 右工作台板块目录:规范稿七板(preset/mvu/notes/ledger/
// lore/chapters/channels)+ 宿主配套(cardapp/analysis/session/diag 旧板保留)。
// ledger = CardApp 宿主槽(utopinn-th 面板位);ctbar "+" 添加器保留。
import { useI18n } from '../i18n';
import type { Feature, FeatureCtx } from '../kernel/kernel';
import { useContribs, useShell } from '../kernel/context';
import { CardAppBody, stubBody } from '../components/panels/bodies';
import {
    PresetPanel, MvuPanel, NotesPanel, LedgerPanel,
    LorePanel, ChaptersPanel, ChannelsPanel,
} from '../components/panels/SpecPanels';
import { Icon } from '../components/Icon';
import { IconButton } from '../components/ui/icon-button';
import {
    DropdownMenu, DropdownMenuContent, DropdownMenuItem,
    DropdownMenuLabel, DropdownMenuTrigger,
} from '../components/ui/dropdown-menu';

function PanelAddAction() {
    const { t } = useI18n();
    const { openPanelSurface } = useShell();
    const types = useContribs('panel.type');
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <span><IconButton label={t('panel.add')} icon={<Icon name="plus" size={16} />} /></span>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="bottom" align="end">
                <DropdownMenuLabel>{t('panel.add')}</DropdownMenuLabel>
                {types.map((pt) => (
                    <DropdownMenuItem key={pt.type} onClick={() => openPanelSurface(pt.type)}>
                        <Icon name={pt.icon} size={12} />
                        {t(`panel.type.${pt.type}`)}
                        {!pt.wired && <span className="mut" style={{ marginLeft: 'auto' }}>{t('panel.soon')}</span>}
                    </DropdownMenuItem>
                ))}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

export const panelsFeature: Feature = {
    name: 'panels',
    apply(ctx: FeatureCtx) {
        /* —— 规范稿板块目录(548–556):三块"新键"格 + 建议组 —— */
        ctx.add('panel.type', { type: 'preset', icon: 'sliders', wired: true, Body: PresetPanel, category: 'new', desc: 'panel.preset.desc' });
        ctx.add('panel.type', { type: 'mvu', icon: 'database', wired: true, Body: MvuPanel, category: 'new', desc: 'panel.mvu.desc', badge: 'panel.badge.spec' });
        ctx.add('panel.type', { type: 'notes', icon: 'feather', wired: true, Body: NotesPanel, category: 'new', desc: 'panel.notes.desc' });
        ctx.add('panel.type', { type: 'ledger', icon: 'layout', wired: true, Body: LedgerPanel, category: 'suggested', desc: 'panel.ledger.desc' });
        ctx.add('panel.type', { type: 'lore', icon: 'book', wired: false, Body: LorePanel, category: 'suggested', desc: 'panel.lore.desc' });
        ctx.add('panel.type', { type: 'chapters', icon: 'list', wired: false, Body: ChaptersPanel, category: 'suggested', desc: 'panel.chapters.desc' });
        ctx.add('panel.type', { type: 'channels', icon: 'radio', wired: false, Body: ChannelsPanel, category: 'suggested', desc: 'panel.channels.desc' });
        /* —— 宿主旧板块保留(cardapp 宿主/诊断/会话/分析) —— */
        ctx.add('panel.type', { type: 'cardapp', icon: 'layout', wired: true, Body: CardAppBody, category: 'suggested', desc: 'panel.cardapp.desc' });
        ctx.add('panel.type', { type: 'analysis', icon: 'chartLine', wired: false, Body: stubBody('panel.type.analysis'), category: 'suggested', desc: 'panel.analysis.desc' });
        ctx.add('ctbar.chat', { id: 'panel-add', order: 80, Component: PanelAddAction });
        ctx.locale('panels', {
            'zh-CN': {
                'panel.type.preset': '预设',
                'panel.type.mvu': 'MVU 变量',
                'panel.type.notes': '便签',
                'panel.type.ledger': '账簿',
                'panel.type.lore': '世界书',
                'panel.type.chapters': '章节',
                'panel.type.channels': '频道',
                'panel.type.cardapp': '卡面板',
                'panel.type.analysis': '分析',
                'panel.preset.desc': '生成预设目录,点击切换生效预设',
                'panel.mvu.desc': 'MVU 变量快照 — 会话状态变量表',
                'panel.notes.desc': '会话便签 — 速记与待办',
                'panel.ledger.desc': '卡面板(CardApp)宿主 — 卡内 HTML 应用',
                'panel.lore.desc': '世界书条目速览',
                'panel.chapters.desc': '小说形态章节导航',
                'panel.channels.desc': '消息形态频道列表',
                'panel.cardapp.desc': '卡片声明的 HTML 面板入口',
                'panel.analysis.desc': '会话分析占位',
                'panel.badge.spec': '规范',
                'panel.unwired': '接线中',
                'panel.add': '添加板块',
                'panel.close': '关闭板块',
                'panel.stub': '该板块类型已在注册表,本体接线中。',
                'panel.soon': '接线中',
                'panel.panels.empty': '卡内面板(CardApp)入口。当前卡未声明面板。',
                'panel.cardapp.mountFailed': '面板装载失败',
                'panel.cardapp.retry': '重试',
                'panel.cardapp.ctxDegraded': 'ctx 面接线中',
                'panel.preset.mockNote': 'SPEC-DATA: 待接 —— 预设目录为本地 mock,服务端库未出。',
                'panel.mvu.vars': '变量',
                'panel.mvu.echoed': '已回显到舞台',
                'panel.mvu.mockNote': 'SPEC-DATA: 待接 —— MVU 端点未出,数值为本地态。',
                'panel.notes.mockNote': 'SPEC-DATA: 待接 —— 便签持久化未接。',
                'panel.ledger.noChat': '先选中一个会话,账簿才有宿主。',
                'panel.lore.mockNote': 'SPEC-DATA: 待接 —— 条目为 mock 种子。',
                'panel.chapters.words': '字',
                'panel.channels.mockNote': 'SPEC-DATA: 待接 —— 频道为 mock 种子。',
            },
            en: {
                'panel.type.preset': 'Presets',
                'panel.type.mvu': 'MVU Vars',
                'panel.type.notes': 'Notes',
                'panel.type.ledger': 'Ledger',
                'panel.type.lore': 'Lorebook',
                'panel.type.chapters': 'Chapters',
                'panel.type.channels': 'Channels',
                'panel.type.cardapp': 'Card panels',
                'panel.type.analysis': 'Analysis',
                'panel.preset.desc': 'Preset catalog — click to activate',
                'panel.mvu.desc': 'MVU variable snapshot — session state table',
                'panel.notes.desc': 'Session notes — scratchpad and todos',
                'panel.ledger.desc': 'Card-app (CardApp) host — in-card HTML apps',
                'panel.lore.desc': 'Lorebook entry overview',
                'panel.chapters.desc': 'Novel-form chapter navigation',
                'panel.channels.desc': 'Messenger-form channel list',
                'panel.cardapp.desc': 'Entries for card-declared HTML panels',
                'panel.analysis.desc': 'Session analysis placeholder',
                'panel.badge.spec': 'SPEC',
                'panel.unwired': 'wiring',
                'panel.add': 'Add panel',
                'panel.close': 'Close panel',
                'panel.stub': 'Panel type registered; body still being wired.',
                'panel.soon': 'Wiring',
                'panel.panels.empty': 'Card-app panel entries. This card declares no panels.',
                'panel.cardapp.mountFailed': 'Panel mount failed',
                'panel.cardapp.retry': 'Retry',
                'panel.cardapp.ctxDegraded': 'ctx face pending',
                'panel.preset.mockNote': 'SPEC-DATA: preset catalog is local mock — server store pending.',
                'panel.mvu.vars': 'Variables',
                'panel.mvu.echoed': 'Echoed to stage',
                'panel.mvu.mockNote': 'SPEC-DATA: MVU endpoint pending — values are local.',
                'panel.notes.mockNote': 'SPEC-DATA: note persistence pending.',
                'panel.ledger.noChat': 'Pick a session first — the ledger needs its host.',
                'panel.lore.mockNote': 'SPEC-DATA: entries are mock seeds.',
                'panel.chapters.words': 'words',
                'panel.channels.mockNote': 'SPEC-DATA: channels are mock seeds.',
            },
        });
    },
};
