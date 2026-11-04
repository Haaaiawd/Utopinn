// Reader state — TypingSettings 的移动端落地(排式规格 design §3/§4):
// 字号/行距/字体/背景/对话高亮等「版式」+ 每会话阅读进度 + 排式(prose⇄bubble)。
// 全是宿主 chrome 侧状态,不进消息语义;持久化走 kv(mmkv→内存降级),
// 结构与 conversation-renderers.md 的 TypingSettings 对齐(fontSize/lineHeight/
// fontFamily 同名语义,主题/开关是移动端阅读器特化键)。
import { useSyncExternalStore } from 'react';
import { kvGet, kvSet } from './kv';

// ---------- settings ----------

export type ReaderThemeKey = 'paper' | 'parchment' | 'green' | 'night' | 'oled';
export type ReaderFontKey = 'system' | 'songti' | 'kaiti';
export type ReaderMode = 'prose' | 'bubble';

export const LINE_HEIGHT_STOPS = [1.25, 1.45, 1.65, 1.85] as const;
export const FONT_SIZE_MIN = 14;
export const FONT_SIZE_MAX = 26;

export interface ReadingSettings {
    /** 默认 18,滑块 14-26(design §3 定死)。 */
    fontSize: number;
    /** 四档预设之一,默认 1.65(舒适)。 */
    lineHeight: number;
    fontKey: ReaderFontKey;
    /** 默认纸白;夜读=低对比(design §3 深色双轨:只在阅读场景用)。 */
    theme: ReaderThemeKey;
    /** 亮度叠层 0..0.45;0 = 跟随系统(无叠层)。真实屏幕亮度留给 expo-brightness。 */
    dim: number;
    /** 左右缘 ~28% 点击翻章 —— 滚动模式默认关(design §2)。 */
    edgeTapTurn: boolean;
    /** 对话引号高亮(单色档;分人配色=v2 实验项)。 */
    quoteHighlight: boolean;
    /** user 段左缘 2px 发丝线。 */
    userMark: boolean;
    /** 页内章名:章节头一行小标题进正文流。 */
    chapterTitleInPage: boolean;
    /** 排式:prose 小说流(默认)⇄ bubble 气泡。 */
    mode: ReaderMode;
}

export const DEFAULT_READING: ReadingSettings = {
    fontSize: 18,
    lineHeight: 1.65,
    fontKey: 'system',
    theme: 'paper',
    dim: 0,
    edgeTapTurn: false,
    quoteHighlight: true,
    userMark: true,
    chapterTitleInPage: true,
    mode: 'prose',
};

// ---------- progress ----------

export interface ReadProgress {
    /** 视口顶端段落下标(扁平段落流)。 */
    para: number;
    /** 上次阅读时的楼层数 —— 书架「N 段未读」= messageCount - floors。 */
    floors: number;
    updatedAt: number;
}

type ProgressMap = Record<string, ReadProgress>;

const SETTINGS_KEY = 'reading.settings.v1';
const PROGRESS_KEY = 'reading.progress.v1';
const HINT_KEY = 'reading.chromeHint.v1';

class ReadingStore {
    private _settings: ReadingSettings;
    private _progress: ProgressMap;
    private _chromeHintSeen: boolean;
    /** 夜间快捷切换的回退主题(会话内记忆,不持久化)。 */
    private preNightTheme: ReaderThemeKey | null = null;
    private listeners = new Set<() => void>();

    constructor() {
        this._settings = { ...DEFAULT_READING, ...(kvGet<Partial<ReadingSettings>>(SETTINGS_KEY) ?? {}) };
        this._progress = kvGet<ProgressMap>(PROGRESS_KEY) ?? {};
        this._chromeHintSeen = kvGet<boolean>(HINT_KEY) === true;
    }

    get settings(): ReadingSettings {
        return this._settings;
    }
    /** Snapshot for useSyncExternalStore — new identity on every setProgress. */
    get progressMap(): ProgressMap {
        return this._progress;
    }
    get chromeHintSeen(): boolean {
        return this._chromeHintSeen;
    }

    subscribe = (fn: () => void): (() => void) => {
        this.listeners.add(fn);
        return () => {
            this.listeners.delete(fn);
        };
    };
    private emit(): void {
        for (const fn of this.listeners) fn();
    }

    patchSettings(patch: Partial<ReadingSettings>): void {
        this._settings = { ...this._settings, ...patch };
        kvSet(SETTINGS_KEY, this._settings);
        this.emit();
    }

    /** 底栏「夜间」:一键进夜读,再点回到进入前的主题。 */
    toggleNight(): void {
        if (this._settings.theme === 'night') {
            this.patchSettings({ theme: this.preNightTheme ?? 'paper' });
            this.preNightTheme = null;
        } else {
            this.preNightTheme = this._settings.theme;
            this.patchSettings({ theme: 'night' });
        }
    }

    progress(chatKey: string): ReadProgress | null {
        return this._progress[chatKey] ?? null;
    }

    setProgress(chatKey: string, para: number, floors: number): void {
        const prev = this._progress[chatKey];
        this._progress = {
            ...this._progress,
            [chatKey]: { para, floors: Math.max(floors, prev?.floors ?? 0), updatedAt: Date.now() },
        };
        // 进度 map 无界增长不划算 —— 保留最近 200 本
        const keys = Object.keys(this._progress);
        if (keys.length > 200) {
            const sorted = keys.sort((a, b) => (this._progress[b]?.updatedAt ?? 0) - (this._progress[a]?.updatedAt ?? 0));
            const keep: ProgressMap = {};
            for (const k of sorted.slice(0, 200)) keep[k] = this._progress[k]!;
            this._progress = keep;
        }
        kvSet(PROGRESS_KEY, this._progress);
        this.emit();
    }

    markChromeHintSeen(): void {
        this._chromeHintSeen = true;
        kvSet(HINT_KEY, true);
        this.emit();
    }
}

export const reading = new ReadingStore();

export function useReading(): ReadingStore {
    useSyncExternalStore(reading.subscribe, () => reading.settings, () => reading.settings);
    return reading;
}

/** 进度订阅(书架未读徽标用)—— 快照是 map 本体,仅在 setProgress 时换身份。 */
export function useProgressMap(): ProgressMap {
    return useSyncExternalStore(reading.subscribe, () => reading.progressMap, () => reading.progressMap);
}

/** 书架未读数:messageCount - 上次阅读时的楼层数(0 = 未开始/已追平)。 */
export function unreadFloors(chatKey: string, messageCount: number): number {
    const p = reading.progress(chatKey);
    if (!p) return 0;
    return Math.max(0, messageCount - p.floors);
}
