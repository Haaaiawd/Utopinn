/**
 * greeting-seed —— 开场问候播种(TASK-059)。
 *
 * 对齐上游 getFirstMessage(ref/Luker public/script.js getFirstMessage):
 * 卡 first_mes 成为新会话 body[0] 楼层,alternate_greetings 灌同楼
 * swipes 槽(swipe 组 = first_mes + 全部 alternate;first_mes 空串时按上游
 * 移位取首个 alternate 作激活版)。group_only_greetings 不进场
 * (TASK-068 群域的活)。
 *
 * 楼层字段对齐上游惯例:name=卡名 / is_user=false / is_system=false /
 * send_date=ISO。mes/swipes 经 substituteParams 全宏展开 —— 等价上游
 * messageFormatting 对 messageId===0 原地替换并把展开文写回 chat[0].mes
 * 的落盘终态;{{setvar}} 家族写入 chatMetadata.variables(与上游同
 * store),随 header 一次落盘。swipes/swipe_info 恒带(验收口径:
 * swipe 数 = 1 + alternate 数;上游无 alternate 时不写 swipe 字段,
 * 这里补单元素组以统一本仓 swipe 面契约,字段形状不变)。
 *
 * regex 不预跑:本仓「落盘保原文」模型(见 extension-prompts.js 头注)——
 * 持久/展示车道在读取面投影,与上游「落盘前 getRegexedString」终态等价。
 */
import { substituteParams } from '@utopinn/core';

/**
 * 空 system「会话头种」占位楼判定:无内容占位种子 —— 问候落位时被顶掉,
 * 不进入最终楼层序列。
 * @param {object} m 楼层
 * @returns {boolean}
 */
export function isEmptySystemSeedFloor(m) {
    return !!m && typeof m === 'object'
        && m.is_system === true
        && m.is_user === false
        && !String(m.mes ?? '').trim();
}

/**
 * {{user}}(name1)解析 —— 与 chats.js chatDisplaySubstCtx 同口径:
 * 默认人设名 → 首个人设名 → 账号 profile.name → 'User'。
 * @param {object} request express request(取 user.profile)
 * @param {object} [settingsDoc] 整份 settings 文档
 * @returns {string}
 */
export function resolveGreetingName1(request, settingsDoc) {
    const powerUser = settingsDoc?.power_user ?? {};
    const personas = (powerUser.personas && typeof powerUser.personas === 'object' && !Array.isArray(powerUser.personas))
        ? powerUser.personas
        : {};
    const defaultPersona = typeof powerUser.default_persona === 'string' ? powerUser.default_persona : '';
    return (defaultPersona && personas[defaultPersona])
        ?? Object.values(personas)[0]
        ?? request.user?.profile?.name
        ?? 'User';
}

/**
 * 构造开场问候楼(上游 getFirstMessage 同构)。
 * @param {object} args
 * @param {object} args.card 角色卡(data.* 持有字段)
 * @param {string} args.name1 {{user}} 展开值(resolveGreetingName1 产物)
 * @param {object} args.chatMetadata 新会话 chat_metadata —— setvar 家族
 *   写落点,调用方传将随 header 落盘的那份对象(活引用)。
 * @param {string} args.chatName 会话名 → currentChatId({{pick}}/{{roll}}
 *   的 chat_id_hash 种子,写回 chatMetadata 随 header 落盘)。
 * @param {object} [args.globalVariables] {{getglobalvar}} 读面;调用方应传
 *   克隆 —— setglobalvar 写进它之后被丢弃(volatile,只记 variableWrites)。
 * @param {object[]} [args.variableWrites] 变量宏写收集槽(op 日志形)。
 * @returns {object|null} 楼层对象;first_mes 与 alternate_greetings 皆空
 *   → null(诚实空,调用方保持现行为)。
 */
export function buildGreetingFloor({
    card,
    name1,
    chatMetadata = {},
    chatName = '',
    globalVariables,
    variableWrites,
}) {
    const firstMes = String(card?.data?.first_mes ?? card?.first_mes ?? '');
    const rawAlts = card?.data?.alternate_greetings ?? card?.alternate_greetings;
    const alternates = Array.isArray(rawAlts) ? rawAlts.filter((g) => typeof g === 'string') : [];
    if (!firstMes && alternates.length === 0) {
        return null;
    }

    const substCtx = {
        name1: String(name1 ?? 'User'),
        name2: String(card?.data?.name ?? card?.name ?? 'Assistant'),
        chat: [],
        chatMetadata,
        globalVariables: globalVariables ?? {},
        currentChatId: String(chatName ?? ''),
        variableWrites: Array.isArray(variableWrites) ? variableWrites : [],
    };
    const subst = (text) => substituteParams(text, substCtx);

    const now = new Date().toISOString();
    const message = {
        name: substCtx.name2,
        is_user: false,
        is_system: false,
        send_date: now,
        mes: subst(firstMes),
        extra: {},
    };

    // 上游 swipe 组形:[first_mes, ...alternate_greetings];
    // first_mes 空串 → shift 弃位,首个 alternate 顶上作激活版。
    const swipes = [message.mes, ...alternates.map((g) => subst(g))];
    if (!message.mes) {
        swipes.shift();
        message.mes = swipes[0] ?? '';
    }
    if (!message.mes) {
        return null;
    }
    message.swipe_id = 0;
    message.swipes = swipes;
    message.swipe_info = swipes.map(() => ({ send_date: now, extra: {} }));
    return message;
}

/**
 * 群聊开场问候播种(TASK-062):对齐上游 group-chats.js getGroupChat 空聊
 * 分支 + getFirstCharacterMessage —— 每个成员(含 disabled,上游不过滤)
 * 从 [first_mes, ...alternate_greetings] 随机挑一条,逐成员名跑宏
 * ({{char}}=该成员),产出带 original_avatar/force_avatar/extra.gen_id
 * 的群楼层;不建 swipe 组(上游群问候也不建)。
 * group_only_greetings 不进场 —— 上游 refs 无该字段,P2 差距项照实不播。
 *
 * @param {object} args
 * @param {Array<{avatar:string,name:string,card:object}>} args.roster
 *   成员表(group-orchestration buildRosterEntry 产物;卡缺失的成员不入列)
 * @param {string} args.name1 {{user}} 展开值(resolveGreetingName1 产物)
 * @param {object} [args.chatMetadata] 随 header 落盘的 chat_metadata
 *   ({{setvar}} 家族写落点,活引用)
 * @param {string} [args.chatName] 会话名 → currentChatId 种子
 * @param {object} [args.globalVariables] {{getglobalvar}} 读面(调用方传克隆)
 * @param {object[]} [args.variableWrites] 变量宏写收集槽
 * @returns {object[]} 问候楼层数组(无 first_mes 的成员不产生楼层)
 */
export function buildGroupGreetingFloors({
    roster,
    name1,
    chatMetadata = {},
    chatName = '',
    globalVariables,
    variableWrites,
}) {
    const floors = [];
    for (const member of Array.isArray(roster) ? roster : []) {
        const card = member?.card;
        if (!card) continue;
        const memberName = String(member.name ?? card?.data?.name ?? card?.name ?? '').trim() || 'Assistant';
        const firstMes = String(card?.data?.first_mes ?? card?.first_mes ?? '');
        const rawAlts = card?.data?.alternate_greetings ?? card?.alternate_greetings;
        const alternates = Array.isArray(rawAlts) ? rawAlts.filter((g) => typeof g === 'string') : [];
        // 上游随机位:候选池 = first_mes + alternate_greetings 全表(含空串元素
        // —— 上游不过滤空串再挑,空串挑中 = 该成员不发言,语义保留)。
        const pool = [firstMes, ...alternates];
        if (pool.length === 0) continue;
        const picked = pool[Math.floor(Math.random() * pool.length)];
        const substCtx = {
            name1: String(name1 ?? 'User'),
            name2: memberName,
            chat: [],
            chatMetadata,
            globalVariables: globalVariables ?? {},
            currentChatId: String(chatName ?? ''),
            variableWrites: Array.isArray(variableWrites) ? variableWrites : [],
        };
        const mes = substituteParams(String(picked ?? '').trim(), substCtx);
        if (!mes) continue; // 上游:无 first message → 该成员跳过
        const avatar = String(member.avatar ?? '');
        floors.push({
            name: memberName,
            is_user: false,
            is_system: false,
            send_date: new Date().toISOString(),
            mes,
            original_avatar: avatar,
            force_avatar: `/thumbnail?type=avatar&file=${encodeURIComponent(avatar)}`,
            extra: { gen_id: Date.now() * Math.random() * 1000000 },
        });
    }
    return floors;
}
