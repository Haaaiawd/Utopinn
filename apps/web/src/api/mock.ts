// Mock data for offline development — every consumer labels it 'mock'.
// Shapes mirror the real contracts: ChatSummary (sidebar), MessageViewModel
// (conversation, protocol type), PreviewResponse (assembled prompt).
import type { MessageViewModel } from '@utopinn/protocol';
import type { CardItem } from './characters';
import type { ChatSummary, PreviewRequestBody, PreviewResponse } from '../types';

// c1 points at the seeded dev card/chat (data/default-user: default_Seraphina
// + chats/default_Seraphina/demo-chat.jsonl) so a running server returns REAL
// assembled prompts. c2 is intentionally nonexistent → honest 404 path.
// pinned/defaultTabs 是规范稿 s.* 语义(pinned → 侧栏置顶区,
// defaultTabs → 选中时工作台自动开出的板块)。
export const MOCK_CHATS: ChatSummary[] = [
    { id: 'c1', title: '掌门账房线', charDir: 'default_Seraphina', chatName: 'demo-chat', group: 'ungrouped', updatedAt: '刚刚', pinned: true, defaultTabs: ['ledger'] },
    { id: 'c2', title: '旧港灯塔', charDir: 'demo-card', chatName: 'lighthouse', group: 'ungrouped', updatedAt: '昨天', pinned: true },
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
   下方目录在服务端没有对应端点(模型列表/预设库/全局世界书/作品世界书/
   插件市场/舞台形态会话/MVU 快照/工作台板块目录),一律落在这里;接入时
   整体换成 /api/utopinn/* 响应。形状逐字段对齐规范稿 MODELS / PRESETS /
   GLOBAL_LORE / WORLDBOOK / BUILTIN_PLUGINS / MARKET_PLUGINS / PROJECTS。
   ========================================================================= */

/** 生成模型目录项(规范稿 MODELS)。 */
export interface ModelItem {
    id: string;
    short: string;
    provider: string;
    ctx: string;
}

export const MOCK_MODELS: ModelItem[] = [
    { id: 'agy-gemini-3.8-flash-low', short: 'gemini-3.8-flash', provider: 'ggcli', ctx: '200k' },
    { id: 'deepseek-v4.1-chat', short: 'deepseek-v4.1', provider: 'DeepSeek', ctx: '128k' },
    { id: 'claude-4.5-sonnet', short: 'claude-4.5-sonnet', provider: 'Anthropic', ctx: '200k' },
];

/** 预设项(规范稿 PRESETS —— id 即 JSON 文件名)。 */
export interface PresetItem {
    id: string;
    temp: number;
    topP: number;
    ctxLen: number;
    maxReply: number;
}

export const MOCK_PRESETS: PresetItem[] = [
    { id: 'Meowssiah-2.1.7.json', temp: 0.85, topP: 0.92, ctxLen: 200000, maxReply: 8192 },
    { id: 'Novel-Flow-3.0.json', temp: 0.78, topP: 0.90, ctxLen: 128000, maxReply: 6144 },
    { id: 'RPG-Strict-MVU.json', temp: 0.55, topP: 0.85, ctxLen: 128000, maxReply: 4096 },
];

/** 预设提示词条目(规范稿 state.presetParams.blocks)。 */
export const MOCK_PRESET_BLOCKS = [
    { id: 'pb-1', name: '主系统提示词 (System)', enabled: true },
    { id: 'pb-2', name: '思维链引导 (<think>)', enabled: true },
    { id: 'pb-3', name: 'MVU 状态契约输出约束', enabled: true },
    { id: 'pb-4', name: '破限与防拒答规则', enabled: false },
];

/** 全局常驻 JSON 世界书(规范稿 GLOBAL_LORE)。 */
export interface GlobalLoreItem {
    id: string;
    name: string;
    file: string;
    enabled: boolean;
    tokens: number;
    desc: string;
}

export const MOCK_GLOBAL_LORE: GlobalLoreItem[] = [
    { id: 'gl-cloth', name: '服饰与材质细节描写', file: 'global-clothing.json', enabled: true, tokens: 260, desc: '强化布料纹理、磨损补丁与光影折痕' },
    { id: 'gl-anti', name: '去 AI 腔与口语节奏', file: 'global-anti-ai.json', enabled: true, tokens: 195, desc: '禁用套话,优先用短句与微动作推进' },
    { id: 'gl-animal', name: '动物神态与习性描写', file: 'global-animal.json', enabled: false, tokens: 310, desc: '通过耳廓、步态与气味反应刻画灵兽' },
    { id: 'gl-space', name: '环境留白与声响细节', file: 'global-ambience.json', enabled: false, tokens: 180, desc: '用风声、木屑、灯火明灭代替心理独白' },
];

/** 作品世界书条目(规范稿 WORLDBOOK;studio 双栏/lore 面板共用)。 */
export interface WorldbookItem {
    id: string;
    title: string;
    type: string;
    enabled: boolean;
    priority: number;
    tokens: number;
    content: string;
}

export const MOCK_WORLDBOOK: WorldbookItem[] = [
    { id: 'wb-1', title: '名物对照 | 全卡口径一本账', type: '常驻', enabled: true, priority: 147, tokens: 412, content: '全卡统一计量口径:下品灵石为日常流通货币;所有数额以 MVU 引擎快照为单一事实来源。' },
    { id: 'wb-2', title: '底层常驻 | 状态契约 | 有引擎读引擎', type: '常驻', enabled: true, priority: 131, tokens: 328, content: '挂载 Cordis MVU 引擎时仅输出结构化补丁,由服务端原子结算并推送前端 Slot。' },
    { id: 'wb-3', title: '底层常驻 | 世界总纲 | 古老修仙与成熟文明', type: '常驻', enabled: true, priority: 130, tokens: 506, content: '青州地界灵脉渐稀,云栖宗坐落偏远小峰,占有一座三阶残阵,实则早已资不抵债。' },
    { id: 'wb-4', title: '底层常驻 | 玩家与云栖宗 | 遗产不是免费的', type: '常驻', enabled: true, priority: 129, tokens: 294, content: '前任掌门留下三百灵石外债与三名记名弟子,月初百草堂执事准时上山催收利息。' },
    { id: 'wb-5', title: '关键词 | 云栖宗总簿 | 账目与大殿修缮', type: '关键词', enabled: true, priority: 122, tokens: 245, content: '大殿耐久低于 60% 时雨夜漏雨;每次修缮消耗 10 灵石可恢复 15% 耐久。' },
];

/** 内置核心插件(规范稿 BUILTIN_PLUGINS)。 */
export interface BuiltinPluginItem {
    id: string;
    name: string;
    icon: string;
    desc: string;
    color: string;
    bg: string;
    enabled: boolean;
}

export const MOCK_BUILTIN_PLUGINS: BuiltinPluginItem[] = [
    { id: 'cordis-mvu', name: 'MVU 状态引擎', icon: 'database', desc: '服务端原子化计算楼层变量补丁与快照回滚树。', color: '#34d399', bg: 'rgba(52,211,153,0.12)', enabled: true },
    { id: 'cordis-compat', name: '酒馆助手沙箱桥', icon: 'shield', desc: '隔离旧版前端卡 DOM 注入,收编为右栏或受控悬浮窗。', color: '#60a5fa', bg: 'rgba(96,165,250,0.12)', enabled: true },
    { id: 'cordis-lore-v2', name: '世界书检索 v2', icon: 'bookOpen', desc: '支持 250+ 条目毫秒级扫描与全局 JSON 栈热挂载。', color: '#c084fc', bg: 'rgba(192,132,252,0.12)', enabled: true },
    { id: 'cordis-resume', name: 'SSE 断线续传', icon: 'radio', desc: '手机切后台自动缓冲生成流,重连后无缝补齐楼层。', color: '#f59e0b', bg: 'rgba(245,158,11,0.12)', enabled: true },
];

/** 插件市场行(规范稿 MARKET_PLUGINS)。 */
export interface MarketPluginItem {
    id: string;
    name: string;
    icon: string;
    category: string;
    desc: string;
    installed: boolean;
    color: string;
    bg: string;
}

export const MOCK_MARKET_PLUGINS: MarketPluginItem[] = [
    { id: 'u-stage-novel', name: '小说体连续章节', icon: 'feather', category: 'Stage 形态', desc: '纯书排版、段落点选润色与伏笔目录面板。', installed: true, color: '#f472b6', bg: 'rgba(244,114,182,0.12)' },
    { id: 'u-stage-im', name: '微信多群聊私聊', icon: 'messages', category: 'Stage 形态', desc: '同世界观多群聊切换、未读红点与 NPC 态度卡。', installed: true, color: '#34d399', bg: 'rgba(52,211,153,0.12)' },
    { id: 'u-stage-vn', name: '剧场模式', icon: 'sparkles', category: 'Stage 形态', desc: '全屏背景、分支选项浮层与快速存读档。', installed: true, color: '#818cf8', bg: 'rgba(129,140,248,0.12)' },
    { id: 'u-panel-dice', name: 'TRPG 跑团骰子', icon: 'dice', category: '右栏面板', desc: '支持 COC/DND 检定公式并写入 MVU 变量。', installed: false, color: '#fb923c', bg: 'rgba(251,146,60,0.12)' },
    { id: 'u-panel-bgm', name: '场景 BGM 播放器', icon: 'music', category: '右栏面板', desc: '根据当前场景与情绪标签自动切换氛围音轨。', installed: false, color: '#38bdf8', bg: 'rgba(56,189,248,0.12)' },
    { id: 'u-tool-vector', name: '长篇记忆向量库', icon: 'brain', category: '实验性', desc: '针对 200+ 楼长存档自动摘要并按语义召回。', installed: false, color: '#a78bfa', bg: 'rgba(167,139,250,0.12)' },
];

/** 舞台形态会话行(规范稿 PROJECTS 里 stage!=chat 的会话)。 */
export const MOCK_STAGE_SESSIONS: ChatSummary[] = [
    { id: 'st-novel', title: '小说连载稿', charDir: 'default_Seraphina', chatName: 'ember-city', group: 'ungrouped', updatedAt: '3h', stage: 'novel', defaultTabs: ['chapters'] },
    { id: 'st-msg', title: '微信多群聊', charDir: 'default_Seraphina', chatName: 'watch-group', group: 'ungrouped', updatedAt: '1d', stage: 'messenger', defaultTabs: ['channels'] },
    { id: 'st-gal', title: '正殿夜话 (Gal)', charDir: 'default_Seraphina', chatName: 'hyacinth-route', group: 'ungrouped', updatedAt: '2d', stage: 'theater', defaultTabs: [] },
];

/** MVU 变量面板种子(规范稿 s.mvu · 掌门线)。 */
export const MOCK_MVU: Record<string, string | number> = {
    '灵石': 42,
    '宗门声望': 18,
    '大殿耐久': 65,
    '弟子': 3,
    '时辰': '辰时三刻',
};

/* ——— 舞台形态会话内容种子(规范稿 s.chapters / s.channels / s.vn) ——— */

export interface NovelPara { id: string; text: string }
export interface NovelChapter { id: string; num: string; title: string; paras: NovelPara[] }

export const MOCK_NOVEL_CHAPTERS: NovelChapter[] = [
    {
        id: 'ch1', num: '第一章', title: '缺了半边漆的山门',
        paras: [
            { id: 'p1', text: '山门牌匾上的“云栖”二字缺了半边漆,晨雾顺着漏风的檐角灌进正殿,把香案上那根掰成两半的线香吹得明灭不定。陈修裹着洗得发白的青布道袍,袖口磨出的毛边在晨光里一览无余。' },
            { id: 'p2', text: '他手里攥着前任掌门留下的青铜印信,另一只手按在边角起毛的《云栖宗总簿》上。阶下三个穿得像补丁展览会似的记名弟子正眼巴巴望着他,连呼吸都放轻了三分。' },
        ],
    },
    {
        id: 'ch2', num: '第二章', title: '四十二块灵石与漏雨的瓦',
        paras: [
            { id: 'p3', text: '青铜印信啪地一声拍在缺角的案几上,震落一小撮陈年木屑。陈修头也不抬,指腹顺着总簿泛黄的纸页往后翻,目光精准落在朱笔圈出的“月息二十”四个字上。' },
        ],
    },
];

export interface ImMsg { sender: string; self: boolean; time: string; text: string }
export interface ImChannel {
    id: string; name: string; unread: number; notice: string;
    members: { name: string; role: string; mood: string }[];
    msgs: ImMsg[];
}

export const MOCK_IM_CHANNELS: ImChannel[] = [
    {
        id: 'im-sect', name: '云栖宗内部群 (4)', unread: 0,
        notice: '本月压缩灯油与灵米开支,大殿漏雨找二师弟。',
        members: [{ name: '林砚(大师兄)', role: '管账 / 烧饭', mood: '焦虑' }],
        msgs: [
            { sender: '林砚(大师兄)', self: false, time: '08:12', text: '@掌门 刚清点完米缸,灵米只够撑五天了……' },
            { sender: '周阿牛(二师弟)', self: false, time: '08:13', text: '东头屋瓦的破木盆昨晚接了半盆雨水,我刚倒掉。' },
            { sender: 'haa', self: true, time: '08:15', text: '都别急,我先看一眼总簿,今天上午把屋瓦和米缸的事定下来。' },
        ],
    },
    {
        id: 'im-chamber', name: '青州小宗门互助群', unread: 2,
        notice: '百草堂托人潜伏,发言谨慎。',
        members: [{ name: '青风观·老李', role: '邻峰观主', mood: '吃瓜' }],
        msgs: [
            { sender: '青风观·老李', self: false, time: '07:50', text: '听说今年灵米又涨了两成,小门小派真没法活了。' },
            { sender: '落霞谷·沈娘子', self: false, time: '08:05', text: '@云栖宗掌门 你们前任掌门欠百草堂那笔账,赵老三昨天还在茶楼里念叨呢。' },
        ],
    },
    {
        id: 'im-lin', name: '林砚(私聊)', unread: 1,
        notice: '私聊窗口',
        members: [{ name: '林砚(大师兄)', role: '大师兄', mood: '谨慎' }],
        msgs: [
            { sender: '林砚(大师兄)', self: false, time: '08:16', text: '掌门,私下跟您透个底:前任师父床板底下还压着半张残缺阵图,我没敢在群里提。' },
        ],
    },
];

export interface VnChoice { text: string; op: string }
export interface VnData {
    scene: string; speaker: string; line: string;
    hideHud: boolean; choices: VnChoice[];
}

export const MOCK_VN: VnData = {
    scene: '云栖宗正殿 · 辰时三刻',
    speaker: '林砚',
    line: '“掌门,东头那三片瓦前夜被山风掀了,现在正拿破木盆接着。账房里满打满算也就四十二块灵石,您看咱们这笔钱,先紧着哪头花?”',
    hideHud: false,
    choices: [
        { text: '先拨十块灵石修好大殿屋瓦', op: 'repair' },
        { text: '先发弟子月俸稳住人心', op: 'stipend' },
        { text: '亲自下山去百草堂跟赵执事讲价', op: 'talk' },
    ],
};

export const MOCK_NOTES_TEXT = '1. 初一卯时百草堂赵执事上山催收 20 灵石月息。\n2. 林砚私聊提到床板下有半张残缺阵图。\n3. 优先保住大殿耐久不低于 60%。';

/** 规范稿 slash 指令 mock 回文(cmd-continue / cmd-regen)。 */
export const MOCK_REPLY_CONTINUE = '( /continue 续写)檐角滴落的露水砸在石阶上,啪嗒作响。林砚又翻过一页账册,指尖停在“护山残阵月耗”那一栏,眉头皱得更紧了。';
export const MOCK_REPLY_REGEN = '( /regen 重新生成)青铜印信落在缺角的案几上,发出沉闷的一声响。林砚缩回手,赔着笑把总簿推到你面前:“掌门明鉴,账房这四十二块灵石,确实是把地缝都刮干净才凑出来的。”';
export const MOCK_REPLY_NOVEL = '山风沿着青石阶卷上来,远处竹林沙沙作响。陈修合上《云栖宗总簿》,袖口磨白的粗布在晨光里划出一道利落的弧线。“既如此,便按新定下的章程办。”话音未落,山门外忽然传来一阵急促的铜铃声。';
export const MOCK_REPLY_IM = '收到掌门!我这就带二师弟把东头屋瓦补上,账目明细同步更新到总簿里。';
export const MOCK_REPLY_VN = '“原来掌门心里早有盘算!”林砚松了口气,把青铜印信擦净放回案头,“那我这就去办。”';
export const MOCK_REPLY_CHAT = '林砚连忙捧起账册记了一笔,又朝偏殿喊了一声。二师弟扛着竹梯跑出来,三师妹则从灶房端来一碗温热的清茶。\n\n“掌门放心,刚在山门石阶旁还捡到香客留下的三块碎灵石,我已经记进总簿了。”';
export const MOCK_IMPERSONATE_DRAFT = '我合上总簿靠在椅背上,抬眼看向林砚:“先别提百草堂,把前任掌门留下的那半张阵图拿出来我看看。”';
