// UI 贡献清单 —— GET /api/utopinn/ui/contrib(TASK-021 §C-12 manifest 面)。
// 服务端:apps/server/src/plugins/utopinn-plugins.js —— BUILTIN_CONTRIB(内核件
// 「谁供了这块板」归属映射)× 活插件 manifest(ui.contrib / meta.ui.contrib)
// 合并去重、wireSafe;disabled 行只回 BUILTIN 声明 + disabled 位。
// contribution 只过 JSON 载荷:Body 组件永远本地,本面是声明面元数据
// (wired/icon/desc/badge/category/title)的服务端真值源 ——
// 前端注册表对账见 features/contrib.tsx。
import { apiGet } from './client';

/** 服务端贡献条目;contribution 形状按 slot 各自解释 —— panel.type 槽对应
 *  PanelTypeContribution 的 JSON 子集(type/icon/wired/title/desc/badge/category)。 */
export interface UiContribItem {
    /** 声明它的服务端插件 id。 */
    plugin: string;
    /** 贡献槽('panel.type'/'nav.rail'/…;词表随响应 slots 带出,前端不做硬校验)。 */
    slot: string;
    contribution: Record<string, unknown>;
    /** 内核锁定件的贡献(disable 被路由侧拒);参照位,不改前端语义。 */
    core?: boolean;
    /** 声明行所属插件当前停用 —— 其 wired:true 不作数(后端面已下线)。 */
    disabled?: boolean;
}

export interface UiContribReply {
    items: UiContribItem[];
    /** 服务端已知的贡献槽词表(参照位;前端以本地 Contributions 映射为准)。 */
    slots: string[];
}

export async function listUiContrib(): Promise<UiContribReply> {
    return apiGet('/api/utopinn/ui/contrib');
}
