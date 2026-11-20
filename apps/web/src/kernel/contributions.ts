// Contribution point table — 仿 dsh ui-slots:壳不枚举 feature,
// feature 向类型化贡献点注册自己。v1 集中声明八个点;将来服务端插件
// manifest hydrate 时,新点在各 feature 文件里 declare module 合并进来,
// 不靠本文件扩枚举(槽位类型安全不变)。
import type { ComponentType } from 'react';
import type { IconName } from '../components/Icon';
import type { StageKind, ViewId } from '../types';

/** 板块类型是不透明字符串(同 dockkit:kind 不归宿主解释)。
 *  规范稿 openTabs/activeTab 语义:板块实例即类型本身,同类型同时至多一页。 */
export type PanelType = string;

export interface NavRailContribution {
    view: ViewId;
    icon: IconName;
    /** 同点内排序键,小在前。 */
    order: number;
}

/** 视图贡献:组件无 props —— 领域数据全部走 useShell()。 */
export interface ViewContribution {
    view: ViewId;
    Component: ComponentType;
}

export interface PanelTypeContribution {
    type: PanelType;
    icon: IconName;
    /** 未接线类型在选择器里诚实标「接线中」,body 通常给 StubBody。 */
    wired: boolean;
    /** 板块本体 —— 无 props,数据走 useShell()。 */
    Body: ComponentType;
    /** wb-tab 显示名 —— i18n 键(t() 回落键名);规范稿 PANEL_CATALOG.title。 */
    title?: string;
    /** launcher 目录元数据:desc/badge 是 i18n 键(t() 回落键名);
     *  category 决定 launcher 分组 —— 规范稿 PANEL_CATALOG 三桶:
     *  'system' 系统面板格 / 'cardapp' 卡提供面板行(iframe 宿主) /
     *  'suggested' 建议组(缺省按 system 收)。 */
    desc?: string;
    badge?: string;
    category?: 'system' | 'cardapp' | 'suggested';
}

/** 左树面板贡献:归属 rail 域,壳按当前 railTab 渲染全部匹配贡献
 *  (order 排序叠放)。侧栏 body 不再由壳 if/switch —— 树内容归 feature。 */
export interface SidebarContribution {
    /** 归属 rail 域('home' | 'chat' | 'studio' | 'plugins' | …)。 */
    rail: string;
    order: number;
    Component: ComponentType;
}

/** 舞台形态贡献:ChatSummary.stage → 中央区内容组件。
 *  'chat' 由 chat feature 兜底注册;novel/messenger/galgame 等
 *  归 stage 插件 feature(stagepack)注册 —— 壳只认 kind 字符串。 */
export interface StageFormContribution {
    kind: StageKind;
    order: number;
    Component: ComponentType;
}

export interface RendererContribution {
    id: string;
    order: number;
    Component: ComponentType;
}

/** ctbar 右侧动作位(chat 视图)。 */
export interface CtbarActionContribution {
    id: string;
    order: number;
    Component: ComponentType;
}

/** locale 贡献:feature 自带词条,按 locale id 分字典。
 *  键已按约定带域前缀(chat./lib./panel.…),ns 是归属标签不是前缀。
 *  feature 卸载 → 词条随贡献拆除,t() 回落键名 —— 诚实降级。 */
export interface LocaleContribution {
    ns: string;
    dicts: Record<string, Record<string, string>>;
}

export interface Contributions {
    'nav.rail': NavRailContribution;
    'view': ViewContribution;
    'sidebar.tree': SidebarContribution;
    'stage.form': StageFormContribution;
    'panel.type': PanelTypeContribution;
    'renderer': RendererContribution;
    'ctbar.chat': CtbarActionContribution;
    'locale': LocaleContribution;
}
