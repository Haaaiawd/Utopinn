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

/** 内置壁纸清单 —— public/assets/backgrounds/ 自家静态资产(WANTED.md 契约)。
 *  与目录图同走 settings.background 写路:name 打 'builtin:<key>' 前缀作
 *  选中态判据;url 直给前端资产路径,不经服务端目录(水合活判对 /assets/
 *  前缀放行 —— App.tsx bgAlive)。lbl 段对应 st.chatBg.wall.<key>。 */
export const BUILTIN_WALLPAPERS = [
    { key: 'appDark', file: 'app-dark.png' },
    { key: 'appLight', file: 'app-light.png' },
    { key: 'aurora', file: 'aurora-dark.png' },
    { key: 'drawer', file: 'drawer-dark.png' },
    { key: 'stage', file: 'stage-galgame.png' },
    { key: 'hall', file: 'stage-hall.jpg' },
    { key: 'starCat', file: 'star-cat.png' },
    { key: 'claudeStudy', file: 'claude-study.png' },
    { key: 'trioRoom', file: 'trio-room.png' },
    { key: 'whaleMaid', file: 'whale-maid.png' },
] as const;

/** 内置壁纸 → CSS url 值(前端静态资产,settings.background.url 落盘形)。 */
export function builtinBgCssUrl(file: string): string {
    return `url('/assets/backgrounds/${file}')`;
}
