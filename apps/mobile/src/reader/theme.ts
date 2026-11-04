// 阅读主题 —— design §3 定死色板。双轨深色:夜读/OLED 只在阅读器内用,
// 非阅读场景仍走 src/ui/theme 的高对比 #0d0f14(起点双轨法,不混)。
import { Platform } from 'react-native';
import type { ReaderFontKey, ReaderThemeKey } from '../state/reading';

export interface ReaderTheme {
    key: ReaderThemeKey;
    label: string;
    /** 纸面底色。 */
    bg: string;
    /** 正文墨色。 */
    ink: string;
    /** *动作* 斜体弱墨(~90%)。 */
    inkSoft: string;
    /** [*内心*] / 幕间小注 / 残稿的再弱墨。 */
    inkFaint: string;
    /** chrome 次级文字(顶栏章名、底栏按钮)。 */
    sub: string;
    /** 发丝线/分隔线。 */
    line: string;
    /** 徽标/链接/选定态。 */
    accent: string;
    /** 对话引号高亮(单色弱强度档)。 */
    quote: string;
    /** 顶/底栏底色(浮于纸面上)。 */
    chromeBg: string;
    /** 书写层/半屏卡面。 */
    cardBg: string;
    statusBar: 'light' | 'dark';
}

export const READER_THEMES: Record<ReaderThemeKey, ReaderTheme> = {
    paper: {
        key: 'paper', label: '纸白',
        bg: '#F8F6F1', ink: '#33322F', inkSoft: '#5C5B56', inkFaint: '#9B978C',
        sub: '#8B877C', line: '#DDD9CE', accent: '#8A6D3B', quote: '#8A5A24',
        chromeBg: '#F0EDE5', cardBg: '#FFFFFF', statusBar: 'dark',
    },
    parchment: {
        key: 'parchment', label: '羊皮纸',
        bg: '#FAF9DE', ink: '#3A3826', inkSoft: '#67644A', inkFaint: '#A09B78',
        sub: '#8B8660', line: '#DFDCB4', accent: '#8A6A2F', quote: '#7A5B1E',
        chromeBg: '#F1EFD0', cardBg: '#FDFCF0', statusBar: 'dark',
    },
    green: {
        key: 'green', label: '护眼绿',
        bg: '#C7EDCC', ink: '#26402E', inkSoft: '#4F6B58', inkFaint: '#87A490',
        sub: '#64826F', line: '#A9D6B0', accent: '#3E6B45', quote: '#5D6E2B',
        chromeBg: '#BBE3C1', cardBg: '#D4F2D8', statusBar: 'dark',
    },
    night: {
        key: 'night', label: '夜读',
        bg: '#414441', ink: '#D5CECD', inkSoft: '#B2ABA9', inkFaint: '#8A8682',
        sub: '#9B9692', line: '#565A56', accent: '#C9A96A', quote: '#C9A96A',
        chromeBg: '#494D49', cardBg: '#4E524E', statusBar: 'light',
    },
    oled: {
        key: 'oled', label: 'OLED黑',
        bg: '#000000', ink: '#A8A8A8', inkSoft: '#8C8C8C', inkFaint: '#5F5F5F',
        sub: '#6E6E6E', line: '#242424', accent: '#8F8468', quote: '#9A8A6A',
        chromeBg: '#0C0C0C', cardBg: '#141414', statusBar: 'light',
    },
};

export const THEME_ORDER: ReaderThemeKey[] = ['paper', 'parchment', 'green', 'night', 'oled'];

/** 字体三选 —— RN 只能用平台字体名;安卓无系统楷体,宋/楷都回退 serif(已知近似)。 */
export function readerFontFamily(fontKey: ReaderFontKey): string | undefined {
    switch (fontKey) {
        case 'songti':
            return Platform.select({ ios: 'Songti SC', android: 'serif', default: undefined });
        case 'kaiti':
            return Platform.select({ ios: 'Kaiti SC', android: 'serif', default: undefined });
        default:
            return undefined;
    }
}
