// feature:panels — 规范稿板块类型注册(preset/mvu/notes/ledger/lore/
// chapters/channels/cardapp + 观测面 diag/stats)。板块体在 SpecPanels.tsx
// 与 DiagPanel/StatsPanel;launcher 目录元数据随注册带,category 对齐规范稿
// PANEL_CATALOG 三桶:cardapp = 卡提供面板(iframe 宿主),其余归 system,
// suggested 留给三方贡献。
// wired 声明面改由服务端说了算:注册时先按本地已知真值落静态旗标(离线
// 兜底就是今天的真值),hydratePanelTypes 拉 /api/utopinn/ui/contrib 在
// 本作用域内原位对账 —— 服务端声明 wired:true 而本地未接的类型纠正为
// true;服务端声明了、本地没有的类型注册占位条目;服务端没声明的本地
// 类型原样保留。Body 组件线形给不了,永远本地。
import type { Feature } from '../kernel/kernel';
import type { PanelTypeContribution } from '../kernel/contributions';
import {
    CardAppPanel, ChannelsPanel, ChaptersPanel, IzumiPanel, LorePanel, MessageFramePanel, MvuPanel, NotesPanel, PresetPanel,
} from '../components/panels/SpecPanels';
import { DiagPanel } from '../components/panels/DiagPanel';
import { StatsPanel } from '../components/panels/StatsPanel';
import { hydratePanelTypes, type RegisteredPanel } from './contrib';

export const panelsFeature: Feature = {
    name: 'panels',
    apply(ctx) {
        /* 注册序=launcher 网格序,对齐规范稿 PANEL_CATALOG:
         * cardapp 桶(ledger/cardapp)先行,系统桶 mvu→lore→diag→stats→chapters→notes,
         * preset 为规范稿目录外的真实有线面板,殿后;channels 摘 hidden 桶不进网格。 */
        const reg: RegisteredPanel[] = [];
        const add = (contrib: PanelTypeContribution) =>
            reg.push({ contrib, dispose: ctx.add('panel.type', contrib) });
        add({ type: 'cardapp', icon: 'layout', wired: true, Body: CardAppPanel, desc: 'panel.desc.cardapp', badge: 'panel.badge.cardapp', category: 'cardapp' });
        add({ type: 'mvu', icon: 'database', wired: true, Body: MvuPanel, desc: 'panel.desc.mvu', category: 'system' });
        add({ type: 'izumi', icon: 'brain', wired: true, Body: IzumiPanel, desc: 'panel.desc.izumi', category: 'system' });
        add({ type: 'lore', icon: 'bookOpen', wired: true, Body: LorePanel, desc: 'panel.desc.lore', category: 'system' });
        add({ type: 'diag', icon: 'code', wired: true, Body: DiagPanel, desc: 'panel.desc.diag', badge: 'diag', category: 'system' });
        add({ type: 'stats', icon: 'compass', wired: true, Body: StatsPanel, desc: 'panel.desc.stats', badge: 'stats', category: 'system' });
        /* chapters —— 真接线:楼层推导目录(lib/novelToc 同源 NovelBody)。 */
        add({ type: 'chapters', icon: 'listNumbers', wired: true, Body: ChaptersPanel, desc: 'panel.desc.chapters', category: 'system' });
        /* channels —— 服务端无此面:Body =「未提供」空态(假列表已废),
         *  category:'hidden' 摘出 launcher/cmdk 目录(部署版不见入口),
         *  条目仍可经代码 openPanel 打开;wired:false 照实留。 */
        add({ type: 'channels', icon: 'messages', wired: false, Body: ChannelsPanel, desc: 'panel.desc.channels', category: 'hidden' });
        add({ type: 'notes', icon: 'note', wired: true, Body: NotesPanel, desc: 'panel.desc.notes', category: 'system' });
        /* preset 为规范稿目录外的真实有线面板,殿后不扰动前 7 格序。 */
        add({ type: 'preset', icon: 'sliders', wired: true, Body: PresetPanel, desc: 'panel.desc.preset', category: 'system' });
        /* messageframe —— 楼层嵌帧「收至右栏」的承载板块:可开 tab 可拆窗,
           但不进 launcher 任何桶(瞬态承载,dock 动作直开,非目录条目)。 */
        add({ type: 'messageframe', icon: 'layout', wired: true, Body: MessageFramePanel, title: 'panel.type.messageframe', category: 'hidden' });
        /* 服务端清单水合:声明面元数据(wired 真值/缺省补齐/占位注册)由
         * /api/utopinn/ui/contrib 对账;失败静默 —— 静态旗标即离线真值。 */
        hydratePanelTypes(ctx, reg);
    },
};
