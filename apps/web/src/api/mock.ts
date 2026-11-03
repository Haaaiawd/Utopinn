// Mock data for offline development — every consumer labels it 'mock'.
// Shapes mirror the real contracts: ChatSummary (sidebar), MessageViewModel
// (conversation, protocol type), PreviewResponse (assembled prompt).
import type { MessageViewModel } from '@uberge/protocol';
import type { ChatSummary, PreviewRequestBody, PreviewResponse } from '../types';

// c1 points at the seeded dev card/chat (data/default-user: default_Seraphina
// + chats/default_Seraphina/demo-chat.jsonl) so a running server returns REAL
// assembled prompts. c2 is intentionally nonexistent → honest 404 path.
export const MOCK_CHATS: ChatSummary[] = [
    { id: 'c1', title: '山雨欲来', charDir: 'default_Seraphina', chatName: 'demo-chat', group: 'ungrouped', updatedAt: 'today', unread: true },
    { id: 'c2', title: '旧港灯塔', charDir: 'demo-card', chatName: 'lighthouse', group: 'ungrouped', updatedAt: 'yesterday' },
];

/** /api/uberge/characters 的 mock 形状(library 卡格用)。 */
export interface CardItem {
    charDir: string; name: string; avatar: string | null;
    fileName: string; fileSize: number; tags: string[]; readable: boolean;
}
export const MOCK_CARDS: CardItem[] = [
    { charDir: 'default_Seraphina', name: '归墟', avatar: null, fileName: 'default_Seraphina.png', fileSize: 512_000, tags: ['lighthouse', 'keeper'], readable: true },
    { charDir: 'demo-card', name: '旧港守灯人', avatar: null, fileName: 'demo-card.png', fileSize: 487_000, tags: [], readable: true },
    { charDir: 'corrupted-stub', name: 'corrupted-stub', avatar: null, fileName: 'corrupted-stub.json', fileSize: 12_000, tags: [], readable: false },
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

/** Dry-run assembly result shaped exactly like /api/uberge/preview. */
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
