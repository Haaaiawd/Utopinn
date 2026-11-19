/**
 * group-orchestration —— 群聊生成的编排纯逻辑层(TASK-037 阶段3)。
 * 移植自 public/scripts/group-chats.js:
 *   - generateGroupWrapper 的成员选择段(activation_strategy / force_chid /
 *     swipe-continue 的 activateSwipe / quiet 回退)
 *   - getGroupCharacterCardsLazy(APPEND/APPEND_DISABLED 联合卡字段,
 *     generation_mode_join_prefix/suffix + <FIELDNAME> 模板,逐成员 {{char}})
 *   - getGroupDepthPrompts(非 SWAP 模式多成员 depth_prompt 注入)
 *
 * 纯函数设计:不碰 express/Repo/fs。成员卡由调用方加载后以 roster 传入。
 *
 * 与 legacy 的已知差异(都标注在使用处):
 *   - legacy 的 activatedMembers 是角色下标数组;这里直接产 avatar 数组
 *     (roster 只含卡可加载的成员,等价于 legacy findIndex!==-1 的过滤结果)。
 *   - MANUAL + isUserInput 返回空 = legacy 的"只发用户楼"语义;由调用方
 *     决定是否短路生成(用户楼在服务端流程里通常已 append)。
 */

/** group_chats.js:151 group_activation_strategy */
export const GROUP_ACTIVATION_STRATEGY = Object.freeze({
    NATURAL: 0,
    LIST: 1,
    MANUAL: 2,
    POOLED: 3,
});

/** group_chats.js:158 group_generation_mode */
export const GROUP_GENERATION_MODE = Object.freeze({
    SWAP: 0,
    APPEND: 1,
    APPEND_DISABLED: 2,
});

/** script.js:1905 talkativeness_default */
export const TALKATIVENESS_DEFAULT = 0.5;
/** script.js:1906-1907 depth_prompt 缺省 */
export const DEPTH_PROMPT_DEPTH_DEFAULT = 4;
export const DEPTH_PROMPT_ROLE_DEFAULT = 'system';
/** system_message_types.NARRATOR(activateSwipe/pooled 同判据) */
const SYSTEM_MESSAGE_TYPE_NARRATOR = 'narrator';

const onlyUnique = (value, index, array) => array.indexOf(value) === index;

/** utils.js:495 shuffle(Fisher-Yates,原地) */
function shuffle(array) {
    let currentIndex = array.length;
    while (currentIndex !== 0) {
        const randomIndex = Math.floor(Math.random() * currentIndex);
        currentIndex--;
        [array[currentIndex], array[randomIndex]] = [array[randomIndex], array[currentIndex]];
    }
    return array;
}

/** utils.js:1535 extractAllWords:\b\w+\b 全局小写词表 */
function extractAllWords(value) {
    const words = [];
    if (!value) return words;
    for (const match of String(value).matchAll(/\b\w+\b/gim)) {
        words.push(match[0].toLowerCase());
    }
    return words;
}

/**
 * 成员 avatar 文件名 → 角色目录名(getCharaFilename:剥扩展名)。
 * @param {string} avatar 群 members[] 元素,形如 'Name.png'
 */
export function avatarToCharDir(avatar) {
    return String(avatar ?? '').replace(/\.[^/.]+$/, '');
}

/**
 * 群成员楼层头像 URL(force_avatar 写盘值,getThumbnailUrl('avatar', file)
 * 同形——服务端不渲染缩略图,写同款相对 URL 由客户端照常消费)。
 */
export function memberAvatarThumbnailUrl(avatar) {
    return `/thumbnail?type=avatar&file=${encodeURIComponent(String(avatar ?? ''))}`;
}

/**
 * 组 roster 条目。card 为 loadCharacterCard 产物(data.* 结构);
 * name 解析顺序 = legacy getCharacterName 等价(data.name → name)。
 */
export function buildRosterEntry(avatar, card) {
    return {
        avatar: String(avatar),
        charDir: avatarToCharDir(avatar),
        name: String(card?.data?.name ?? card?.name ?? ''),
        card: card ?? null,
    };
}

/** roster 工具:avatar → 显示名(substCtx.characterNameForAvatar 的料) */
export function memberNameForAvatar(roster, avatar) {
    return roster.find((m) => m.avatar === avatar)?.name ?? '';
}

/** roster 全部成员显示名(deps.group.botNames/getGroupNames 同形:含 disabled) */
export function groupMemberNames(roster) {
    return roster.map((m) => m.name).filter(Boolean);
}

/** script.js:6657 getCharacterTalkativeness 等价 */
function memberTalkativeness(entry) {
    const v = entry?.card?.data?.extensions?.talkativeness ?? entry?.card?.talkativeness;
    const n = Number(v);
    return Number.isNaN(n) ? TALKATIVENESS_DEFAULT : n;
}

/**
 * activateSwipe(group-chats.js:1405)——swipe/continue/quiet 的"当前发言成员"判定:
 * 以上一楼的 original_avatar/name 反解说话成员。
 * @param {string[]} members 群 members(avatar)
 * @param {Map<string,string>} nameByAvatar roster 名表
 * @param {object[]} chat 原始楼层数组
 * @param {{allowSystem?:boolean}} opts
 * @returns {string[]} avatar 列表(0-1 个,候选未命中 roster 的成员在上层过滤)
 */
function activateSwipe(members, nameByAvatar, chat, { allowSystem = false } = {}) {
    const lastMessage = chat.at(-1);
    if (!lastMessage) return [];

    const activatedNames = [];
    const skip = (m) => m.is_user || (!allowSystem && m.is_system) || m.extra?.type === SYSTEM_MESSAGE_TYPE_NARRATOR;

    if (skip(lastMessage)) {
        for (const message of chat.slice().reverse()) {
            if (skip(message)) continue;
            if (message.original_avatar) {
                activatedNames.push(message.original_avatar);
                break;
            }
        }
        if (activatedNames.length === 0) {
            activatedNames.push(shuffle(members.slice())[0]);
        }
    }

    // pre-update group chat swipe:last 无 original_avatar 时按 name 反解成员
    if (!lastMessage.original_avatar) {
        for (const avatar of members) {
            if (nameByAvatar.get(avatar) === lastMessage.name) {
                activatedNames.push(avatar);
                break;
            }
        }
    } else {
        activatedNames.push(lastMessage.original_avatar);
    }

    return activatedNames;
}

/** activateImpersonate(group-chats.js:1389):全体 members(含 disabled)随机 1 */
function activateImpersonate(members) {
    return [members[Math.floor(Math.random() * members.length)]];
}

/** activateListOrder(group-chats.js:1455):启用成员按群序全量(去重) */
function activateListOrder(members) {
    return members.filter(onlyUnique);
}

/**
 * activatePooledOrder(group-chats.js:1472):
 * 自上一用户楼起未发言的成员随机;全员发过言→随机(>1 人时排除上一楼)。
 */
function activatePooledOrder(members, chat, lastMessage, isUserInput) {
    let activatedMember = null;
    const spokenSinceUser = [];

    for (const message of chat.slice().reverse()) {
        if (message.is_user || isUserInput) break;
        if (message.is_system || message.extra?.type === SYSTEM_MESSAGE_TYPE_NARRATOR) continue;
        if (message.original_avatar) spokenSinceUser.push(message.original_avatar);
    }

    const haveNotSpoken = members.filter((x) => !spokenSinceUser.includes(x));
    if (haveNotSpoken.length) {
        activatedMember = haveNotSpoken[Math.floor(Math.random() * haveNotSpoken.length)];
    }
    if (activatedMember === null) {
        const lastMessageAvatar = members.length > 1 && lastMessage && !lastMessage.is_user && lastMessage.original_avatar;
        const randomPool = lastMessageAvatar ? members.filter((x) => x !== lastMessage.original_avatar) : members;
        activatedMember = randomPool[Math.floor(Math.random() * randomPool.length)];
    }
    return activatedMember ? [activatedMember] : [];
}

/**
 * activateNaturalOrder(group-chats.js:1517):
 * 提及命中(去 banned 上一发言者)→ 乱序 talkativeness 掷骰 → 空则
 * chatty(>0)池随机兜底,保底重试 = 池长。
 */
function activateNaturalOrder(roster, members, input, lastMessage, allowSelfResponses, isUserInput) {
    let activatedMembers = [];

    // prevents the same character from speaking twice(除非 allow_self_responses)
    let bannedUser = !isUserInput && lastMessage && !lastMessage.is_user && lastMessage.name;
    if (allowSelfResponses) bannedUser = undefined;

    const nameOf = (avatar) => roster.find((m) => m.avatar === avatar)?.name ?? '';

    // find mentions (excluding self)
    if (input && input.length) {
        for (const inputWord of extractAllWords(input)) {
            for (const member of members) {
                const character = nameOf(member);
                if (!character || character === bannedUser) continue;
                if (extractAllWords(character).includes(inputWord)) {
                    activatedMembers.push(member);
                    break;
                }
            }
        }
    }

    const chattyMembers = [];
    // activation by talkativeness (in shuffled order, except banned)
    for (const member of shuffle([...members])) {
        const character = nameOf(member);
        if (!character || character === bannedUser) continue;
        const rollValue = Math.random();
        const talkativeness = memberTalkativeness(roster.find((m) => m.avatar === member));
        if (talkativeness >= rollValue) activatedMembers.push(member);
        if (talkativeness > 0) chattyMembers.push(member);
    }

    // pick 1 at random if no one was activated(优先 talkativeness>0 池)
    let retries = 0;
    const randomPool = chattyMembers.length > 0 ? chattyMembers : members;
    while (activatedMembers.length === 0 && ++retries <= randomPool.length) {
        const randomIndex = Math.floor(Math.random() * randomPool.length);
        if (!nameOf(randomPool[randomIndex])) continue;
        activatedMembers.push(randomPool[randomIndex]);
    }

    return activatedMembers.filter(onlyUnique);
}

/**
 * generateGroupWrapper 成员选择段(group-chats.js:1277-1310)服务端等价。
 * @param {object} input
 * @param {object} input.group 群 doc(members/disabled_members/activation_strategy/allow_self_responses)
 * @param {Array<{avatar:string,name:string,card:object}>} input.roster 卡可加载成员表
 * @param {object[]} input.chat 群聊原始楼层(含 original_avatar/extra.type)
 * @param {string} input.type 生成类型(normal/regenerate/swipe/continue/impersonate/quiet)
 * @param {boolean} input.isUserInput 本次是否用户输入触发(影响 NATURAL 屏蔽与 MANUAL)
 * @param {string} input.activationText 提及扫描文本(legacy=输入框文本,服务端=触发楼 mes)
 * @param {string} [input.forceAvatar] 显式指定成员(legacy force_chid 等价)
 * @returns {{activated:string[]}} avatar 队列(顺序 = legacy activatedMembers)
 */
export function selectActivatedMembers({ group, roster, chat, type, isUserInput, activationText, forceAvatar }) {
    const members = Array.isArray(group?.members) ? group.members.map(String) : [];
    const disabledSet = new Set(Array.isArray(group?.disabled_members) ? group.disabled_members.map(String) : []);
    const enabledMembers = members.filter((x) => !disabledSet.has(x));
    const rosterAvatars = new Set(roster.map((m) => m.avatar));
    const nameByAvatar = new Map(roster.map((m) => [m.avatar, m.name]));
    const lastMessage = Array.isArray(chat) ? chat.at(-1) : null;
    const activationStrategy = Number(group?.activation_strategy ?? GROUP_ACTIVATION_STRATEGY.NATURAL);

    /** legacy 尾段:activatedNames → characters.findIndex(avatar) —— roster 存在性过滤 */
    const toRoster = (avatars) => avatars.filter((x) => x && rosterAvatars.has(x));

    let activatedMembers = [];
    if (forceAvatar) {
        activatedMembers = [String(forceAvatar)];
    } else if (type === 'quiet') {
        activatedMembers = activateSwipe(members, nameByAvatar, chat ?? [], { allowSystem: true }).slice(0, 1);
        if (activatedMembers.length === 0) {
            activatedMembers = activateListOrder(members.slice(0, 1));
        }
    } else if (type === 'swipe' || type === 'continue') {
        activatedMembers = activateSwipe(members, nameByAvatar, chat ?? [], { allowSystem: false });
        // legacy 此处 toastr.warning + throw —— 空队列由调用方按
        // 'Deleted group member swiped' 语义转 4xx。
    } else if (type === 'impersonate') {
        activatedMembers = activateImpersonate(members);
    } else if (activationStrategy === GROUP_ACTIVATION_STRATEGY.NATURAL) {
        activatedMembers = activateNaturalOrder(roster, enabledMembers, activationText, lastMessage, group?.allow_self_responses, isUserInput);
    } else if (activationStrategy === GROUP_ACTIVATION_STRATEGY.LIST) {
        activatedMembers = activateListOrder(enabledMembers);
    } else if (activationStrategy === GROUP_ACTIVATION_STRATEGY.POOLED) {
        activatedMembers = activatePooledOrder(enabledMembers, chat ?? [], lastMessage, isUserInput);
    } else if (activationStrategy === GROUP_ACTIVATION_STRATEGY.MANUAL && !isUserInput) {
        activatedMembers = shuffle(enabledMembers).slice(0, 1);
    }

    return { activated: toRoster(activatedMembers) };
}

/**
 * 成员选择所需的派生态(generateGroupWrapper:1263-1273):
 * legacy isUserInput = 输入框非空 && !byAutoMode;服务端契约是
 * 「用户楼先 append 再调 generate」,故以末楼 is_user 为等价判据。
 * @param {object[]} chatBody 群聊楼层
 * @param {boolean} automaticTrigger auto-mode 触发(body.automatic_trigger)
 */
export function deriveActivationInput(chatBody, automaticTrigger = false) {
    const last = Array.isArray(chatBody) ? chatBody.at(-1) : null;
    const isUserInput = !automaticTrigger && Boolean(last?.is_user);
    const activationText = isUserInput
        ? String(last?.mes ?? '')
        : (last && !last.is_system ? String(last?.mes ?? '') : '');
    return { isUserInput, activationText, lastMessage: last ?? null };
}

/**
 * getGroupCharacterCardsLazy(group-chats.js:573)非 lazy 版:
 * APPEND/APPEND_DISABLED 联合卡字段。SWAP(或 members 空)返回 null。
 *
 * legacy 逐成员规则:
 *   - disabled 成员跳过,除非它正是当前发言者,或模式 = APPEND_DISABLED;
 *   - 每段字段过 generation_mode_join_prefix/suffix(<FIELDNAME> 先替段名,
 *     再按"该成员名"跑宏——{{char}}=成员自己,不是发言者);
 *   - scenario/mesExamples 允许 chat_metadata.scenario/mes_example 整体覆盖
 *     (走全局宏,即 {{char}}=发言者);
 *   - mes_example 缺 <START> 头自动补。
 *
 * @param {object} input
 * @param {object} input.group 群 doc
 * @param {Array} input.roster 成员表(buildRosterEntry 产物)
 * @param {string} input.speakerAvatar 当前发言成员 avatar(=legacy characterId)
 * @param {object} input.chatMetadata 群聊 chat_metadata
 * @param {(text:string, memberName:string)=>string} input.substForMember
 *   baseChatReplace 等价物:以"成员名"为 {{char}} 跑宏;prefix/suffix/字段统一走它。
 * @param {(text:string)=>string} input.substGlobal 全局宏({{char}}=发言者),
 *   用于 chat_metadata 覆盖段。
 * @returns {{description:string,personality:string,scenario:string,mesExample:string}|null}
 */
export function buildGroupCardFields({ group, roster, speakerAvatar, chatMetadata = {}, substForMember, substGlobal }) {
    const mode = Number(group?.generation_mode ?? GROUP_GENERATION_MODE.SWAP);
    if (!group || !mode || !Array.isArray(group.members) || !group.members.length) {
        return null;
    }
    const rosterByAvatar = new Map(roster.map((m) => [m.avatar, m]));
    const disabledSet = new Set((group.disabled_members ?? []).map(String));

    const customTransform = (value, fieldName, characterName, trim) => {
        if (!value) return '';
        let v = String(value).replace(/<FIELDNAME>/gi, fieldName);
        v = trim ? v.trim() : v;
        return substForMember(v, characterName);
    };

    const replaceAndPrepareForJoin = (value, characterName, fieldName, preprocess = null) => {
        let v = value?.trim() ?? '';
        if (!v) return '';
        if (typeof preprocess === 'function') v = preprocess(v);
        const prefix = customTransform(group.generation_mode_join_prefix, fieldName, characterName, false);
        const suffix = customTransform(group.generation_mode_join_suffix, fieldName, characterName, false);
        v = customTransform(v, fieldName, characterName, true);
        return `${prefix}${v}${suffix}`;
    };

    const fieldOf = (entry, key) => String(entry?.card?.data?.[key] ?? entry?.card?.[key] ?? '');

    const collectField = (fieldName, key, preprocess = null) => {
        const values = [];
        for (const member of group.members) {
            const avatar = String(member);
            const entry = rosterByAvatar.get(avatar);
            if (!entry) continue; // characters.findIndex===-1 skip
            if (disabledSet.has(avatar) && avatar !== speakerAvatar && mode !== GROUP_GENERATION_MODE.APPEND_DISABLED) {
                continue;
            }
            values.push(replaceAndPrepareForJoin(fieldOf(entry, key), entry.name, fieldName, preprocess));
        }
        return values.filter((x) => x.length).join('\n');
    };

    const scenarioOverride = String(chatMetadata?.scenario ?? '');
    const mesExamplesOverride = String(chatMetadata?.mes_example ?? '');
    const startPreprocess = (x) => (!x.startsWith('<START>') ? `<START>\n${x}` : x);

    return {
        description: collectField('Description', 'description'),
        personality: collectField('Personality', 'personality'),
        scenario: substGlobal(scenarioOverride?.trim()) || collectField('Scenario', 'scenario'),
        mesExample: substGlobal(mesExamplesOverride?.trim()) || collectField('Example Messages', 'mes_example', startPreprocess),
    };
}

/**
 * getGroupDepthPrompts(group-chats.js:505):
 * 非 SWAP 模式收集全体成员 depth_prompt(SWAP 恒 [])。
 * 与卡字段不同:disabled 恒跳过(除发言者),APPEND_DISABLED 也不豁免。
 * @returns {{text:string,depth:number,role:string}[]}
 */
export function collectGroupDepthPrompts({ group, roster, speakerAvatar, substForMember }) {
    const mode = Number(group?.generation_mode ?? GROUP_GENERATION_MODE.SWAP);
    if (!group || !Array.isArray(group.members) || !group.members.length) {
        return [];
    }
    if (mode === GROUP_GENERATION_MODE.SWAP) {
        return [];
    }
    const rosterByAvatar = new Map(roster.map((m) => [m.avatar, m]));
    const disabledSet = new Set((group.disabled_members ?? []).map(String));
    const out = [];

    for (const member of group.members) {
        const avatar = String(member);
        const entry = rosterByAvatar.get(avatar);
        if (!entry) continue;
        if (disabledSet.has(avatar) && avatar !== speakerAvatar) continue;

        const raw = entry.card?.data?.extensions?.depth_prompt;
        const text = substForMember(String(raw?.prompt ?? '').trim(), entry.name) || '';
        if (text) {
            out.push({
                text,
                depth: Number(raw?.depth ?? DEPTH_PROMPT_DEPTH_DEFAULT),
                role: String(raw?.role ?? DEPTH_PROMPT_ROLE_DEFAULT),
            });
        }
    }
    return out;
}
