// feature:panels — 规范稿七板块类型注册(preset/mvu/notes/ledger/lore/
// chapters/channels)。板块体在 SpecPanels.tsx;launcher 目录元数据随注册带。
import type { Feature } from '../kernel/kernel';
import {
    CardAppPanel, ChannelsPanel, ChaptersPanel, LedgerPanel, LorePanel, MvuPanel, NotesPanel, PresetPanel,
} from '../components/panels/SpecPanels';

export const panelsFeature: Feature = {
    name: 'panels',
    apply(ctx) {
        ctx.add('panel.type', { type: 'preset', icon: 'sliders', wired: true, Body: PresetPanel, desc: 'panel.desc.preset', category: 'new' });
        ctx.add('panel.type', { type: 'mvu', icon: 'database', wired: true, Body: MvuPanel, desc: 'panel.desc.mvu', category: 'new' });
        ctx.add('panel.type', { type: 'notes', icon: 'note', wired: true, Body: NotesPanel, desc: 'panel.desc.notes', category: 'new' });
        ctx.add('panel.type', { type: 'ledger', icon: 'notebook', wired: true, Body: LedgerPanel, desc: 'panel.desc.ledger', badge: 'panel.badge.cardapp', category: 'suggested' });
        ctx.add('panel.type', { type: 'lore', icon: 'bookOpen', wired: true, Body: LorePanel, desc: 'panel.desc.lore', category: 'suggested' });
        ctx.add('panel.type', { type: 'chapters', icon: 'listNumbers', wired: true, Body: ChaptersPanel, desc: 'panel.desc.chapters', category: 'suggested' });
        ctx.add('panel.type', { type: 'channels', icon: 'messages', wired: true, Body: ChannelsPanel, desc: 'panel.desc.channels', category: 'suggested' });
        ctx.add('panel.type', { type: 'cardapp', icon: 'layout', wired: true, Body: CardAppPanel, desc: 'panel.desc.cardapp', badge: 'panel.badge.cardapp', category: 'suggested' });
    },
};
