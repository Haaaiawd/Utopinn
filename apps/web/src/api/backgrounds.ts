// 聊天背景清单 —— GET /api/utopinn/backgrounds(utopinn-library.js;
// backgrounds/ 用户目录,ST #bg1 选图源的全局清单)。
//   写面:settings.background = {name,url,fitting} 经 PATCH /settings;
//   会话级锁定:chat_metadata.custom_background(CSS url 字符串)经
//   chats PATCH chat_metadata 合并 —— 与 legacy #bg1 优先级同序。
import { apiGet } from './client';

export interface BackgroundItem {
    filename: string;
    /** 静态面直取路径(/backgrounds/<enc>)—— 缩略图与 CSS 背景共用。 */
    url: string;
    isAnimated: boolean;
}

/** 文件名 → ST 惯例 CSS url 值(settings.background.url 落盘形,
 *  与 legacy generateUrlParameter(bg,false) 同构:leading-slash 变体)。 */
export function bgCssUrl(filename: string): string {
    return `url("/backgrounds/${encodeURIComponent(filename)}")`;
}

export function listBackgrounds(): Promise<{ items: BackgroundItem[]; total: number }> {
    return apiGet('/api/utopinn/backgrounds');
}
