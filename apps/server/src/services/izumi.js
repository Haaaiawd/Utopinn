/**
 * services/izumi —— IzumiEdit 服务端解释器(泉此方信息库的原生实现)。
 *
 * 上游生态里这套语义由预设内嵌 TH 脚本承担(悬浮窗脚本:解析 <IzumiEdit>
 * 块 → 写信息库 → setExtensionPrompt 以 IN_CHAT depth 4 回注
 * <KonataExtraInformation>)。本文件是同一语义的服务端落地,不做黑盒脚本
 * 执行;权威语义来自预设 prompt「🌏Izumi世界系统」全文:
 *
 *   <IzumiEdit>
 *   动作 操作名
 *   <正文 / 字段>
 *   </IzumiEdit>
 *
 * 九种动作:新建/追加/前置/重写/替换/开启/关闭/删除/隐藏。
 *
 * 落点:
 *   - 写侧:ChatRepo afterWrite 观察缝(save/append/patch/createIfAbsent 的
 *     同一事务内)扫 `is_user:false` 且含 <IzumiEdit> 的楼层 → 应用到
 *     chat_state ns 'izumi'。楼层原文不动(显示剥除归预设 display 正则)。
 *   - 读侧:generate-context 把 ns 翻译成 extension_prompts 条目
 *     (IN_CHAT depth 4,role=system,scan=false),hiddenFloors 按楼层
 *     下标从 prompt 组装剔除(楼层留在存储,只不进组装)。
 *   - [[IZUMI_CHAT_INDEX_V1]] 占位符在 preset prompts 进组装前被目录文替换。
 *
 * 语义要点(与预设 prompt 对齐):
 *   - 默认作用域 = 小此信息库(聊天级);`资料/`、`预设/` 前缀分流三级。
 *   - 替换:原文非空、逐字(大小写敏感)、全文唯一一次出现,否则跳过。
 *   - 删除:给 <开头>/<结尾> 锚点 → 各唯一、按序、连同两端一起删区间;
 *     不给锚点 → 删整条(「有歧义不执行」只约束锚点模式)。
 *   - 隐藏:`隐藏 N楼~M楼` 记录楼层区间(0-based body 下标,闭区间),
 *     被隐藏楼层留在存储但从 prompt 组装剔除。
 *   - 每块一个动作;每楼层 ≤16 块,超出丢弃并记 log。
 *   - 同批新建条目的操作名同批后续 op 不可引用(目录下一批才刷新)。
 *   - 新建不覆盖同名旧条目:撞名自动加 `-N` 后缀分配唯一操作名。
 *   - `关闭 世界系统` → worldSystemClosed:停注入、停后续 op 之外的目录响应
 *     (v1:不再注入 KonataExtraInformation,op 照常记入 log)。
 *   - 预设 scope:条目照常记录(scope='预设'),但 v1 不改预设档、不进
 *     KonataExtraInformation 注入 —— op 结果标 recorded_only。
 *
 * 幂等:楼层以 `g:<extra.gen_id>` 优先、`h:<sha1(mes)>` 兜底登记 processed,
 * PATCH 重放/重试/滑动 swipe 都不会二次应用同一楼内容。
 */
import { createHash } from 'node:crypto';

/** chat_state sidecar 命名空间(与 api/panel 消费方共用此键)。 */
export const IZUMI_NS = 'izumi';
/** extension_prompts 注入键 —— 字典序决定它在 depth-4 聚合串里的位置。 */
export const IZUMI_KONATA_KEY = 'izumi_konata';
/** 预设 prompt 里的目录占位符(「可整理的条目：[[…]]」)。 */
export const IZUMI_INDEX_MARKER = '[[IZUMI_CHAT_INDEX_V1]]';
/** 每楼层操作数上限(预设原文「每次最多16项操作」)。 */
export const IZUMI_MAX_OPS_PER_FLOOR = 16;
/** KonataExtraInformation 的注入深度(TH 脚本原语义:setExtensionPrompt IN_CHAT depth 4)。 */
export const IZUMI_INJECT_DEPTH = 4;
/** 已处理楼层指纹队列上限。 */
const PROCESSED_CAP = 512;
/** 操作回执日志上限。 */
const LOG_CAP = 128;
/** 有效 scope:默认 info(小此信息库);资料/预设 为高级范围前缀。 */
const SCOPES = new Set(['info', '资料', '预设']);
/** 参与 KonataExtraInformation 正文注入的 scope(预设档 v1 只记录不注入)。 */
const INJECTED_SCOPES = new Set(['info', '资料']);
const OPEN_TAG = '<IzumiEdit>';
const CLOSE_TAG = '</IzumiEdit>';
const BLOCK_RE = /<IzumiEdit>([\s\S]*?)<\/IzumiEdit>/g;
const VERBS = new Set(['新建', '追加', '前置', '重写', '替换', '开启', '关闭', '删除', '隐藏']);
/** 「关闭 世界系统」特殊条目名 —— 预设 prompt 里的停用约定。 */
const WORLD_SYSTEM_NAME = '世界系统';

/* ----------------------------------------------------------------------- */
/* 文本工具                                                                 */
/* ----------------------------------------------------------------------- */

/** 剥一个紧贴框架标签的换行(「框架标签外侧的换行不属于正文」)。 */
function stripLeadingNewline(s) {
    if (s.startsWith('\r\n')) return s.slice(2);
    if (s.startsWith('\n') || s.startsWith('\r')) return s.slice(1);
    return s;
}
function stripTrailingNewline(s) {
    if (s.endsWith('\r\n')) return s.slice(0, -2);
    if (s.endsWith('\n') || s.endsWith('\r')) return s.slice(0, -1);
    return s;
}
/** 框架标签内侧的包裹换行各剥一层;内容本身的首尾换行(多留的行)保留。 */
function unwrapFraming(s) {
    return stripTrailingNewline(stripLeadingNewline(s));
}

/** needle 在 haystack 里的出现次数(逐字、大小写敏感)。 */
function countOccurrences(haystack, needle) {
    if (!needle) return 0;
    let n = 0, i = 0;
    while ((i = haystack.indexOf(needle, i)) !== -1) { n++; i += needle.length; }
    return n;
}

/* ----------------------------------------------------------------------- */
/* 解析                                                                     */
/* ----------------------------------------------------------------------- */

/**
 * 块内文 → op 描述。返回 {ok:true, op} | {ok:false, reason}。
 * op = { verb, target, arg, body, fields:{原文?,新文?,开头?,结尾?} }
 */
function parseBlockInner(inner) {
    // 块头行 = 内容第一行(标签外侧换行已按 framing 剥)。
    const head = stripLeadingNewline(inner);
    const nl = head.indexOf('\n');
    const headerLine = (nl === -1 ? head : head.slice(0, nl)).trim();
    const body = nl === -1 ? '' : stripTrailingNewline(head.slice(nl + 1));
    if (!headerLine) return { ok: false, reason: 'empty_header' };
    const hm = headerLine.match(/^(\S+)\s*([\s\S]*)$/);
    const verb = hm[1];
    const arg = (hm[2] ?? '').trim();
    if (!VERBS.has(verb)) return { ok: false, reason: `unknown_verb:${verb}` };

    const op = { verb, target: arg, body, fields: {} };
    if (verb === '替换' || verb === '删除') {
        for (const tag of ['原文', '新文', '开头', '结尾']) {
            const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`);
            const m = re.exec(body);
            if (m) op.fields[tag] = unwrapFraming(m[1]);
        }
    }
    if (!arg) return { ok: false, reason: 'missing_target' };
    return { ok: true, op };
}

/**
 * 楼层文本 → { ops, dropped, unclosed }。
 * dropped: 超 16 上限 / 解析失败 / 块尾未闭合(只记未解析的尾巴)。
 * unclosed: 尾部存在未闭合 <IzumiEdit>(截断的生成),不处理不留后遗症。
 */
export function parseIzumiBlocks(text) {
    const ops = [];
    const dropped = [];
    const src = String(text ?? '');
    BLOCK_RE.lastIndex = 0;
    let seen = 0;
    let match;
    while ((match = BLOCK_RE.exec(src)) !== null) {
        seen++;
        if (ops.length + dropped.length >= IZUMI_MAX_OPS_PER_FLOOR) {
            dropped.push({ reason: 'op_cap', preview: match[1].slice(0, 60) });
            continue;
        }
        const r = parseBlockInner(match[1]);
        if (r.ok) ops.push(r.op);
        else dropped.push({ reason: r.reason, preview: match[1].slice(0, 60) });
    }
    const unclosed = src.lastIndexOf(OPEN_TAG) > src.lastIndexOf(CLOSE_TAG);
    return { ops, dropped, unclosed, blockCount: seen };
}

/* ----------------------------------------------------------------------- */
/* 状态                                                                     */
/* ----------------------------------------------------------------------- */

/**
 * ns doc 规整:坏形状归位,不抛。
 * {
 *   entries: { <opName>: {name, scope, content, enabled, order} },
 *   seq: number,                       // 条目 order 自增源
 *   hiddenFloors: [{from,to}],
 *   processed: ['g:…'|'h:…', …],       // 已消费楼层指纹(旧→新)
 *   log: [{at, floor, verb, name, ok, reason?}],
 *   worldSystemClosed: boolean,
 * }
 */
export function normalizeIzumiState(raw) {
    const s = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
    const entries = {};
    if (s.entries && typeof s.entries === 'object' && !Array.isArray(s.entries)) {
        for (const [k, v] of Object.entries(s.entries)) {
            if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
            const { scope, name } = splitOpName(String(v.name ?? k));
            entries[k] = {
                name: String(v.name ?? name),
                scope: SCOPES.has(v.scope) ? v.scope : scope,
                content: String(v.content ?? ''),
                enabled: v.enabled !== false,
                order: Number.isFinite(v.order) ? v.order : 0,
            };
        }
    }
    const hiddenFloors = Array.isArray(s.hiddenFloors)
        ? s.hiddenFloors
            .filter((r) => r && Number.isFinite(Number(r.from)) && Number.isFinite(Number(r.to)))
            .map((r) => ({ from: Math.min(Number(r.from), Number(r.to)), to: Math.max(Number(r.from), Number(r.to)) }))
        : [];
    return {
        entries,
        seq: Number.isFinite(s.seq) ? s.seq : Object.keys(entries).length,
        hiddenFloors,
        processed: Array.isArray(s.processed)
            ? s.processed.filter((x) => typeof x === 'string' && x.length > 0).slice(-PROCESSED_CAP)
            : [],
        log: Array.isArray(s.log) ? s.log.slice(-LOG_CAP) : [],
        worldSystemClosed: s.worldSystemClosed === true,
    };
}

/** '资料/foo' → {scope:'资料', name:'foo'};'foo' → {scope:'info', name:'foo'}。 */
export function splitOpName(opName) {
    const m = String(opName ?? '').match(/^(资料|预设)\s*[/／]\s*(.+)$/);
    if (m) return { scope: m[1], name: m[2].trim() };
    return { scope: 'info', name: String(opName ?? '').trim() };
}
/** {scope,name} → 操作名(info 无前缀,资料/预设 带规范斜杠前缀)。 */
export function joinOpName(scope, name) {
    return scope === 'info' ? name : `${scope}/${name}`;
}

/* ----------------------------------------------------------------------- */
/* 应用                                                                     */
/* ----------------------------------------------------------------------- */

/** op.target → 规范化存储键(全角斜杠/前缀空白归一:'资料／x' ≡ '资料/x')。 */
function targetKey(op) {
    const { scope, name } = splitOpName(op.target);
    return joinOpName(scope, name);
}

function resolveEntry(state, op, pending) {
    const key = targetKey(op);
    if (pending.has(key)) return { skip: 'same_batch_ref' };
    const e = state.entries[key];
    if (!e) return { skip: 'not_found' };
    return { entry: e, key };
}

function uniqueNewName(state, scope, base) {
    let candidate = joinOpName(scope, base);
    if (!state.entries[candidate]) return candidate;
    for (let i = 1; ; i++) {
        const c = joinOpName(scope, `${base}-${i}`);
        if (!state.entries[c]) return c;
    }
}

/**
 * 单 op 应用(原地改 state;新建名进 pending 供同批拒引)。
 * @returns {{ok:boolean, reason?:string, name?:string}}
 */
function applyOne(state, op, pending) {
    const { scope, name } = splitOpName(op.target);

    // 「关闭/开启 世界系统」特殊门:停用整条 = 不再注入(条目同名的也照管)。
    if ((op.verb === '关闭' || op.verb === '开启') && scope === 'info' && name === WORLD_SYSTEM_NAME) {
        state.worldSystemClosed = op.verb === '关闭';
        const e = state.entries[targetKey(op)];
        if (e) e.enabled = op.verb === '开启';
        return { ok: true, name: op.target };
    }

    switch (op.verb) {
        case '新建': {
            if (!name) return { ok: false, reason: 'missing_name' };
            const opName = uniqueNewName(state, scope, name);
            state.entries[opName] = {
                name: splitOpName(opName).name,
                scope,
                content: op.body,
                enabled: true,
                order: state.seq++,
            };
            pending.add(opName);
            return { ok: true, name: opName };
        }
        case '追加': {
            const r = resolveEntry(state, op, pending);
            if (r.skip) return { ok: false, reason: r.skip };
            // 空追加不改变内容(预设原文),仍计 ok。
            if (op.body) r.entry.content += op.body;
            return { ok: true, name: r.key, reason: op.body ? undefined : 'empty_noop' };
        }
        case '前置': {
            const r = resolveEntry(state, op, pending);
            if (r.skip) return { ok: false, reason: r.skip };
            if (op.body) r.entry.content = op.body + r.entry.content;
            return { ok: true, name: r.key, reason: op.body ? undefined : 'empty_noop' };
        }
        case '重写': {
            const r = resolveEntry(state, op, pending);
            if (r.skip) return { ok: false, reason: r.skip };
            r.entry.content = op.body;
            return { ok: true, name: r.key };
        }
        case '替换': {
            const r = resolveEntry(state, op, pending);
            if (r.skip) return { ok: false, reason: r.skip };
            const oldText = op.fields['原文'];
            if (oldText === undefined) return { ok: false, reason: 'missing_field:原文' };
            const newText = op.fields['新文'];
            if (newText === undefined) return { ok: false, reason: 'missing_field:新文' };
            if (!oldText) return { ok: false, reason: 'empty_原文' };
            const hits = countOccurrences(r.entry.content, oldText);
            if (hits !== 1) return { ok: false, reason: hits === 0 ? '原文_not_found' : '原文_not_unique' };
            r.entry.content = r.entry.content.replace(oldText, newText);
            return { ok: true, name: r.key };
        }
        case '开启':
        case '关闭': {
            const r = resolveEntry(state, op, pending);
            if (r.skip) return { ok: false, reason: r.skip };
            r.entry.enabled = op.verb === '开启';
            return { ok: true, name: r.key };
        }
        case '删除': {
            const r = resolveEntry(state, op, pending);
            if (r.skip) return { ok: false, reason: r.skip };
            const hasAnchors = op.fields['开头'] !== undefined || op.fields['结尾'] !== undefined;
            if (!hasAnchors) {
                delete state.entries[r.key];
                return { ok: true, name: r.key };
            }
            const start = op.fields['开头'];
            const end = op.fields['结尾'];
            if (start === undefined || end === undefined) return { ok: false, reason: 'anchor_incomplete' };
            if (!start || !end) return { ok: false, reason: 'anchor_empty' };
            const content = r.entry.content;
            if (countOccurrences(content, start) !== 1) return { ok: false, reason: '开头_ambiguous' };
            if (countOccurrences(content, end) !== 1) return { ok: false, reason: '结尾_ambiguous' };
            const i0 = content.indexOf(start);
            const i1 = content.indexOf(end);
            if (i0 > i1) return { ok: false, reason: 'anchor_order' };
            r.entry.content = content.slice(0, i0) + content.slice(i1 + end.length);
            return { ok: true, name: r.key };
        }
        case '隐藏': {
            const m = op.target.match(/(\d+)\s*楼(?:\s*[~～\-至到]+\s*(\d+)\s*楼)?/);
            let range = null;
            if (m) {
                const a = Number(m[1]);
                const b = m[2] !== undefined ? Number(m[2]) : a;
                range = { from: Math.min(a, b), to: Math.max(a, b) };
            } else {
                const dm = op.target.match(/(\d+)\s*[~～\-]+\s*(\d+)/);
                if (dm) range = { from: Math.min(+dm[1], +dm[2]), to: Math.max(+dm[1], +dm[2]) };
            }
            if (!range) return { ok: false, reason: 'bad_floor_range' };
            state.hiddenFloors.push(range);
            mergeHiddenRanges(state.hiddenFloors);
            return { ok: true, name: `${range.from}楼~${range.to}楼` };
        }
        default:
            return { ok: false, reason: `unknown_verb:${op.verb}` };
    }
}

/** 相邻/重叠区间归并,hiddenFloors 不膨胀。 */
function mergeHiddenRanges(list) {
    list.sort((a, b) => a.from - b.from || a.to - b.to);
    for (let i = list.length - 1; i > 0; i--) {
        const prev = list[i - 1], cur = list[i];
        if (cur.from <= prev.to + 1) {
            prev.to = Math.max(prev.to, cur.to);
            list.splice(i, 1);
        }
    }
}

/**
 * 一批 op 应用到 state(同楼层的批次语义:新建名同批后续 op 拒引)。
 * @param {object} state normalizeIzumiState 产物(原地改)
 * @param {Array} ops parseIzumiBlocks 产物
 * @param {{floor?:number}} ctx floor = body 下标(回执日志用)
 */
export function applyIzumiOps(state, ops, { floor } = {}) {
    const pending = new Set();
    const results = [];
    for (const op of ops) {
        const r = applyOne(state, op, pending);
        results.push({ verb: op.verb, name: r.name ?? op.target, ok: r.ok, reason: r.reason });
        state.log.push({ at: Date.now(), floor, verb: op.verb, name: r.name ?? op.target, ok: r.ok, ...(r.reason ? { reason: r.reason } : {}) });
    }
    if (state.log.length > LOG_CAP) state.log = state.log.slice(-LOG_CAP);
    return results;
}

/* ----------------------------------------------------------------------- */
/* 渲染                                                                     */
/* ----------------------------------------------------------------------- */

/** 创建序条目表(order 升序)。 */
export function orderedEntries(state) {
    return Object.entries(state?.entries ?? {})
        .map(([opName, e]) => ({ opName, ...e }))
        .sort((a, b) => a.order - b.order);
}

/** [[IZUMI_CHAT_INDEX_V1]] 替换文:可整理条目目录(含关闭标记)。 */
export function renderIzumiCatalog(state) {
    const list = orderedEntries(state);
    if (!list.length) return '(无)';
    return list.map((e) => `- ${e.opName}${e.enabled ? '' : '(已关闭)'}`).join('\n');
}

/**
 * 重建 <KonataExtraInformation> 注入文:
 *   目录行(全部条目,含已关闭标记)+ enabled 的 info/资料 scope 条目正文。
 * 无可注入条目 / 世界系统已关闭 → null(整块不注入)。
 */
export function renderKonataExtraInformation(state) {
    if (!state || state.worldSystemClosed) return null;
    const list = orderedEntries(state);
    const catalog = list.map((e) => `${e.opName}${e.enabled ? '' : '(已关闭)'}`).join('、');
    const bodies = list.filter((e) => e.enabled && INJECTED_SCOPES.has(e.scope));
    if (!bodies.length) return null;
    const parts = [`<KonataExtraInformation>`];
    parts.push(`【条目目录】${catalog || '(无)'}`);
    for (const e of bodies) {
        parts.push('');
        parts.push(`《${e.opName}》`);
        parts.push(e.content);
    }
    parts.push(`</KonataExtraInformation>`);
    return parts.join('\n');
}

/** hiddenFloors → Set<body 下标>(闭区间展开,负下标钳 0)。 */
export function hiddenFloorIndexSet(state) {
    const set = new Set();
    for (const r of state?.hiddenFloors ?? []) {
        for (let i = Math.max(0, r.from); i <= r.to; i++) set.add(i);
    }
    return set;
}

/* ----------------------------------------------------------------------- */
/* 落库观察缝                                                               */
/* ----------------------------------------------------------------------- */

/** 楼层内全部 <IzumiEdit>…</IzumiEdit> 原文段(未闭合尾巴不算)。 */
function rawEditBlocks(mes) {
    const out = [];
    BLOCK_RE.lastIndex = 0;
    let m;
    while ((m = BLOCK_RE.exec(String(mes ?? ''))) !== null) out.push(m[0]);
    return out;
}

/** 楼层指纹:gen_id 优先(生成对账键,跨 PATCH 稳定);缺省 sha1(块原文)。
 *  只对编辑块取指纹 —— 楼层正文会被状态栏占位符等管线改写
 *  (实测:写后 mes 尾巴多出 <StatusPlaceHolderImpl/>),sha1(整层 mes)
 *  会漂移成新指纹 → 同一批块被二次应用、凭空造 -1 复本。
 *  已知取舍:内容完全相同的块出现在两层时后者被当重复落盘跳过
 *  (真实数据里同款重复块 = 生成重写/swipe 重放,正是要幂等吞掉的)。 */
function floorProcessedId(message) {
    const gid = message?.extra?.gen_id;
    if (typeof gid === 'string' && gid.length > 0) return `g:${gid}`;
    const blocks = rawEditBlocks(message?.mes);
    return `h:${createHash('sha1').update(blocks.join(''), 'utf8').digest('hex')}`;
}

/**
 * ChatRepo afterWrite 观察项:扫 body 里未消费的 AI 楼 <IzumiEdit> 块,
 * 解析应用进 chat_state ns 'izumi'(与楼层写同一事务 —— 解释结果与楼层
 * 原子同落,无「楼进了库、编辑丢了」的中间态)。
 * 本函数不抛:坏块/坏状态只记 log 与 console.warn,绝不连坐楼层持久化。
 *
 * @param {object} tx 引擎事务(需支持 getChatState/putChatState)
 * @param {object} key chat 资源键 {kind:'chat',handle,charDir,name,isGroup,groupId}
 * @param {Array} body 写后完整楼层数组
 * @returns {Promise<boolean>} 是否有写入
 */
export async function izumiAfterChatWrite(tx, key, body) {
    try {
        const candidates = [];
        for (let i = 0; i < (body?.length ?? 0); i++) {
            const m = body[i];
            if (!m || m.is_user) continue;
            if (!String(m.mes ?? '').includes(OPEN_TAG)) continue;
            candidates.push({ index: i, message: m, id: floorProcessedId(m) });
        }
        if (!candidates.length) return false;

        const state = normalizeIzumiState(await tx.getChatState(key, IZUMI_NS));
        const processed = new Set(state.processed);
        let dirty = false;
        for (const c of candidates) {
            if (processed.has(c.id)) continue;
            processed.add(c.id);
            state.processed.push(c.id);
            dirty = true;
            const parsed = parseIzumiBlocks(c.message.mes);
            for (const d of parsed.dropped) {
                state.log.push({ at: Date.now(), floor: c.index, verb: '?', name: d.preview ?? '', ok: false, reason: d.reason });
            }
            if (parsed.unclosed) {
                state.log.push({ at: Date.now(), floor: c.index, verb: '?', name: '', ok: false, reason: 'unclosed_block' });
            }
            applyIzumiOps(state, parsed.ops, { floor: c.index });
        }
        if (!dirty) return false;
        if (state.processed.length > PROCESSED_CAP) {
            state.processed = state.processed.slice(-PROCESSED_CAP);
        }
        if (state.log.length > LOG_CAP) state.log = state.log.slice(-LOG_CAP);
        await tx.putChatState(key, IZUMI_NS, state);
        return true;
    } catch (error) {
        // 解释器是楼层写的旁路增强:任何意外都不许让持久化失败。
        console.warn('[izumi] afterChatWrite failed (non-fatal):', error?.message ?? error);
        return false;
    }
}

/* ----------------------------------------------------------------------- */
/* API 视图                                                                 */
/* ----------------------------------------------------------------------- */

/** ns doc → 面板/API 视图(entries 数组化 + 渲染注入预览)。 */
export function izumiStateView(state) {
    const s = normalizeIzumiState(state);
    return {
        entries: orderedEntries(s).map((e) => ({
            opName: e.opName, name: e.name, scope: e.scope,
            enabled: e.enabled, order: e.order, content: e.content,
        })),
        hiddenFloors: s.hiddenFloors,
        log: s.log.slice(-64),
        worldSystemClosed: s.worldSystemClosed,
        konata: renderKonataExtraInformation(s),
        catalog: renderIzumiCatalog(s),
    };
}
