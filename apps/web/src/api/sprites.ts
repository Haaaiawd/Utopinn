// 卡资产清单 —— GET /api/utopinn/characters/:charDir/assets(TASK-044 剧场
// 三件套面;TASK-067 复用作 emotes/立绘读面)。label 抽取与 legacy
// /api/sprites/get 同正则(joy-1.png → joy),url 为静态面直取路径。
import { apiGet } from './client';

export interface SpriteAsset {
    /** 表情标签(文件名干名)。 */
    label: string;
    name: string;
    file: string;
    bytes: number;
    url: string;
    scope: 'char' | 'global';
}

export interface CharAssets {
    charDir: string;
    name: string;
    sprites: SpriteAsset[];
    backgrounds: { name: string; file: string; bytes: number; url: string; scope: string }[];
    bgm: { name: string; file: string; bytes: number; url: string; scope: string }[];
    empty: boolean;
}

export async function listCharAssets(charDir: string): Promise<CharAssets> {
    return apiGet(`/api/utopinn/characters/${encodeURIComponent(charDir)}/assets`);
}
