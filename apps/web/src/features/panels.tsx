// feature:panels — 规范稿板块类型注册(preset/mvu/notes/ledger/lore/
// chapters/channels/cardapp + 观测面 diag/stats)。板块体在 SpecPanels.tsx
// 与 DiagPanel/StatsPanel;launcher 目录元数据随注册带,category 对齐规范稿
// PANEL_CATALOG 三桶:cardapp = 卡提供面板(iframe 宿主),其余归 system,
// suggested 留给三方贡献。wired 按实际接线诚实标:
//   preset/mvu/notes/ledger/cardapp/diag/stats 已接真服务端面 → wired:true;
//   lore/chapters/channels 服务端面未备、内容仍是 mock → wired:false +
//   「待服务端面」badge。
import type { Feature } from '../kernel/kernel';
import {
    CardAppPanel, ChannelsPanel, ChaptersPanel, LedgerPanel, LorePanel, MvuPanel, NotesPanel, PresetPanel,
} from '../components/panels/SpecPanels';
import { DiagPanel } from '../components/panels/DiagPanel';
import { StatsPanel } from '../components/panels/StatsPanel';

export const panelsFeature: Feature = {
    name: 'panels',
    apply(ctx) {
        ctx.add('panel.type', { type: 'preset', icon: 'sliders', wired: true, Body: PresetPanel, desc: 'panel.desc.preset', category: 'system' });
        ctx.add('panel.type', { type: 'mvu', icon: 'database', wired: true, Body: MvuPanel, desc: 'panel.desc.mvu', category: 'system' });
        ctx.add('panel.type', { type: 'notes', icon: 'note', wired: true, Body: NotesPanel, desc: 'panel.desc.notes', category: 'system' });
        ctx.add('panel.type', { type: 'diag', icon: 'code', wired: true, Body: DiagPanel, desc: 'panel.desc.diag', badge: 'diag', category: 'system' });
        ctx.add('panel.type', { type: 'stats', icon: 'compass', wired: true, Body: StatsPanel, desc: 'panel.desc.stats', badge: 'stats', category: 'system' });
        ctx.add('panel.type', { type: 'ledger', icon: 'notebook', wired: true, Body: LedgerPanel, desc: 'panel.desc.ledger', badge: 'panel.badge.cardapp', category: 'cardapp' });
        ctx.add('panel.type', { type: 'cardapp', icon: 'layout', wired: true, Body: CardAppPanel, desc: 'panel.desc.cardapp', badge: 'panel.badge.cardapp', category: 'cardapp' });
        ctx.add('panel.type', { type: 'lore', icon: 'bookOpen', wired: false, Body: LorePanel, desc: 'panel.desc.lore', badge: 'panel.badge.unwired', category: 'system' });
        ctx.add('panel.type', { type: 'chapters', icon: 'listNumbers', wired: false, Body: ChaptersPanel, desc: 'panel.desc.chapters', badge: 'panel.badge.unwired', category: 'system' });
        ctx.add('panel.type', { type: 'channels', icon: 'messages', wired: false, Body: ChannelsPanel, desc: 'panel.desc.channels', badge: 'panel.badge.unwired', category: 'system' });
    },
};
