// Contribution point table — 仿 dsh ui-slots:壳不枚举 feature,
// feature 向类型化贡献点注册自己。v1 集中声明八个点;将来服务端插件
// manifest hydrate 时,新点在各 feature 文件里 declare module 合并进来,
// 不靠本文件扩枚举(槽位类型安全不变)。
import type { ComponentType } from 'react';
import type { IconName } from '../components/Icon';
import type { ViewId } from '../types';
import type { ConversationRendererComponent } from '../components/chat/renderers/types';

/** 板块类型是不透明字符串(同 dockkit:kind 不归宿主解释)。 */
export type PanelType = string;
export interface PanelInst { id: string; type: PanelType }

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
}

export interface RendererContribution {
    id: string;
    order: number;
    Component: ConversationRendererComponent;
}

/** ctbar 右侧动作位(chat 视图)。 */
export interface CtbarActionContribution {
    id: string;
    order: number;
    Component: ComponentType;
}

export interface Contributions {
    'nav.rail': NavRailContribution;
    'view': ViewContribution;
    'panel.type': PanelTypeContribution;
    'renderer': RendererContribution;
    'ctbar.chat': CtbarActionContribution;
}
