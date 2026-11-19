// Mock data for offline development — every consumer labels it 'mock'.
// Shapes mirror the real contracts: ChatSummary (sidebar), MessageViewModel
// (conversation, protocol type), PreviewResponse (assembled prompt).
import type { MessageViewModel } from '@utopinn/protocol';
import type { CardItem } from './characters';
import type { ChatSummary, PreviewRequestBody, PreviewResponse } from '../types';

// c1 points at the seeded dev card/chat (data/default-user: default_Seraphina
// + chats/default_Seraphina/demo-chat.jsonl) so a running server returns REAL
// assembled prompts. c2 is intentionally nonexistent → honest 404 path.
export const MOCK_CHATS: ChatSummary[] = [
    { id: 'c1', title: '山雨欲来', charDir: 'default_Seraphina', chatName: 'demo-chat', group: 'ungrouped', updatedAt: 'today', unread: true },
    { id: 'c2', title: '旧港灯塔', charDir: 'demo-card', chatName: 'lighthouse', group: 'ungrouped', updatedAt: 'yesterday' },
];

/** /api/utopinn/characters 的 mock 形状(library 卡格用);线型属 api/characters。 */
export type { CardItem };

export const MOCK_CARDS: CardItem[] = [
    { charDir: 'default_Seraphina', name: '归墟', avatar: null, fileName: 'default_Seraphina.png', fileSize: 512_000, tags: ['lighthouse', 'keeper'], readable: true },
    { charDir: 'demo-card', name: '旧港守灯人', avatar: null, fileName: 'demo-card.png', fileSize: 487_000, tags: [], readable: true },
    { charDir: 'corrupted-stub', name: 'corrupted-stub', avatar: null, fileName: 'corrupted-stub.json', fileSize: 12_000, tags: [], readable: false },
];

/** /api/utopinn/personas 的 mock 形状(设置页人设块用)。 */
export const MOCK_PERSONAS: import('./personas').PersonaItem[] = [
    { avatar: 'user-default.png', name: '旅人', description: '路过的旅人,斗篷上全是盐粒。', position: 0, title: '', hasImage: false, isDefault: true },
];

const CHAR_NAME = '归墟';
const USER_NAME = '旅人';

export const MOCK_MESSAGES: MessageViewModel[] = [
    {
        id: 0,
        role: 'assistant',
        name: CHAR_NAME,
        content: '潮水退到第三级石阶时,灯塔的灯恰好亮起来。\n\n我把最后一箱手稿搬进塔基的小屋,回头看你——你站在栈桥尽头,斗篷上全是盐粒。「你迟到了七年,」我说,声音比想象中平静,「不过海还没老。」',
        timestamp: Date.now() - 3_600_000,
        swipes: [
            {
                index: 0,
                content: '潮水退到第三级石阶时,灯塔的灯恰好亮起来。\n\n我把最后一箱手稿搬进塔基的小屋,回头看你——你站在栈桥尽头,斗篷上全是盐粒。「你迟到了七年,」我说,声音比想象中平静,「不过海还没老。」',
            },
            {
                index: 1,
                content: '灯塔亮起来的时候,整片海湾像被谁轻轻合上了一页书。\n\n我没有回头。身后栈桥上的脚步声停了——停在我等过无数个冬天的地方。「进来吧,」我说,「汤还是热的。」',
            },
        ],
        activeSwipe: 0,
        receipts: [
            { kind: 'variables', summary: 'setvar 好感度.归墟 +2 → 14', ops: [{ op: 'setvar', key: '好感度.归墟', value: 14, previous: 12 }] },
        ],
    },
    {
        id: 1,
        role: 'user',
        name: USER_NAME,
        content: '我放下湿透的斗篷,把一直攥在手里的铜钥匙放在桌上。「七年是因为这个——它开的门不在任何一张海图上。」',
        timestamp: Date.now() - 3_500_000,
    },
    {
        id: 2,
        role: 'assistant',
        name: CHAR_NAME,
        content: '钥匙在桌面上滚了半圈,停在一圈旧水渍里。\n\n那圈水渍我认识。父亲最后一次出海前,海图桌上也有同样的一圈——圆得不像话,像有人用圆规画下的警告。',
        timestamp: Date.now() - 3_400_000,
    },
];

/** Dry-run assembly result shaped exactly like /api/utopinn/preview. */
export function mockPreviewResponse(body: PreviewRequestBody): PreviewResponse {
    return {
        messages: [
            {
                role: 'system',
                name: 'main',
                content: `Write ${CHAR_NAME}'s next reply in a fictional chat. Stay in character, respond in the same language as the conversation.`,
            },
            { role: 'system', name: 'char_desc', content: `${CHAR_NAME}:守灯塔的人,七年前接手的塔。话少,记性好,把每一场风暴都记进日志。` },
            { role: 'system', name: 'world_info', content: '[World Info] 铜钥匙:传说能打开「潮下之门」的物件,进门的人会失去一段记忆作为过路费。' },
            { role: 'user', name: USER_NAME, content: '我放下湿透的斗篷,把一直攥在手里的铜钥匙放在桌上。「七年是因为这个——它开的门不在任何一张海图上。」' },
            { role: 'assistant', name: CHAR_NAME, content: '钥匙在桌面上滚了半圈,停在一圈旧水渍里。\n\n那圈水渍我认识。父亲最后一次出海前,海图桌上也有同样的一圈——圆得不像话,像有人用圆规画下的警告。' },
        ],
        trace: {
            collections: [
                { identifier: 'main', tokens: 42, count: 1 },
                { identifier: 'char_description', tokens: 68, count: 1 },
                { identifier: 'worldInfoBefore', tokens: 55, count: 1 },
                { identifier: 'chatHistory', tokens: 312, count: 2 },
            ],
            tokenBudget: 4096,
            remainingBudget: 3619,
            droppedChatCount: 0,
            injectedCount: 2,
        },
        sources: {
            presetName: body.presetName ?? 'Ubge-Default',
            model: 'mock-model',
            worldInfoActivated: 1,
            chatCount: 2,
        },
    };
}

/* =========================================================================
   规范稿目录数据 —— SPEC-DATA: 待接。
   下方目录在服务端没有对应端点(模型列表/预设库/全局世界书/插件市场/
   舞台形态会话/MVU 快照/工作台板块目录),一律落在这里;接入时整体
   换成 /api/utopinn/* 响应,消费面已在 view 里标 SPEC-DATA。
   ========================================================================= */

/** 生成模型目录项(规范稿 context capsule 的模型下拉)。 */
export interface ModelItem {
    id: string;
    name: string;
    provider: string;
    desc: string;
    context: string;
}

export const MOCK_MODELS: ModelItem[] = [
    { id: 'm-aurora', name: 'Utopinn Aurora 1', provider: '官方端点', desc: '长上下文叙事旗舰,文风细腻', context: '200K' },
    { id: 'm-scribe', name: 'Utopinn Scribe Mini', provider: '官方端点', desc: '轻量快速,适合改写与续写', context: '64K' },
    { id: 'm-claude', name: 'Claude Sonnet 4.5', provider: 'Anthropic 兼容', desc: '均衡综合推理', context: '200K' },
    { id: 'm-gpt', name: 'GPT-4o', provider: 'OpenAI 兼容', desc: '指令跟随稳定', context: '128K' },
    { id: 'm-gemini', name: 'Gemini 2.5 Pro', provider: 'Gemini 代理', desc: '长上下文叙事', context: '1M' },
    { id: 'm-local', name: '本地 Ollama · Qwen2.5', provider: '本地端点', desc: '离线可用,角色扮演微调版', context: '32K' },
];

/** 预设项(规范稿预设面板行)。 */
export interface PresetItem {
    id: string;
    name: string;
    desc: string;
    temp: number;
    source: '官方' | '用户';
    updatedAt: string;
    scene?: string;
}

export const MOCK_PRESETS: PresetItem[] = [
    { id: 'p-immersive', name: '沉浸叙事 v3', desc: '长文叙事 / 文风优先', temp: 0.9, source: '官方', updatedAt: '昨天', scene: '场景 · 文字冒险' },
    { id: 'p-writer', name: '简洁直陈', desc: '回复简短精炼,推进优先', temp: 0.4, source: '官方', updatedAt: '3 天前' },
    { id: 'p-card', name: '角色卡 · 沉浸', desc: '对话氛围优先,保留余韵', temp: 0.75, source: '用户', updatedAt: '今天' },
    { id: 'p-mm', name: '消息模式 · 日常', desc: '贴合即时通讯的节奏感', temp: 0.6, source: '用户', updatedAt: '上周' },
    { id: 'p-rpg', name: '跑团审判官', desc: '强规则约束,dice 判定', temp: 0.3, source: '用户', updatedAt: '2 周前' },
];

/** 全局世界书行(规范稿 全局世界书 块)。 */
export interface GlobalLoreItem {
    id: string;
    name: string;
    entries: number;
    enabled: boolean;
}

export const MOCK_GLOBAL_LORE: GlobalLoreItem[] = [
    { id: 'gl-base', name: '世界观基底 v2', entries: 42, enabled: true },
    { id: 'gl-forbid', name: '禁则清单', entries: 8, enabled: true },
    { id: 'gl-adv', name: '冒险增补(草稿)', entries: 17, enabled: false },
];

/** 插件市场行(规范稿 市场 tab)。 */
export interface MarketPluginItem {
    id: string;
    name: string;
    desc: string;
    author: string;
    installs: string;
    tags: string[];
    installed: boolean;
}

export const MOCK_MARKET_PLUGINS: MarketPluginItem[] = [
    { id: 'mp-regen', name: '快捷重生成', desc: '给消息加一键重生成热键与上下文菜单', author: 'utopinn-team', installs: '1.2k', tags: ['效率'], installed: true },
    { id: 'mp-map', name: '地图渲染器', desc: 'Markdown 地图语法 → 交互式地图面板', author: 'windcy', installs: '856', tags: ['可视化', '舞台'], installed: false },
    { id: 'mp-rel', name: '关系图谱', desc: '从对话中提取人物关系并可视化', author: 'lumen', installs: '420', tags: ['分析'], installed: false },
    { id: 'mp-tts', name: '语音朗读', desc: 'TTS 接入,支持角色音色', author: 'sora', installs: '2.1k', tags: ['语音'], installed: false },
    { id: 'mp-import', name: '批量导入', desc: '文件夹批量扫描 + 卡面批量入库', author: 'utopinn-team', installs: '680', tags: ['工具'], installed: true },
    { id: 'mp-chrono', name: '时间轴面板', desc: '把会话事件映射到可缩放时间轴', author: 'pale', installs: '233', tags: ['可视化'], installed: false },
];

/** 舞台形态会话行(规范稿侧栏 stage_sessions;真实会话由 API 来,
 *  这里提供缺省形态会话用于占位/离线演示)。 */
export const MOCK_STAGE_SESSIONS: ChatSummary[] = [
    { id: 'st-novel', title: '长夜卷一 · 烬城', charDir: 'demo-card', chatName: 'ember-city', group: '舞台 · 小说', updatedAt: '第 12 章', stage: 'novel' },
    { id: 'st-msg', title: '灯塔值班群', charDir: 'demo-card', chatName: 'watch-group', group: '舞台 · 消息', updatedAt: '3 条未读', unread: true, stage: 'messenger' },
    { id: 'st-gal', title: '风信子航线', charDir: 'demo-card', chatName: 'hyacinth-route', group: '舞台 · Galgame', updatedAt: '存档 2/8', stage: 'galgame' },
];

/** MVU 变量面板种子(规范稿 mvu 面板数值)。 */
export const MOCK_MVU: Record<string, string | number> = {
    '好感度': 14,
    '章节': 12,
    '当前地点': '旧港灯塔 · 塔基小屋',
    '持有物品': '铜钥匙 ×1',
    '时间': '第三天 · 夜',
};

/** 世界书(lore)板块行。 */
export const MOCK_LORE_ENTRIES = [
    { id: 'le-1', name: '铜钥匙', keys: '铜钥匙, 钥匙', content: '传说能打开「潮下之门」的物件,进门的人会失去一段记忆作为过路费。', enabled: true, scope: '全局世界书' },
    { id: 'le-2', name: '潮下之门', keys: '潮下之门, 海下', content: '旧港灯塔地基之下的一道石门,只在退潮后的第三级石阶下方显形。', enabled: true, scope: '世界观基底' },
    { id: 'le-3', name: '归墟', keys: '归墟, 守灯人', content: '守灯塔的人,七年前接手的塔。话少,记性好,把每一场风暴都记进日志。', enabled: false, scope: '角色' },
];

/** 章节(novel)板块行。 */
export const MOCK_CHAPTERS = [
    { id: 'ch-10', n: 10, title: '潮声入梦', words: 3210, active: false },
    { id: 'ch-11', n: 11, title: '钥匙与盐', words: 4022, active: false },
    { id: 'ch-12', n: 12, title: '塔基之下', words: 2114, active: true },
];

/** 频道(messenger)板块行。 */
export const MOCK_CHANNELS = [
    { id: 'ch-gen', name: '通用', desc: '值班日志与杂物', unread: 0, active: true },
    { id: 'ch-watch', name: '守灯记录', desc: '每夜灯的启熄记录', unread: 3, active: false },
    { id: 'ch-dm', name: '归墟(私聊)', desc: '', unread: 1, active: false },
];
