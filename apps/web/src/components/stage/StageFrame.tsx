// StageFrame —— 舞台级共享壳(规范稿 renderCenterColumn):
//   stage-header | 离线 banner | 三弹层(ctx/slash/preset)| 形态体插槽 |
//   QR 条(仅 chat 形态)| composer-shell。
// stage.form 贡献件只渲形态内容(novel/messenger/theater/chat 楼层列),
// 帧头、输入流、生成写回、楼层操作引擎全归本帧 —— 与 ChatStage 同一份
// 数据面(postGenerate/streamJob/appendUserMessage/patchChat/mvu),
// 切形态不改协议语义;mock 路按规范稿 sendText 的 stage 分支回放
// (chat→楼层 / messenger→频道 / novel→章末段 / theater→vn.line)。
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useShell } from '../../kernel/context';
import { useI18n } from '../../i18n';
import { Icon, type IconName } from '../Icon';
import { postGenerate, streamJob } from '../../api/generate';
import { abortJob, getJob, listJobs } from '../../api/jobs';
import { getPreset } from '../../api/presets';
import { settleMvu, type MvuTarget } from '../../api/mvu';
import {
    appendAssistantMessage, appendUserMessage, floorRawText, forkChat, getChat,
    mkAssistantFloor, patchChat, patchSwipe,
    type ChatPatchOp, type FloorMsg, type GenerateBody, type GenerateVerb,
} from '../../api/chats';
import {
    appendGroupChatMessages, appendGroupUserMessage, getGroup, getGroupChat, mkGroupAssistantFloor,
    patchGroup, patchGroupChat, patchGroupSwipe, postGroupGenerate,
    GROUP_ACTIVATION_STRATEGY, GROUP_GENERATION_MODE,
    type GroupDoc, type GroupGenerateResult, type GroupPatchBody,
} from '../../api/groups';
import { ApiError, apiGet, apiPost } from '../../api/client';
import { cardData, charImageUrl, loadCharDoc, type CardDoc } from '../../api/characters';
import { listScriptCommands, type ScriptCommandInfo } from '../../api/th';
import { getSettings } from '../../api/settings';
import { wbStudioFocus } from '../../api/worlds';
import {
    getQrSet, getQrSettingsDoc, listQrSets, patchChatQrConfig, patchQrSettingsDoc,
    qrBound, qrChatConfigFromHeader, qrCharScopeKey, qrConfigWithLink, qrEnabledNames,
    qrv2WithSetVisible, qrStudioFocus,
    type QrConfig, type QrSetDoc, type QrSettings,
} from '../../api/quickreplies';
import { builtinCoverSrc, personaAvatarSrc } from '../../api/personas';
import { listCharAssets, type SpriteAsset } from '../../api/sprites';
import { downloadExport, exportChatUrl } from '../../api/export';
import { setBoundEmote, useBoundEmote } from './emotes';
import {
    buildSlashNav, loadSlashPrefs, saveSlashPrefs,
    type SlashGroupKey, type SlashNav, type SlashNavRow, type SlashPrefs,
} from './slash';

import {
    MOCK_IMPERSONATE_DRAFT, MOCK_MESSAGES, MOCK_REPLY_CHAT, MOCK_REPLY_IM,
    MOCK_REPLY_NOVEL, MOCK_REPLY_VN,
} from '../../api/mock';
import { diagTraceParams } from '../panels/DiagPanel';
import type { ChatSummary, StageKind } from '../../types';

let mockMid = 100;
const mkMock = (role: 'user' | 'assistant', content: string, streaming = false, userName = 'User'): FloorMsg => ({
    id: ++mockMid, role, name: role === 'user' ? userName : '云栖宗 · 陈修线', content, streaming, timestamp: Date.now(),
});

/** 卡头像兜底链:真图 404 → 内置卡面轮换(data-cover-key 稳定键定面)→ 终降固定卡面(black-cat)。
 *  首图即卡面也挂时跳过同 URL 重试,直落终降。 */
export const charImgFallback = (e: React.SyntheticEvent<HTMLImageElement>) => {
    const el = e.currentTarget;
    if (el.dataset.fbk === '2') return;
    const cover = builtinCoverSrc(el.dataset.coverKey ?? '');
    if (el.dataset.fbk === '1' || el.src.endsWith(cover)) {
        el.dataset.fbk = '2';
        el.src = '/assets/covers/black-cat.png';
        return;
    }
    el.dataset.fbk = '1';
    el.src = cover;
};

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const errCode = (e: unknown) => (e instanceof ApiError ? `HTTP ${e.status ?? '?'}` : 'error');

/** 会话失踪判定:HTTP 404 或 not-found 文案 —— 走空态兜底,不渲整屏错误域。 */
const isChatNotFound = (e: unknown) =>
    (e instanceof ApiError && e.status === 404) ||
    /chat[_\s-]?not[_\s-]?found|not_found|不存在/i.test(errText(e));

/** chat → mvu/state target(与 chat_state 同形;不引 panels 域件)。
 *  群会话 → {is_group,id} 群 target(mvu-settle.js 群映射,服务端已备)。 */
const mvuTarget = (chat: ChatSummary | null): MvuTarget | null =>
    chat?.groupId
        ? (chat.chatName ? { is_group: true, id: chat.chatName } : null)
        : chat?.charDir && chat?.chatName ? { avatar_url: `${chat.charDir}.png`, file_name: `${chat.chatName}.jsonl` } : null;

/* ——— 楼层操作回调包 ——— */
export interface FloorOps {
    isLast: boolean;
    editing: { id: number; text: string } | null;
    onSwipe: (m: FloorMsg, dir: -1 | 1) => void;
    onCopy: (m: FloorMsg) => void;
    /** 楼层「引用」:该楼文本作 markdown 引用块塞入 composer 草稿,
     *  供「改这段」类指令;占位级 —— composer 无插入通道时直写 draft。 */
    onQuote: (m: FloorMsg) => void;
    onEdit: (m: FloorMsg) => void;
    onEditText: (text: string) => void;
    onSaveEdit: (m: FloorMsg) => void;
    onCancelEdit: () => void;
    onDelete: (m: FloorMsg) => void;
    onRewind: (m: FloorMsg) => void;
    onRetry: (m: FloorMsg) => void;
    onTrace: (m: FloorMsg) => void;
    onContinue: () => void;
    /** 绝对 swipe 跳转(theater 分支选项等按 index 直跳,不再逐版翻页)。 */
    onSwipeTo: (m: FloorMsg, index: number) => void;
    /** 新建分支:从该楼直接岔出新会话(整楼 swipe 组随拷贝,原会话不动)。 */
    onForkFloor: (m: FloorMsg) => void;
}

/** 帧内引擎:形态体(楼层列等)经本接口读楼层/操作;composer 在帧内自耗。 */
export interface StageEngine {
    msgs: FloorMsg[];
    loadErr: string | null;
    opsOf: (m: FloorMsg, idx: number) => FloorOps;
    reload: () => Promise<void>;
    /** 形态内按钮的用户文本入口(选项/指令 = 等效 composer 发送)。 */
    send: (text: string) => void;
    /** 形态级「推进」:不追 user 楼、直接 normal 生成下一拍
     *  (VN ▸;区别于 onContinue —— 那是把半截楼续完)。 */
    advance: () => void;
    /** 「跳回该层」请求:floor = body 楼号;seq 让重复点同楼也重触发。
     *  (保留引擎口 —— 楼层定位是通用能力,书签面板下线后仍可用)。 */
    jump: { floor: number; seq: number } | null;
    requestJump: (floor: number) => void;
}

const EngineCtx = createContext<StageEngine | null>(null);

/** 形态体取引擎 —— 必须在 <StageFrame> 内调用。 */
export function useStageEngine(): StageEngine {
    const e = useContext(EngineCtx);
    if (!e) throw new Error('useStageEngine must be used inside <StageFrame>');
    return e;
}

/* ——— 规范稿 ctbar 三弹层 ——— */


/** 会话信息弹层:点标题钮开 —— 会话名编辑(renameChat 写面)+ 元信息
 *  + 上下文栈(当前预设/全局书栈/卡绑·内嵌·会话绑书,全部可跳进 studio)。
 *  这就是原来 ContextPop 的「世界书与上下文栈」该有的样子:不是读数,
 *  是入口 —— 每行都能落点。 */
function ChatInfoPop({ chatBound, charDoc, onClose, slashOn, onToggleSlash }: {
    chatBound: string[]; charDoc: CardDoc | null; onClose: () => void;
    slashOn: boolean; onToggleSlash: () => void;
}) {
    const { t } = useI18n();
    const s = useShell();
    const eng = useStageEngine();
    const chat = s.chat;
    const [nameVal, setNameVal] = useState(chat?.title ?? '');
    const dirty = nameVal.trim() !== '' && nameVal.trim() !== chat?.chatName;
    const commit = () => {
        if (!chat || !dirty) return;
        s.renameChat(chat, nameVal.trim());
        onClose();
    };
    const cardName = chat?.charDir ? (s.cards.get(chat.charDir)?.name ?? chat.charDir) : null;
    const floors = eng.msgs.filter((m) => m.id >= 0).length;
    /* 全局书栈 + 激活预设:settings 一次性拉(弹层瞬态,不走 useRemote 缓存
       —— 每次开读真值,关闭即弃)。 */
    const [ctx, setCtx] = useState<{ globalBooks: string[] } | null>(null);
    useEffect(() => {
        let dead = false;
        getSettings().then((r) => {
            if (dead) return;
            const wi = (r.settings?.world_info_settings as Record<string, unknown> | undefined)?.world_info as
                Record<string, unknown> | undefined;
            setCtx({ globalBooks: Array.isArray(wi?.globalSelect) ? wi!.globalSelect.filter((x): x is string => typeof x === 'string' && !!x) : [] });
        }).catch(() => { if (!dead) setCtx({ globalBooks: [] }); });
        return () => { dead = true; };
    }, []);
    /* 卡侧两本:主绑 extensions.world + 内嵌 character_book 条目数。 */
    const data = cardData(charDoc);
    const cardBound = typeof data?.extensions?.world === 'string' && data.extensions.world ? data.extensions.world : null;
    const book = data?.character_book as { entries?: unknown } | null | undefined;
    const embEntries = book?.entries ? (Array.isArray(book.entries) ? book.entries.length : Object.keys(book.entries).length) : 0;
    const presetName = s.activePresetId ? s.activePresetId.replace(/\.json$/i, '') : null;
    const goStudio = (nav: string, book?: string) => {
        if (book) wbStudioFocus.set = book;
        s.setStudioNav(nav); s.setView('studio'); onClose();
    };
    const bookChip = (name: string) => (
        <button
            key={name}
            type="button"
            className="max-w-full truncate rounded-full border border-[color:var(--border-hairline)] bg-[color:var(--bg-surface)] px-2 py-0.5 text-[11px] text-[color:var(--fg-secondary)] transition-colors hover:bg-[color:var(--bg-active)] hover:text-[color:var(--fg-primary)]"
            onClick={() => goStudio('worldbook', name)}
        >
            {name}
        </button>
    );
    const hasCtx = presetName || (ctx?.globalBooks.length ?? 0) > 0 || cardBound || chatBound.length > 0 || embEntries > 0;
    return (
        <div className="absolute inset-0 z-40" style={{ background: 'rgba(0,0,0,0.34)' }} onClick={onClose}>
            <div
                className="pop-in absolute left-3 right-3 top-12 max-h-[calc(100%-64px)] space-y-3 overflow-y-auto rounded-2xl p-4 sm:left-4 sm:right-auto sm:w-[340px]"
                style={{ background: 'var(--bg-elevated)', boxShadow: 'var(--shadow-pop)' }}
                onClick={(e) => e.stopPropagation()}
            >
                <div className="flex items-center justify-between">
                    <span className="heading-tight text-[13px] font-semibold text-[color:var(--fg-primary)]">{t('chat.info')}</span>
                    <button className="ghost-btn h-7 w-7" onClick={onClose}><Icon name="x" size={15} /></button>
                </div>
                <div className="flex items-center gap-1.5">
                    <input
                        autoFocus
                        value={nameVal}
                        onChange={(e) => setNameVal(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') commit(); else if (e.key === 'Escape') onClose(); }}
                        className="h-8 min-w-0 flex-1 rounded-lg border border-[color:var(--border-hairline)] bg-[color:var(--bg-surface)] px-2.5 text-[12.5px] text-[color:var(--fg-primary)] outline-none"
                    />
                    <button
                        className="h-8 shrink-0 rounded-lg px-3 text-[12px] font-medium transition-opacity"
                        style={dirty ? { background: 'var(--primary-bg)', color: 'var(--primary-fg)' } : { background: 'var(--bg-active)', color: 'var(--fg-muted)' }}
                        disabled={!dirty}
                        onClick={commit}
                    >
                        {t('chat.rename')}
                    </button>
                </div>
                <div className="inset-group">
                    <div className="inset-row">
                        <span className="text-[12px] text-[color:var(--fg-muted)]">{t('chat.info.card')}</span>
                        <span className="truncate text-[12px] text-[color:var(--fg-primary)]">{cardName ?? '—'}</span>
                    </div>
                    <div className="inset-row">
                        <span className="text-[12px] text-[color:var(--fg-muted)]">{t('chat.info.floors')}</span>
                        <span className="font-mono-ui text-[12px] text-[color:var(--fg-primary)]">{floors}</span>
                    </div>
                    <div className="inset-row">
                        <span className="text-[12px] text-[color:var(--fg-muted)]">{t('chat.info.file')}</span>
                        <span className="truncate font-mono-ui text-[11px] text-[color:var(--fg-secondary)]">{chat?.chatName ?? '—'}.jsonl</span>
                    </div>
                </div>
                {hasCtx && (
                    <div className="inset-group">
                        <div className="px-2.5 pt-2 text-[10.5px] font-medium uppercase tracking-wide text-[color:var(--fg-faint)]">{t('chat.info.context')}</div>
                        {presetName && (
                            <button type="button" className="inset-row inset-row-btn" onClick={() => goStudio('presets')} title={t('chat.info.preset.go')}>
                                <span className="text-[12px] text-[color:var(--fg-muted)]">{t('chat.info.preset')}</span>
                                <span className="truncate text-[12px] text-[color:var(--fg-primary)]">{presetName}</span>
                                <Icon name="chevronRight" size={12} />
                            </button>
                        )}
                        <div className="inset-row flex-wrap items-start">
                            <span className="text-[12px] text-[color:var(--fg-muted)]">{t('chat.info.globalBooks')}</span>
                            {ctx === null ? (
                                <span className="text-[12px] text-[color:var(--fg-faint)]">…</span>
                            ) : ctx.globalBooks.length ? (
                                <span className="flex min-w-0 flex-1 flex-wrap justify-end gap-1">{ctx.globalBooks.map(bookChip)}</span>
                            ) : (
                                <span className="text-[12px] text-[color:var(--fg-faint)]">{t('chat.info.none')}</span>
                            )}
                        </div>
                        {cardBound && (
                            <div className="inset-row flex-wrap items-start">
                                <span className="text-[12px] text-[color:var(--fg-muted)]">{t('chat.info.cardBound')}</span>
                                <span className="flex min-w-0 flex-1 flex-wrap justify-end gap-1">{bookChip(cardBound)}</span>
                            </div>
                        )}
                        {embEntries > 0 && (
                            <button type="button" className="inset-row inset-row-btn" onClick={() => cardBound && goStudio('worldbook', cardBound)} disabled={!cardBound}>
                                <span className="text-[12px] text-[color:var(--fg-muted)]">{t('chat.info.embedded')}</span>
                                <span className="text-[12px] text-[color:var(--fg-primary)]">{embEntries} {t('chat.info.entries')}</span>
                                {cardBound && <Icon name="chevronRight" size={12} />}
                            </button>
                        )}
                        {chatBound.length > 0 && (
                            <div className="inset-row flex-wrap items-start">
                                <span className="text-[12px] text-[color:var(--fg-muted)]">{t('chat.info.chatBound')}</span>
                                <span className="flex min-w-0 flex-1 flex-wrap justify-end gap-1">{chatBound.map(bookChip)}</span>
                            </div>
                        )}
                    </div>
                )}
                {/* 环境斜杠体验总闸(与斜杠菜单 footer 同一个 utopinn.slash.enabled 槽):
                    关掉 → 打 / 不弹菜单、/text 按普通文本发送;菜单仍可由 / 钮显式打开。 */}
                <div className="inset-group">
                    <div className="inset-row">
                        <span className="text-[12px] text-[color:var(--fg-muted)]">{t('slash.enabled')}</span>
                        <button
                            type="button"
                            className="sh-switch"
                            data-checked={slashOn}
                            title={t('slash.enabled.tip')}
                            onClick={onToggleSlash}
                        >
                            <span className="sh-switch-thumb" />
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}

/** 舞台头 persona 快切弹层(TASK-026):暗幕 + top-12 左锚卡,人设列 =
 *  GET /api/utopinn/personas 目录;选择经 s.setPersona 落本会话 localStorage
 *  槽(per-chat 语义),生成时以 body.user 携带 —— 服务端无 per-chat 写回端点,
 *  这里照实只做选择态+携带,不伪造写回面。 */
function PersonaPop({ onClose }: { onClose: () => void }) {
    const { t } = useI18n();
    const s = useShell();
    return (
        <div className="absolute inset-0 z-40" style={{ background: 'rgba(0,0,0,0.34)' }} onClick={onClose}>
            <div
                className="pop-in absolute left-3 right-3 top-12 space-y-2.5 rounded-2xl p-3.5 sm:left-4 sm:right-auto sm:w-[290px]"
                style={{ background: 'var(--bg-elevated)', boxShadow: 'var(--shadow-pop)' }}
                onClick={(e) => e.stopPropagation()}
            >
                <div className="flex items-center justify-between px-0.5">
                    <span className="text-[11px] font-medium text-[color:var(--fg-muted)]">{t('ctx.persona')}</span>
                    <button
                        className="text-[11px] text-[color:var(--fg-muted)] transition-colors hover:text-[color:var(--fg-primary)]"
                        onClick={() => { onClose(); s.setView('studio'); s.setStudioNav('persona'); }}
                    >
                        {t('tree.manage')}
                    </button>
                </div>
                {s.personas.length > 0 ? (
                    <div className="inset-group max-h-64 overflow-y-auto">
                        {s.personas.map((p) => {
                            const act = s.persona?.avatar === p.avatar;
                            return (
                                <button
                                    key={p.avatar}
                                    type="button"
                                    className="inset-row inset-row-btn w-full"
                                    onClick={() => { s.setPersona({ avatar: p.avatar, name: p.name, description: p.description }); onClose(); }}
                                >
                                    <span className="flex min-w-0 items-center gap-2.5">
                                        <img
                                            src={personaAvatarSrc(p.avatar, p.hasImage)}
                                            alt=""
                                            className="h-6 w-6 shrink-0 rounded-full object-cover"
                                            onError={(e) => { e.currentTarget.src = '/assets/avatars/user-redpanda.png'; }}
                                        />
                                        <span className="min-w-0">
                                            <span className="block truncate text-[12.5px] text-[color:var(--fg-primary)]">
                                                {p.name || p.avatar}
                                                {p.isDefault && <span className="ml-1.5 font-mono-ui text-[10px] text-[color:var(--fg-faint)]">{t('studio.persona.default')}</span>}
                                            </span>
                                            {p.title && <span className="block truncate text-[10.5px] text-[color:var(--fg-muted)]">{p.title}</span>}
                                        </span>
                                    </span>
                                    {act && <Icon name="check" size={14} className="shrink-0 text-[color:var(--brand)]" />}
                                </button>
                            );
                        })}
                    </div>
                ) : (
                    <div className="rounded-xl border border-[color:var(--border-hairline)] bg-[color:var(--bg-surface)] px-3 py-2.5 text-[11.5px] text-[color:var(--fg-muted)]">
                        {t('studio.persona.empty')}
                    </div>
                )}
            </div>
        </div>
    );
}

/** 立绘/表情面(TASK-067):暗幕 + top-12 左锚卡,格列 =
 *  GET /api/utopinn/characters/:charDir/assets 的 sprites[]。
 *  点格 = 绑定本会话立绘(localStorage 槽,楼层头像+本 chip 生效);
 *  「默认」= 解绑回落卡头像。只做绑定+展示 —— ST 自动表情分类器不在本刀。 */
function EmotesPop({ onClose }: { onClose: () => void }) {
    const { t } = useI18n();
    const s = useShell();
    const charDir = s.chat?.charDir;
    const bound = useBoundEmote(s.chat?.id);
    const [sprites, setSprites] = useState<SpriteAsset[] | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    useEffect(() => {
        /* 无会话/群会话(charDir 空)/离线 → 空面如实,不挂转圈。 */
        if (!s.live || !charDir) { setSprites([]); return; }
        let dead = false;
        listCharAssets(charDir)
            .then((a) => { if (!dead) { setSprites(a.sprites); setLoadError(null); } })
            .catch((e) => { if (!dead) { setSprites([]); setLoadError(e instanceof Error ? e.message : String(e)); } });
        return () => { dead = true; };
    }, [s.live, charDir]);
    return (
        <div className="absolute inset-0 z-40" style={{ background: 'rgba(0,0,0,0.34)' }} onClick={onClose}>
            <div
                className="pop-in absolute left-3 right-3 top-12 space-y-2.5 rounded-2xl p-3.5 sm:left-4 sm:right-auto sm:w-[330px]"
                style={{ background: 'var(--bg-elevated)', boxShadow: 'var(--shadow-pop)' }}
                onClick={(e) => e.stopPropagation()}
            >
                <div className="flex items-center justify-between px-0.5">
                    <span className="text-[11px] font-medium text-[color:var(--fg-muted)]">{t('stage.emotes.title')}</span>
                    {bound && (
                        <button
                            className="text-[11px] text-[color:var(--fg-muted)] transition-colors hover:text-[color:var(--fg-primary)]"
                            onClick={() => setBoundEmote(s.chat?.id, null)}
                        >
                            {t('stage.emotes.unbind')}
                        </button>
                    )}
                </div>
                {loadError ? (
                    <div className="rounded-xl border border-[color:var(--border-hairline)] bg-[color:var(--bg-surface)] px-3 py-2.5 font-mono-ui text-[10.5px]" style={{ color: 'var(--status-danger)' }}>
                        {loadError}
                    </div>
                ) : sprites === null ? (
                    <div className="px-3 py-2.5 text-[11.5px] text-[color:var(--fg-faint)]">…</div>
                ) : sprites.length > 0 ? (
                    <div className="grid max-h-64 grid-cols-4 gap-1.5 overflow-y-auto">
                        {sprites.map((sp) => {
                            const act = bound?.file === sp.file;
                            return (
                                <button
                                    key={sp.file}
                                    type="button"
                                    title={sp.label}
                                    className="group/sp relative aspect-square overflow-hidden rounded-lg transition-transform active:scale-95"
                                    style={{
                                        background: 'var(--bg-surface)',
                                        border: act ? '1.5px solid var(--brand)' : '1px solid var(--border-hairline)',
                                    }}
                                    onClick={() => { setBoundEmote(s.chat?.id, { file: sp.file, label: sp.label, url: sp.url }); onClose(); }}
                                >
                                    <img src={sp.url} alt={sp.label} className="h-full w-full object-cover" />
                                    <span className="absolute inset-x-0 bottom-0 truncate bg-black/55 px-1 py-0.5 text-center text-[9px] text-white/90">{sp.label}</span>
                                    {act && <span className="absolute right-0.5 top-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full" style={{ background: 'var(--brand)' }}><Icon name="check" size={10} className="text-white" /></span>}
                                </button>
                            );
                        })}
                    </div>
                ) : (
                    <div className="rounded-xl border border-[color:var(--border-hairline)] bg-[color:var(--bg-surface)] px-3 py-2.5 text-[11.5px] text-[color:var(--fg-muted)]">
                        {t('stage.emotes.empty')}
                    </div>
                )}
            </div>
        </div>
    );
}


/** 群名册弹层(TASK-062):roster 行(头像/名/禁停开关/点名发言)+
 *  编排设置(激活策略/生成模式/自应答/合并前后缀)—— 全经 PATCH
 *  /groups/:gid 落服务端文档;选员算法仍只在服务端,本层不挑顺序。
 *  点名发言:member 强指(禁用成员也可点 —— 强指高于禁停,与
 *  服务端 orchestration.forceMember 语义一致);未接编排时服务
 *  端 4xx/空激活照实回报,弹层不造成功态。 */
function GroupPop({ doc, busy, onSpeak, onPatch, onClose }: {
    doc: GroupDoc | null;
    busy: boolean;
    onSpeak: (memberAvatar: string) => void;
    onPatch: (patch: GroupPatchBody) => void;
    onClose: () => void;
}) {
    const { t } = useI18n();
    const roster = doc?.roster ?? [];
    const disabled = new Set(doc?.disabled_members ?? []);
    const selCls = 'sh-select-trigger w-full justify-between';
    return (
        <div className="absolute inset-0 z-40" style={{ background: 'rgba(0,0,0,0.34)' }} onClick={onClose}>
            <div
                className="pop-in absolute left-3 right-3 top-12 flex max-h-[70vh] flex-col rounded-2xl sm:left-4 sm:right-auto sm:w-[380px]"
                style={{ background: 'var(--bg-elevated)', boxShadow: 'var(--shadow-pop)' }}
                onClick={(e) => e.stopPropagation()}
            >
                <div className="flex h-11 shrink-0 items-center justify-between border-b border-[color:var(--border-hairline)] px-4">
                    <span className="heading-tight truncate text-[13.5px] font-medium text-[color:var(--fg-primary)]">
                        {doc?.name ?? t('group.roster')}
                    </span>
                    <button className="ghost-btn h-7 w-7" onClick={onClose}><Icon name="x" size={15} /></button>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto p-2">
                    {!doc && (
                        <div className="px-2.5 py-4 text-[11.5px] leading-relaxed text-[color:var(--fg-muted)]">{t('group.doc.missing')}</div>
                    )}
                    {/* 名册:禁用行降透明 + 开关;卡缺失照实灰名(服务端会跳过,
                        点名也不会出活 —— force 钮照常给,让服务端回执说话)。 */}
                    {roster.map((m) => (
                        <div key={m.avatar} className="flex items-center gap-2 rounded-xl px-2.5 py-2 transition-colors hover:bg-[color:var(--bg-surface)]" style={!m.loadable ? { opacity: 0.5 } : undefined}>
                            <img
                                src={charImageUrl(m.avatar)}
                                alt=""
                                className="h-7 w-7 shrink-0 rounded-full object-cover"
                                onError={charImgFallback}
                            />
                            <div className="min-w-0 flex-1">
                                <div className="truncate text-[12.5px] font-medium text-[color:var(--fg-primary)]">{m.name}</div>
                                <div className="font-mono-ui text-[10.5px] text-[color:var(--fg-faint)]">
                                    {!m.loadable ? t('group.member.missing') : m.disabled ? t('group.member.muted') : ''}
                                </div>
                            </div>
                            <button
                                className="ghost-btn h-7 w-7"
                                title={t('group.member.speak')}
                                disabled={busy}
                                onClick={() => onSpeak(m.avatar)}
                            >
                                <Icon name="play" size={13} />
                            </button>
                            <button
                                className="ghost-btn h-7 w-7"
                                title={m.disabled ? t('group.member.unmute') : t('group.member.mute')}
                                style={disabled.has(m.avatar) ? { color: 'var(--status-danger)' } : undefined}
                                onClick={() => {
                                    const next = disabled.has(m.avatar)
                                        ? [...disabled].filter((a) => a !== m.avatar)
                                        : [...disabled, m.avatar];
                                    onPatch({ disabled_members: next });
                                }}
                            >
                                <Icon name={m.disabled ? 'speakerSlash' : 'speakerHigh'} size={14} />
                            </button>
                        </div>
                    ))}
                    {doc && (
                        <div className="mt-1 space-y-2 border-t border-[color:var(--border-hairline)] px-2.5 py-3">
                            <label className="block">
                                <span className="mb-1 block text-[10.5px] uppercase tracking-wide text-[color:var(--fg-faint)]">{t('group.strategy')}</span>
                                <select
                                    className={selCls}
                                    value={doc.activation_strategy ?? GROUP_ACTIVATION_STRATEGY.NATURAL}
                                    onChange={(e) => onPatch({ activation_strategy: Number(e.target.value) })}
                                >
                                    <option value={GROUP_ACTIVATION_STRATEGY.NATURAL}>{t('group.strategy.natural')}</option>
                                    <option value={GROUP_ACTIVATION_STRATEGY.LIST}>{t('group.strategy.list')}</option>
                                    <option value={GROUP_ACTIVATION_STRATEGY.MANUAL}>{t('group.strategy.manual')}</option>
                                    <option value={GROUP_ACTIVATION_STRATEGY.POOLED}>{t('group.strategy.pooled')}</option>
                                </select>
                            </label>
                            <label className="block">
                                <span className="mb-1 block text-[10.5px] uppercase tracking-wide text-[color:var(--fg-faint)]">{t('group.mode')}</span>
                                <select
                                    className={selCls}
                                    value={doc.generation_mode ?? GROUP_GENERATION_MODE.SWAP}
                                    onChange={(e) => onPatch({ generation_mode: Number(e.target.value) })}
                                >
                                    <option value={GROUP_GENERATION_MODE.SWAP}>{t('group.mode.swap')}</option>
                                    <option value={GROUP_GENERATION_MODE.APPEND}>{t('group.mode.append')}</option>
                                    <option value={GROUP_GENERATION_MODE.APPEND_DISABLED}>{t('group.mode.appendDisabled')}</option>
                                </select>
                            </label>
                            <label className="flex items-center justify-between gap-2">
                                <span className="text-[12px] text-[color:var(--fg-secondary)]">{t('group.allowSelf')}</span>
                                <button
                                    type="button"
                                    className="sh-switch"
                                    data-checked={doc.allow_self_responses !== false || undefined}
                                    onClick={() => onPatch({ allow_self_responses: doc.allow_self_responses === false })}
                                />
                            </label>
                            <div className="grid grid-cols-2 gap-2">
                                <label className="block">
                                    <span className="mb-1 block text-[10.5px] uppercase tracking-wide text-[color:var(--fg-faint)]">{t('group.joinPrefix')}</span>
                                    <input
                                        className="sh-input w-full"
                                        defaultValue={doc.generation_mode_join_prefix ?? ''}
                                        onBlur={(e) => onPatch({ generation_mode_join_prefix: e.target.value })}
                                    />
                                </label>
                                <label className="block">
                                    <span className="mb-1 block text-[10.5px] uppercase tracking-wide text-[color:var(--fg-faint)]">{t('group.joinSuffix')}</span>
                                    <input
                                        className="sh-input w-full"
                                        defaultValue={doc.generation_mode_join_suffix ?? ''}
                                        onBlur={(e) => onPatch({ generation_mode_join_suffix: e.target.value })}
                                    />
                                </label>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}

/** 规范稿斜杠菜单 L1100-1117 + TASK-060 命令补全层(v2 分组/chip/总闸):
 *  上段 = 5 项壳内快捷动作(continue/regen/impersonate/mvu/attach,直接执行);
 *  下段 = core builtins 注册表命令(/api/utopinn/script/commands 快照)。
 *  分组视图(仅 `/` 或 `/` 钮打开):命令折成组头(tavern/flow/world/dialog/
 *  script/misc),点开或键盘 Enter/→ 展开;组头 hover 眼钮整组隐藏,隐藏组
 *  收成哑行列在底部可一键恢复。flat 语境(打 token/参数区)回到平铺过滤。
 *  点选/Tab/Enter 把命令锁成 composer 里的 coral chip(不执行 —— Enter 才跑)。
 *  footer = utopinn.slash.enabled 总闸 + 键位提示。
 *  filter = draft 的 `/` token(正在打的命令词,前缀过滤;null = 按钮开的菜单不过滤);
 *  inArgs = token 已完整且进入参数区 → 签名卡模式(参数名提示全展开)。
 *  nav 由父级预筛+分组(非补全语境即草稿有非 `/` 正文时传空表 ——
 *  防止点选命令把用户正文顶掉)。 */
function SlashMenu({ onPick, onPickCommand, nav, cmdCount, hi, setHi, filter, inArgs, flat, enabled, onToggleEnabled, onToggleGroup, onHideGroup, onShowGroup, onClose }: {
    onPick: (key: string) => void;
    onPickCommand: (name: string) => void;
    /** 父级拍平的导航行(组头 + 可见命令行);hi 对它下标。 */
    nav: SlashNav;
    /** 注册表匹配总数(过滤前分组计数不受折叠影响,表头徽数用)。 */
    cmdCount: number;
    hi: number;
    setHi: (n: number) => void;
    filter: string | null;
    inArgs: boolean;
    /** flat = 补全/搜索语境(打 token 或参数区):无组头平铺;否则分组视图。 */
    flat: boolean;
    /** 环境斜杠体验总闸(footer 开关;关掉后本菜单只能由 `/` 钮显式打开)。 */
    enabled: boolean;
    onToggleEnabled: () => void;
    onToggleGroup: (g: SlashGroupKey) => void;
    onHideGroup: (g: SlashGroupKey) => void;
    onShowGroup: (g: SlashGroupKey) => void;
    onClose: () => void;
}) {
    const { t } = useI18n();
    const scrollRef = useRef<HTMLDivElement>(null);
    const quickAll: { key: string; icon: IconName; label: string; desc: string; slash: string; badge?: string }[] = [
        { key: 'continue', icon: 'fastForward', label: t('slash.continue'), desc: t('slash.continue.desc'), slash: '/continue' },
        { key: 'regen', icon: 'refresh', label: t('slash.regen'), desc: t('slash.regen.desc'), slash: '/regen' },
        { key: 'impersonate', icon: 'wand', label: t('slash.impersonate'), desc: t('slash.impersonate.desc'), slash: '/impersonate' },
        { key: 'mvu', icon: 'database', label: t('slash.mvu'), desc: t('slash.mvu.desc'), slash: '/mvu sync' },
        { key: 'attach', icon: 'paperclip', label: t('slash.attach'), desc: t('slash.attach.desc'), slash: '/attach', badge: t('slash.attach.badge') },
    ];
    const q = (filter ?? '').toLowerCase();
    /* 参数区隐藏快捷入口(用户已在打真命令);有过滤词时快捷项也按 slash 前缀过滤 */
    const quick = inArgs ? [] : quickAll.filter((c) => filter === null || c.slash.slice(1).toLowerCase().startsWith(q));
    const cmdRows = nav.rows.filter((r): r is Extract<SlashNavRow, { kind: 'cmd' }> => r.kind === 'cmd');
    const sigMode = inArgs && cmdRows.length === 1;
    /* 键盘高亮行滚进视野(组展开后长列表,↑↓ 不能滚丢)。 */
    useEffect(() => {
        scrollRef.current?.querySelector('[data-hi="true"]')?.scrollIntoView({ block: 'nearest' });
    }, [hi]);
    /* 过滤态全灭(打出的 token 无匹配)→ 弹层不渲染占位壳,让用户看见没匹配。 */
    if (filter !== null && quick.length === 0 && cmdCount === 0) return null;
    return (
        /* 规范稿 renderComposerCommandMenu:透明幕 + left-4/sm:left-6 锚,bottom 随 QR 条抬升 */
        <div className="absolute inset-0 z-30" onClick={onClose}>
            <div
                className="pop-in absolute left-4 flex w-[300px] max-w-[calc(100%-32px)] flex-col rounded-2xl p-1.5 sm:left-6"
                style={{ background: 'var(--bg-elevated)', boxShadow: 'var(--shadow-pop)', bottom: 'var(--slash-pop-bottom, 94px)' }}
                onClick={(e) => e.stopPropagation()}
            >
                <div className="flex items-center justify-between px-2.5 py-1.5 text-[10.5px] font-medium text-[color:var(--fg-muted)]">
                    <span>{t('slash.menu.title')}</span><span className="font-mono-ui">/ {cmdCount}</span>
                </div>
                <div ref={scrollRef} className="max-h-[46vh] space-y-0.5 overflow-y-auto">
                    {quick.map((c) => (
                        <button
                            key={c.key}
                            className="flex w-full items-center justify-between gap-2 rounded-xl px-2.5 py-2 text-left transition-colors hover:bg-[color:var(--bg-active)]"
                            style={c.badge ? { opacity: 0.55, cursor: 'not-allowed' } : undefined}
                            onClick={() => { if (!c.badge) onPick(c.key); }}
                            title={c.badge ? `${c.slash} · ${c.badge}` : c.slash}
                        >
                            <span className="flex min-w-0 items-center gap-2.5">
                                <Icon name={c.icon} size={15} className="shrink-0 text-[color:var(--fg-secondary)]" />
                                <span className="min-w-0">
                                    <span className="block truncate text-[12.5px] font-medium text-[color:var(--fg-primary)]">{c.label}</span>
                                    <span className="block truncate text-[10.5px] text-[color:var(--fg-muted)]">{c.desc}</span>
                                </span>
                            </span>
                            {c.badge
                                ? <span className="shrink-0 rounded-md border border-[color:var(--border-hairline)] bg-[color:var(--bg-surface)] px-1.5 py-0.5 text-[9px] text-[color:var(--fg-faint)]">{c.badge}</span>
                                : <span className="shrink-0 font-mono-ui text-[10px] text-[color:var(--fg-faint)]">{c.slash}</span>}
                        </button>
                    ))}
                    {quick.length > 0 && nav.rows.length > 0 && (
                        <div className="mx-1 my-1 border-t border-[color:var(--border-hairline)]" />
                    )}
                    {nav.rows.map((row, i) => row.kind === 'head' ? (
                        /* 组头行:chevron + 组名 + 计数;hover 浮出「隐藏此组」眼钮。
                           也是导航行 —— Enter/Tab/→ 展开,← 收起(与点击同义)。 */
                        <div
                            key={`h:${row.group}`}
                            data-hi={i === hi || undefined}
                            role="button"
                            className="group/shead flex w-full cursor-pointer items-center gap-1.5 rounded-xl px-2.5 py-1.5 text-left transition-colors hover:bg-[color:var(--bg-active)]"
                            style={i === hi ? { background: 'var(--bg-active)' } : undefined}
                            onMouseEnter={() => setHi(i)}
                            onClick={() => onToggleGroup(row.group)}
                        >
                            <Icon name={row.open ? 'chevronDown' : 'chevronRight'} size={11} className="shrink-0 text-[color:var(--fg-faint)]" />
                            <span className="min-w-0 flex-1 truncate text-[11.5px] font-medium text-[color:var(--fg-secondary)]">{t(`slash.grp.${row.group}`)}</span>
                            <span className="shrink-0 font-mono-ui text-[10px] text-[color:var(--fg-faint)]">{row.count}</span>
                            <button
                                type="button"
                                className="ml-1 hidden shrink-0 items-center justify-center rounded p-0.5 text-[color:var(--fg-faint)] transition-colors hover:text-[color:var(--fg-primary)] group-hover/shead:flex"
                                title={t('slash.group.hide')}
                                onClick={(e) => { e.stopPropagation(); onHideGroup(row.group); }}
                            >
                                <Icon name="eyeClosed" size={12} />
                            </button>
                        </div>
                    ) : (
                        <button
                            key={row.cmd.name}
                            data-hi={i === hi || undefined}
                            className={`flex w-full items-start gap-2 rounded-xl py-1.5 text-left transition-colors hover:bg-[color:var(--bg-active)] ${flat ? 'px-2.5' : 'pl-[26px] pr-2.5'}`}
                            style={i === hi ? { background: 'var(--bg-active)' } : undefined}
                            onMouseEnter={() => setHi(i)}
                            onClick={() => onPickCommand(row.cmd.name)}
                            title={row.cmd.aliases.length ? `/${row.cmd.name} · /${row.cmd.aliases.join(' /')}` : `/${row.cmd.name}`}
                        >
                            <span
                                className="shrink-0 pt-px font-mono-ui text-[12px] font-medium"
                                style={{ color: i === hi ? 'var(--brand)' : 'var(--fg-primary)' }}
                            >
                                /{row.cmd.name}
                            </span>
                            <span className="min-w-0 flex-1">
                                {row.cmd.help && <span className="block truncate text-[11px] text-[color:var(--fg-muted)]">{row.cmd.help}</span>}
                                {(row.cmd.args.length > 0 || (sigMode && row.cmd.unnamed.length > 0)) && (
                                    <span className="mt-0.5 flex flex-wrap gap-1">
                                        {/* 参数名提示:必填打 *,有字符串默认带 =def;签名卡模式全展开 */}
                                        {row.cmd.args.slice(0, sigMode ? row.cmd.args.length : 5).map((a) => (
                                            <span
                                                key={a.name}
                                                className="rounded-md border border-[color:var(--border-hairline)] bg-[color:var(--bg-surface)] px-1 py-px font-mono-ui text-[9.5px] text-[color:var(--fg-faint)]"
                                                title={a.required ? `${a.name}= (required)` : undefined}
                                            >
                                                {a.name}{a.required ? '*' : a.def != null ? `=${a.def}` : '='}
                                            </span>
                                        ))}
                                        {!sigMode && row.cmd.args.length > 5 && (
                                            <span className="rounded-md px-1 py-px font-mono-ui text-[9.5px] text-[color:var(--fg-faint)]">+{row.cmd.args.length - 5}</span>
                                        )}
                                        {sigMode && row.cmd.unnamed.map((u, j) => (
                                            <span key={`u${j}`} className="rounded-md px-1 py-px font-mono-ui text-[9.5px] italic text-[color:var(--fg-faint)]">⟨{u}⟩</span>
                                        ))}
                                    </span>
                                )}
                            </span>
                        </button>
                    ))}
                    {!flat && nav.hiddenGroups.length > 0 && (
                        <div className="mx-1 my-1 border-t border-[color:var(--border-hairline)]" />
                    )}
                    {/* 整组隐藏的组收成哑行留在列表底部 —— 一键恢复,入口不离现场。 */}
                    {!flat && nav.hiddenGroups.map((h) => (
                        <div key={`x:${h.group}`} className="flex items-center justify-between rounded-xl px-2.5 py-1.5">
                            <span className="text-[11px] text-[color:var(--fg-faint)]">
                                {t(`slash.grp.${h.group}`)} · {h.count} · {t('slash.group.hidden')}
                            </span>
                            <button
                                type="button"
                                className="text-[10.5px] text-[color:var(--fg-faint)] transition-colors hover:text-[color:var(--fg-primary)]"
                                onClick={() => onShowGroup(h.group)}
                            >
                                {t('slash.group.show')}
                            </button>
                        </div>
                    ))}
                </div>
                {/* footer:总闸 + 键位提示。总闸关掉后本菜单仅 `/` 钮可达 —— 开关留在现场。 */}
                <div className="mt-1 flex items-center justify-between gap-2 border-t border-[color:var(--border-hairline)] px-2.5 pb-0.5 pt-1.5">
                    <button
                        type="button"
                        className="flex items-center gap-2 text-[10.5px] text-[color:var(--fg-muted)] transition-colors hover:text-[color:var(--fg-primary)]"
                        title={t('slash.enabled.tip')}
                        onClick={onToggleEnabled}
                    >
                        <span className="sh-switch" data-checked={enabled}><span className="sh-switch-thumb" /></span>
                        {t('slash.enabled')}
                    </button>
                    <span className="font-mono-ui text-[9.5px] text-[color:var(--fg-faint)]">{t('slash.kbd.hint')}</span>
                </div>
            </div>
        </div>
    );
}

/** 规范稿 renderPresetPopover:right-6 bottom-锚 w-[352px],头行 + 双
 *  sh-select(model|preset)+ inset-group 四滑杆 + prompt blocks sh-switch。 */
function PresetPop({ onClose }: { onClose: () => void }) {
    const { t } = useI18n();
    const s = useShell();
    const pp = s.presetParams;
    const sliders: { k: 'temp' | 'topP' | 'ctxLen' | 'maxReply'; label: string; min: number; max: number; step: number; fmt: (v: number) => string }[] = [
        { k: 'temp', label: t('param.temp'), min: 0, max: 1.5, step: 0.05, fmt: (v) => v.toFixed(2) },
        { k: 'topP', label: t('param.topP'), min: 0.1, max: 1, step: 0.02, fmt: (v) => v.toFixed(2) },
        { k: 'ctxLen', label: t('param.ctxLen'), min: 16000, max: 200000, step: 8000, fmt: (v) => v.toLocaleString() },
        { k: 'maxReply', label: t('param.maxReply'), min: 1024, max: 16384, step: 1024, fmt: (v) => String(v) },
    ];
    return (
        <div className="absolute inset-0 z-30" onClick={onClose}>
            <div
                className={
                    s.isMobile
                        ? 'pop-in absolute inset-x-3 bottom-[var(--composer-pop-bottom,88px)] z-40 flex max-h-[72vh] flex-col overflow-hidden rounded-2xl'
                        : 'pop-in absolute bottom-[var(--composer-pop-bottom,92px)] right-6 z-40 flex max-h-[72vh] w-[352px] flex-col overflow-hidden rounded-2xl'
                }
                style={{ background: 'var(--bg-elevated)', boxShadow: 'var(--shadow-pop)', transformOrigin: 'bottom right' }}
                onClick={(e) => e.stopPropagation()}
            >
                <div className="flex h-11 shrink-0 items-center justify-between border-b border-[color:var(--border-hairline)] px-4">
                    <span className="heading-tight text-[13.5px] font-medium text-[color:var(--fg-primary)]">{t('composer.presetModel')}</span>
                    <div className="flex items-center gap-1">
                        {s.live && (
                            <button type="button" className="ghost-btn h-7 w-7" title={t('panel.retry')} onClick={() => void s.refreshConnection({ freshModels: true })}>
                                <Icon name="refresh" size={13} />
                            </button>
                        )}
                        <button type="button" className="ghost-btn h-7 w-7" onClick={onClose}><Icon name="x" size={15} /></button>
                    </div>
                </div>
                <div className="space-y-3.5 overflow-y-auto p-4">
                    <div className="grid grid-cols-2 gap-2">
                        <div className="relative min-w-0">
                            <button type="button" className="sh-select-trigger" title={t('panel.preset.model')} onClick={() => s.setOpenDropdown(s.openDropdown === 'model' ? null : 'model')}>
                                <span className="truncate font-mono-ui text-[11.5px]">
                                    {s.live ? (s.models.find((m) => m.id === s.activeModel)?.short || s.activeModel || t('st.conn.noModels')) : t('stage.demoData')}
                                </span>
                                <span className="shrink-0 text-[color:var(--fg-muted)]"><Icon name="chevronDown" size={12} /></span>
                            </button>
                            {s.openDropdown === 'model' && (
                                <div className="sh-select-menu max-h-60 overflow-y-auto">
                                    {s.live && s.models.length > 0 ? s.models.map((m) => (
                                        <button key={m.id} type="button" className="flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-[color:var(--bg-active)]" onClick={() => { s.setActiveModel(m.id); s.setOpenDropdown(null); }}>
                                            <span className="min-w-0 pr-2">
                                                <span className="block truncate font-mono-ui text-[12px]">{m.id}</span>
                                                <span className="block truncate text-[10px] text-[color:var(--fg-muted)]">{m.ctx ? `${m.provider} · ${m.ctx}` : m.provider}</span>
                                            </span>
                                            {m.id === s.activeModel && <Icon name="check" size={13} className="shrink-0 text-[color:var(--brand)]" />}
                                        </button>
                                    )) : (
                                        <div className="space-y-2 p-2.5 text-[11px] text-[color:var(--fg-muted)]">
                                            <div className="break-all font-mono-ui text-[10.5px]">{s.live ? (s.modelsError ?? t('st.conn.noModels')) : t('stage.demoData')}</div>
                                            <button
                                                type="button"
                                                className="w-full rounded-lg px-2.5 py-1.5 text-[11.5px] font-medium"
                                                style={{ background: 'var(--brand)', color: 'var(--brand-fg)' }}
                                                onClick={() => { s.setOpenDropdown(null); onClose(); s.openSettings('api'); }}
                                            >
                                                {t('st.conn.configApi')}
                                            </button>
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                        <div className="relative min-w-0">
                            <button type="button" className="sh-select-trigger" title={t('panel.preset.preset')} onClick={() => s.setOpenDropdown(s.openDropdown === 'preset' ? null : 'preset')}>
                                <span className="truncate font-mono-ui text-[11.5px]">{s.live ? (s.activePresetId ? s.activePresetId.replace(/\.json$/i, '') : '—') : t('stage.demoData')}</span>
                                <span className="shrink-0 text-[color:var(--fg-muted)]"><Icon name="chevronDown" size={12} /></span>
                            </button>
                            {s.openDropdown === 'preset' && (
                                <div className="sh-select-menu max-h-60 overflow-y-auto">
                                    {!s.live && <div className="px-2.5 py-1.5 text-[10.5px] text-[color:var(--fg-faint)]">{t('stage.demoData')}</div>}
                                    {s.presets.map((p) => (
                                        <button key={p.id} type="button" className="flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-[color:var(--bg-active)]" onClick={() => { s.pickPreset(p.id); s.setOpenDropdown(null); }}>
                                            <span className="min-w-0 pr-2">
                                                <span className="block truncate font-mono-ui text-[12px]">{p.id.replace(/\.json$/i, '')}</span>
                                                <span className="block truncate font-mono-ui text-[10px] text-[color:var(--fg-muted)]">T {p.temp} · TopP {p.topP} · {p.maxReply} tok</span>
                                            </span>
                                            {p.id === s.activePresetId && <Icon name="check" size={13} className="shrink-0 text-[color:var(--brand)]" />}
                                        </button>
                                    ))}
                                </div>
                            )}
                        </div>
                    </div>
                    <div className="inset-group">
                        {sliders.map((sl) => (
                            <div key={sl.k} className="inset-row flex-col items-stretch gap-1 py-2.5">
                                <div className="flex w-full justify-between text-[11.5px]">
                                    <span className="text-[color:var(--fg-secondary)]">{sl.label}</span>
                                    <span className="font-mono-ui">{sl.fmt(pp[sl.k])}</span>
                                </div>
                                <input type="range" min={sl.min} max={sl.max} step={sl.step} value={pp[sl.k]} className="h-1.5 w-full" onChange={(e) => s.setPresetParam(sl.k, Number(e.target.value))} />
                            </div>
                        ))}
                    </div>
                    <div className="inset-group">
                        {pp.blocks.map((b) => (
                            <div key={b.id} className="inset-row py-2">
                                <span className="truncate text-[12px] text-[color:var(--fg-primary)]">{b.name}</span>
                                <button type="button" className="sh-switch" data-checked={b.enabled} onClick={() => s.togglePresetBlock(b.id)}><span className="sh-switch-thumb" /></button>
                            </div>
                        ))}
                    </div>
                </div>
            </div>
        </div>
    );
}

/* ——— QR 册弹层(TASK-063):全册名录 + 各册绑定域徽(全局/此卡/本会话,
     读数非开关)+ 行内启停 + 底部管理入口。启停语义与钮行 CTA 同一路
     (toggleQrSet):开 → 全局 link 补/翻真;关 → 全域 link 翻假、绑定留。 ——— */
function QrSetPop({ names, sel, enabled, qr, chatCfg, charKey, onPick, onToggle, onManage, onClose }: {
    names: string[];
    sel: string;
    enabled: ReadonlySet<string>;
    qr: QrSettings | null;
    chatCfg: QrConfig | null;
    charKey: string | null;
    onPick: (name: string) => void;
    onToggle: (name: string, on: boolean) => void;
    onManage: () => void;
    onClose: () => void;
}) {
    const { t } = useI18n();
    const s = useShell();
    const scopeTags = (n: string): string[] => {
        const out: string[] = [];
        if (qrBound(qr?.config, n)) out.push(t('stage.qr.scope.global'));
        if (charKey && qrBound(qr?.characterConfigs?.[charKey], n)) out.push(t('stage.qr.scope.char'));
        if (qrBound(chatCfg, n)) out.push(t('stage.qr.scope.chat'));
        return out;
    };
    return (
        <div className="absolute inset-0 z-30" onClick={onClose}>
            <div
                className={
                    s.isMobile
                        ? 'pop-in absolute inset-x-3 bottom-[var(--composer-pop-bottom,88px)] z-40 flex max-h-[56vh] flex-col overflow-hidden rounded-2xl'
                        : 'pop-in absolute bottom-[var(--composer-pop-bottom,92px)] left-1/2 z-40 flex max-h-[56vh] w-[360px] -translate-x-1/2 flex-col overflow-hidden rounded-2xl'
                }
                style={{ background: 'var(--bg-elevated)', boxShadow: 'var(--shadow-pop)', transformOrigin: 'bottom center' }}
                onClick={(e) => e.stopPropagation()}
            >
                <div className="flex h-11 shrink-0 items-center justify-between border-b border-[color:var(--border-hairline)] px-4">
                    <span className="heading-tight text-[13.5px] font-medium text-[color:var(--fg-primary)]">{t('stage.qr.pop.title')}</span>
                    <button type="button" className="ghost-btn h-7 w-7" onClick={onClose}><Icon name="x" size={15} /></button>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto p-2">
                    {names.map((n) => {
                        const on = enabled.has(n);
                        const tags = scopeTags(n);
                        return (
                            <div key={n} className="flex items-center gap-2 rounded-xl px-2 py-1.5 transition-colors hover:bg-[color:var(--bg-active)]">
                                <button
                                    type="button"
                                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                                    onClick={() => onPick(n)}
                                >
                                    <span className="flex h-4 w-4 shrink-0 items-center justify-center text-[color:var(--brand)]">
                                        {n === sel && <Icon name="check" size={13} />}
                                    </span>
                                    <span className={`truncate text-[12.5px] ${on ? 'text-[color:var(--fg-primary)]' : 'text-[color:var(--fg-faint)] line-through'}`}>{n}</span>
                                    {tags.map((tg) => (
                                        <span key={tg} className="shrink-0 rounded px-1 py-px font-mono-ui text-[9.5px] text-[color:var(--fg-muted)]" style={{ background: 'var(--bg-active)', border: '1px solid var(--border-hairline)' }}>{tg}</span>
                                    ))}
                                </button>
                                <button type="button" className="sh-switch" data-checked={on || undefined} title={t('stage.qr.toggle')} onClick={() => onToggle(n, !on)}>
                                    <span className="sh-switch-thumb" />
                                </button>
                            </div>
                        );
                    })}
                </div>
                <div className="shrink-0 border-t border-[color:var(--border-hairline)] p-2">
                    <button type="button" className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-[12px] text-[color:var(--fg-secondary)] transition-colors hover:bg-[color:var(--bg-active)] hover:text-[color:var(--fg-primary)]" onClick={onManage}>
                        <Icon name="sliders" size={13} />
                        {t('stage.qr.manage')}
                    </button>
                </div>
            </div>
        </div>
    );
}

/* ------------------------------------------------------------------ */
/* StageFrame —— 引擎 + 帧壳                                             */
/* ------------------------------------------------------------------ */

export function StageFrame({ children }: { children: ReactNode }) {
    const { t } = useI18n();
    const s = useShell();
    const stageKind: StageKind = s.chat?.stage ?? 'chat';
    const [msgs, setMsgs] = useState<FloorMsg[]>(MOCK_MESSAGES);
    const [draft, setDraft] = useState('');
    const [busy, setBusy] = useState(false);
    const [job, setJob] = useState<{ id: string; type: GenerateVerb; floorId: number } | null>(null);
    const [editing, setEditing] = useState<{ id: number; text: string } | null>(null);
    const [menu, setMenu] = useState<'none' | 'info' | 'slash' | 'preset' | 'persona' | 'emotes' | 'group'>('none');
    /* STscript 补全:core builtins 注册表快照(live 拉一次)+ 键盘高亮位。
       偏好面(utopinn.slash.*):总闸 + 组展开/整组隐藏;菜单 footer 与
       会话信息弹层共写同一组槽。 */
    const [scriptCmds, setScriptCmds] = useState<ScriptCommandInfo[]>([]);
    const [slashHi, setSlashHi] = useState(0);
    const [slashPrefs, setSlashPrefs] = useState<SlashPrefs>(loadSlashPrefs);
    /* 命令 chip 态:菜单里选定命令 → 命令词锁成 coral chip,draft 只剩
       参数区;提交时 chip+参数拼回 `/cmd args` 走 runScript。 */
    const [pendingCmd, setPendingCmd] = useState<string | null>(null);
    /* QR 条(TASK-063 双向面):全册名录 + 选中册 + 册文档 chip + 绑定档
       (settings.quickReplyV2 全局/卡 scope + chat_metadata.quickReply
       会话 scope)。选中态是导航态,不落盘 —— 启停(isVisible link)
       与条目启停(qr.isHidden)才是持久化面。 */
    const [qrNames, setQrNames] = useState<string[]>([]);
    const [qrSel, setQrSel] = useState('');
    const [qrDoc, setQrDoc] = useState<QrSetDoc | null>(null);
    const [qrSettings, setQrSettings] = useState<QrSettings | null>(null);
    const [qrChatCfg, setQrChatCfg] = useState<QrConfig | null>(null);
    /* 会话绑书(chat_metadata.world_info,string|string[])—— 随 loadChat
       同车取,会话信息弹层读;TH setChatLorebook 同键。 */
    const [chatBound, setChatBound] = useState<string[]>([]);
    /* TASK-069 脚本挂起回执:/run 回 {awaiting:{runId,kind,...}} → 本壳
       模态驻留,用户操作经 /script/interact 兑现;resolve ref 桥接
       modal 回调与 runScript 的 await。 */
    const [scriptAwait, setScriptAwait] = useState<ScriptAwaiting | null>(null);
    const scriptDlgResolve = useRef<((r: ScriptInteractReply) => void) | null>(null);
    const [qrPick, setQrPick] = useState(false);
    const [qrOpen, setQrOpen] = useState(true);
    const [ctxLen, setCtxLen] = useState<number | null>(null);
    const [lastTokens, setLastTokens] = useState<number | null>(null);
    /* 舞台头资产 chip 读数:卡文档(主绑书/内嵌书)+ 卡级正则组。
       s.cards 进依赖 —— 卡编辑保存走 refreshCards → chip 随缓存失效重拉。 */
    const [charDoc, setCharDoc] = useState<CardDoc | null>(null);
    /** 胶囊数字背后的 job —— 点开胶囊直跳该 job 的 trace 页。 */
    const [lastJobId, setLastJobId] = useState<string | null>(null);
    const [loadErr, setLoadErr] = useState<string | null>(null);
    /* 楼层岔出在飞锁 + 「跳回该层」一次性请求(seq 重触发,消费在形态体)。 */
    const [forkBusy, setForkBusy] = useState<number | null>(null);
    const [jumpReq, setJumpReq] = useState<{ floor: number; seq: number } | null>(null);
    const transientRef = useRef(0);
    const accRef = useRef('');
    const draftTaRef = useRef<HTMLTextAreaElement>(null);
    const abortingRef = useRef('');
    const wsClose = useRef<(() => void) | null>(null);
    /** 服务端中止后 WS 未必回终帧 —— 本地 settle 兜底,busy 不挂。 */
    const settleRef = useRef<((r: { text: string; error?: string }) => void) | null>(null);
    /* 失踪会话登记簿(404 过的 charDir/chatName —— 兜底时跳过,防连环打回);
       sRef 供异步 catch 取最新壳态,避免闭包里的陈旧 chats。 */
    const missingChatsRef = useRef(new Set<string>());
    const sRef = useRef(s);
    sRef.current = s;
    const model = s.models.find((m) => m.id === s.activeModel);
    const offline = s.serverStatus === 'offline';
    const streaming = busy && job !== null;
    const groupId = s.chat?.groupId ?? null;
    const chatKey = groupId
        ? `group/${groupId}/${s.chat?.chatName ?? ''}`
        : s.chat?.charDir && s.chat?.chatName ? `${s.chat.charDir}/${s.chat.chatName}` : null;

    /* 群会话键 —— 与 chatKey 同形;失踪登记/兜底比对都用它。 */
    const chatKeyOf = (c: ChatSummary) => (c.groupId ? `group/${c.groupId}/${c.chatName}` : `${c.charDir}/${c.chatName}`);

    /* 卡文档取数:会话切换/卡清单刷新时重拉;离线/无会话清空不取数。 */
    useEffect(() => {
        const dir = s.chat?.charDir;
        if (!s.live || !dir) { setCharDoc(null); return; }
        let dead = false;
        loadCharDoc(dir)
            .then((d) => { if (!dead) setCharDoc(d); })
            .catch(() => { if (!dead) setCharDoc(null); });
        return () => { dead = true; };
    }, [s.live, s.chat?.charDir, s.cards]);

    const patchFloor = useCallback((id: number, p: Partial<FloorMsg>) => {
        setMsgs((prev) => prev.map((m) => (m.id === id ? { ...m, ...p } : m)));
    }, []);

    /* 群会话读面与单聊同形({header,messages,raw})—— 只换取数面,
       渲染/写回下游不分叉。 */
    const loadChatOf = useCallback((chat: ChatSummary) =>
        chat.groupId ? getGroupChat(chat.groupId, chat.chatName) : getChat(chat.charDir, chat.chatName), []);

    const reload = useCallback(async () => {
        const chat = s.chat;
        if (!chat) return;
        try {
            const d = await loadChatOf(chat);
            setMsgs(d.messages);
        } catch { /* reload 失败不炸楼层,下一动作再拉 */ }
    }, [s.chat, loadChatOf]);

    /* ——— 会话/连接切换:live → 真楼层;否则 mock 种子 ——— */
    useEffect(() => {
        wsClose.current?.();
        wsClose.current = null;
        /* 在途生成不 settle —— 让其悬挂,避免旧 chat 的写回/reload
           盖进新会话视图;服务端 15s 兜底会完成持久化。 */
        settleRef.current = null;
        setEditing(null);
        setJob(null);
        setBusy(false);
        abortingRef.current = '';
        setLastTokens(null);
        setLastJobId(null);
        setLoadErr(null);
        /* 形态会话(st-* 种子)渲 stageData 预演体,不存于服务端 —— 但
           stage 绑定面(SPEC-DATA)落地后真会话也会带形态,故照常取楼;
           404 对 chat 是「失踪兜底」,对形态会话只是「预演种子」标记:
           不弹走当前选择,楼层留空 → 形态体自行落 stageData。 */
        if (s.live && s.chat) {
            let dead = false;
            setMsgs([]);
            /* 会话背景锁:chat_metadata.custom_background(CSS url 字符串)
               与 settings.background 同级语义,锁在则覆盖全局(ST #bg1 优先级)。 */
            s.setChatBgLock(null);
            loadChatOf(s.chat)
                .then((d) => {
                    if (dead) return;
                    setMsgs(d.messages);
                    const meta = (d.header?.chat_metadata ?? null) as Record<string, unknown> | null;
                    const lock = typeof meta?.custom_background === 'string' && meta.custom_background.trim()
                        ? meta.custom_background : null;
                    sRef.current.setChatBgLock(lock);
                    /* QR 会话 scope 绑定档(chat_metadata.quickReply)同车取 ——
                       不再为 QR 面单发一次 getChat。 */
                    setQrChatCfg(qrChatConfigFromHeader(d.header));
                    const wi = meta?.world_info;
                    setChatBound(Array.isArray(wi) ? wi.filter((x): x is string => typeof x === 'string' && !!x)
                        : (typeof wi === 'string' && wi ? [wi] : []));
                })
                .catch((e) => {
                    if (dead) return;
                    /* 持久指针指向已删会话(404/not-found)→ 落下一可用会话,
                       全部失踪 → selectChat('') 进选会话空态;不渲整屏错误域。 */
                    if (isChatNotFound(e)) {
                        if (stageKind !== 'chat') return;
                        if (chatKey) missingChatsRef.current.add(chatKey);
                        const sh = sRef.current;
                        const next = sh.chats.find((c) => {
                            const k = chatKeyOf(c);
                            return k !== chatKey && !missingChatsRef.current.has(k);
                        });
                        sh.selectChat(next?.id ?? '');
                        return;
                    }
                    setMsgs([]); setLoadErr(errText(e));
                });
            return () => { dead = true; };
        }
        /* live 无会话 → 空楼层(选会话空态);离线/mock 路 → mock 种子。 */
        setMsgs(s.live ? [] : MOCK_MESSAGES);
        s.setChatBgLock(null);
        setQrNames([]); setQrSel(''); setQrDoc(null);
        setQrSettings(null); setQrChatCfg(null); setQrPick(false);
        setChatBound([]);
        setCtxLen(null);
    }, [chatKey, s.live]); // eslint-disable-line react-hooks/exhaustive-deps

    /* ——— STscript 注册表:composer `/` 补全数据源(GET /script/commands 快照);
           离线/缺席 → 空表,菜单只留快捷入口,不自抄词表 ——— */
    useEffect(() => {
        if (!s.live) { setScriptCmds([]); return; }
        let dead = false;
        listScriptCommands()
            .then((cmds) => { if (!dead) setScriptCmds(cmds); })
            .catch(() => { if (!dead) setScriptCmds([]); });
        return () => { dead = true; };
    }, [s.live]);

    /* ——— QR 条(TASK-063):会话级一拉全册名录 + quickReplyV2 绑定档;
           选中册(qrSel)单独拉文档。选中优先「本会话已启用的册」→ 兜底
           首册 —— 进会话即见可用 chip,不是永远 names[0]。空档整条不渲染 ——— */
    useEffect(() => {
        if (!s.live || !s.chat) return;
        let dead = false;
        void (async () => {
            try {
                const [names, qr] = await Promise.all([listQrSets(), getQrSettingsDoc()]);
                if (dead) return;
                setQrNames(names);
                setQrSettings(qr);
            } catch { if (!dead) { setQrNames([]); setQrSettings(null); } }
        })();
        return () => { dead = true; };
    }, [s.live, s.chat?.id]);

    /* 卡 avatar → characterConfigs 键(等卡文档到手再算;无卡会话 charKey=null)。 */
    const qrAvatarRaw = cardData(charDoc)?.avatar ?? charDoc?.avatar;
    const qrCharKey = s.chat?.charDir
        ? qrCharScopeKey(typeof qrAvatarRaw === 'string' && qrAvatarRaw ? qrAvatarRaw : null, s.chat.charDir)
        : null;
    const qrEnabled = qrEnabledNames(qrSettings, qrCharKey, qrChatCfg, qrNames);

    /* 名录/绑定变 → 解析选中册:现选仍有效留,否则取第一个「可用」册 → 兜底首册。 */
    useEffect(() => {
        if (!qrNames.length) { if (qrSel) { setQrSel(''); setQrDoc(null); } return; }
        if (qrSel && qrNames.includes(qrSel)) return;
        const firstEnabled = qrNames.find((n) => qrEnabled.has(n));
        setQrSel(firstEnabled ?? qrNames[0] ?? '');
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [qrNames, qrSel, qrSettings, qrChatCfg, qrCharKey]);

    /* 选中册 → 拉文档出 chip;isHidden 条目滤掉(条目级启停持久态)。 */
    useEffect(() => {
        if (!qrSel) { setQrDoc(null); return; }
        let dead = false;
        getQrSet(qrSel)
            .then((doc) => { if (!dead) setQrDoc(doc); })
            .catch(() => { if (!dead) setQrDoc(null); });
        return () => { dead = true; };
    }, [qrSel]);

    const qrChips = (qrDoc?.qrList ?? [])
        .filter((q) => q && q.isHidden !== true && typeof q.message === 'string' && q.message.trim().length > 0)
        .slice(0, 12)
        .map((q) => ({ label: (q.label ?? '').trim() || q.message!.trim().slice(0, 18), message: q.message!.trim() }));

    /* 册启停(钮行内开关):on → 全局 scope 补/翻真 link;off → 全局+本卡
       link 翻假 + 本会话 link 同翻假(link 留,是「绑定但隐藏」)。 */
    const toggleQrSet = async (name: string, on: boolean) => {
        const next = qrv2WithSetVisible(qrSettings, qrCharKey, name, on);
        try {
            await patchQrSettingsDoc(next);
            setQrSettings(next);
        } catch { return; }
        /* 群会话无 QR 卡域写面(quickReply chat-scope PATCH 是卡路由)
           —— chat-bound link 不动,全局 scope 兜底生效。 */
        if (!on && s.chat && !s.chat.groupId && qrBound(qrChatCfg, name)) {
            const cfg = qrConfigWithLink(qrChatCfg, name, 'off');
            try {
                await patchChatQrConfig(s.chat.charDir, s.chat.chatName, cfg);
                setQrChatCfg(cfg);
            } catch { /* chat 侧失败不翻 settings 回 —— 下次刷新对账 */ }
        }
    };

    /* 管理入口:深链落点交 qrStudioFocus,studio 页读取后自清。 */
    const openQrStudio = () => {
        qrStudioFocus.set = qrSel || null;
        s.setView('studio');
        s.setStudioNav('quickreplies');
    };

    /* ——— 群文档(roster/编排设置):切群会话重拉;PATCH 后由弹层回执自更 ——— */
    const [groupDoc, setGroupDoc] = useState<GroupDoc | null>(null);
    useEffect(() => {
        if (!s.live || !groupId) { setGroupDoc(null); return; }
        let dead = false;
        getGroup(groupId)
            .then((d) => { if (!dead) setGroupDoc(d); })
            .catch(() => { if (!dead) setGroupDoc(null); });
        return () => { dead = true; };
    }, [s.live, groupId]);

    /* ——— token 胶囊:ctxLen 换真(openai 预设 doc.openai_max_context) ——— */
    useEffect(() => {
        if (!s.live) return;
        let dead = false;
        getPreset(s.activePresetId.replace(/\.json$/i, ''), 'openai')
            .then(({ doc }) => {
                const v = Number((doc as Record<string, unknown>).openai_max_context);
                if (!dead && Number.isFinite(v) && v > 0) setCtxLen(v);
            })
            .catch(() => { /* 预设不在服务端 → presetParams.ctxLen 兜底 */ });
        return () => { dead = true; };
    }, [s.live, s.activePresetId]);

    /* ——— token 胶囊分子:最近 job trace 的组装 tokens ——— */
    const refreshTokens = useCallback(async (jobId?: string) => {
        if (!s.live) return;
        try {
            let id = jobId;
            if (!id) {
                /* 群 job chatKey = group:<chatId>(persist_target 同构,CLI 同款)。 */
                const wantKey = s.chat?.groupId ? `group:${s.chat.chatName}` : `char:${s.chat?.charDir}.png:${s.chat?.chatName}`;
                id = (await listJobs()).items
                    .slice()
                    .sort((a, b) => b.updated_at - a.updated_at)
                    .find((j) => j.chatKey === wantKey)?.id;
            }
            if (!id) { setLastTokens(null); setLastJobId(null); return; }
            setLastJobId(id);
            const tr = (await getJob(id)).trace;
            const used = tr
                ? Number(tr.budget ?? tr.tokenBudget ?? NaN) - Number(tr.remaining ?? tr.remainingBudget ?? NaN)
                : NaN;
            setLastTokens(Number.isFinite(used) && used > 0 ? Math.round(used) : null);
        } catch { /* 胶囊静默降级 */ }
    }, [s.live, s.chat]);

    useEffect(() => { void refreshTokens(); }, [s.live, chatKey, refreshTokens]);

    /* ——— MVU 联动刷新信号:生成/切版/回滚/结算后通知右侧 MvuPanel 重拉快照 ——— */
    const refreshMvu = useCallback(() => {
        if (!s.live) return;
        s.setPanelParams('mvu', { rev: Date.now() });
    }, [s]);

    const pushReply = (content: string) => setMsgs((prev) => [...prev, mkMock('assistant', content)]);
    const pushErrorFloor = (error: FloorMsg['error']) =>
        setMsgs((prev) => [...prev, { id: --transientRef.current, role: 'assistant', name: '', content: '', timestamp: Date.now(), error }]);

    /* ——— 规范稿 sendText 的 stage 分支:mock 路把文本/回文送回形态数据。
     *     novel/theater 现以楼层轨优先渲染 —— mock 回文落成楼层,
     *     章目录/对话框经推导自然更新;落进 stageData 种子会进不可见轨。 ——— */
    const mockStagePush = useCallback((kind: StageKind, text: string) => {
        if (kind === 'messenger') {
            s.patchStageData({
                channels: s.stageData.channels.map((c) => c.id === s.stageData.activeChannel
                    ? { ...c, msgs: [...c.msgs, { sender: s.persona?.name ?? s.currentUser?.name ?? 'User', self: true, time: '刚刚', text }] }
                    : c),
            });
            return;
        }
        /* novel 的 user 楼渲成段间「指挥」注记,theater 渲成玩家台词楼。 */
        setMsgs((prev) => [...prev, mkMock('user', text, false, s.persona?.name ?? s.currentUser?.name ?? 'User')]);
    }, [s]);

    const mockStageReply = useCallback((kind: StageKind, reply: string) => {
        if (kind === 'messenger') {
            s.patchStageData({
                channels: s.stageData.channels.map((c) => c.id === s.stageData.activeChannel
                    ? { ...c, msgs: [...c.msgs, { sender: c.members[0]?.name ?? '群成员', self: false, time: '刚刚', text: reply }] }
                    : c),
            });
            return;
        }
        /* chat/novel/theater 统一回楼层:章目录按推导重分段,theater 末楼换台词。 */
        pushReply(reply);
    }, [s]);

    const mockReplyFor = (kind: StageKind) =>
        kind === 'novel' ? MOCK_REPLY_NOVEL : kind === 'messenger' ? MOCK_REPLY_IM : kind === 'theater' ? MOCK_REPLY_VN : MOCK_REPLY_CHAT;

    /* ——— 群生成(TASK-062)———
     *   选员恒在服务端(groupId 入参 → 纯函数编排);本层只透传 member 强指、
     *   读 x-utopinn-group 回执链队尾。写回分工:
     *     normal/regenerate → 服务端 persist_target(kind:group)自动落盘,
     *                         客户端 waitJobPersisted 后 reload;
     *     swipe/continue    → persist_target none + 客户端 PATCH(单聊同构);
     *     impersonate/quiet → persist_target none + gen-id 记账 patch;
     *     中止(aborted)     → cancelled job 无服务端 persist → 客户端补落
     *                         带 extra.aborted 的成员楼(单路同款)。 */
    const waitJobPersisted = useCallback(async (jobId: string, timeoutMs = 20000) => {
        const start = Date.now();
        for (;;) {
            const j = await getJob(jobId).catch(() => null);
            if (!j) return; /* job 面缺席 → 交 reload 兜底,不吊链 */
            if (j.persisted || j.status === 'awaiting_ack' || j.status === 'completed') return;
            if (j.status === 'failed' || j.status === 'cancelled') return; /* 失败不阻塞链,错误面已在楼层 */
            if (Date.now() - start > timeoutMs) return;
            await new Promise((r) => setTimeout(r, 320));
        }
    }, []);

    /* 群楼层写回(clientWriteBack 动词 + 中止补楼)。`member` = x-utopinn-group
       回执发言者;缺席(异常路径)→ roster 首成员兜底名,不编造发言人。 */
    const writeBackGroupGeneration = useCallback(async (
        type: GenerateVerb,
        text: string,
        jobId: string,
        aborted: boolean,
        member: { avatar: string; name: string } | null,
    ) => {
        const chat = s.chat!;
        const gid = chat.groupId!;
        const chatId = chat.chatName;
        const mem = member ?? {
            avatar: groupDoc?.roster?.[0]?.avatar ?? '',
            name: groupDoc?.roster?.[0]?.name ?? chat.group ?? 'Member',
        };
        /* normal/regenerate 未中止 = 服务端已 persist,客户端不写。 */
        if ((type === 'normal' || type === 'regenerate') && !aborted) return;
        if (type === 'normal' && aborted) {
            if (text.trim()) await appendGroupChatMessages(gid, chatId, { message: mkGroupAssistantFloor(mem, text, { jobId, aborted }), lukerGenerationId: jobId });
            return;
        }
        const { raw } = await getGroupChat(gid, chatId);
        const lastIdx = raw.length - 1;
        const floor = lastIdx >= 0 ? raw[lastIdx]! : null;
        if (type === 'impersonate' || type === 'quiet') {
            await patchGroupChat(gid, chatId,
                [{ op: 'replace', path: `/body/${Math.max(0, lastIdx)}/extra/luker_generation_id`, value: jobId }],
                { lukerGenerationId: jobId });
            return;
        }
        if (!floor || floor.is_user) {
            /* swipe/continue/regenerate(aborted)在末楼 user/空聊时 → 追加新楼 */
            if (text.trim()) await appendGroupChatMessages(gid, chatId, { message: mkGroupAssistantFloor(mem, text, { jobId, aborted }), lukerGenerationId: jobId });
            return;
        }
        const ops: ChatPatchOp[] = [];
        const abortedOps = () => {
            if (!aborted) return;
            if (floor.extra && typeof floor.extra === 'object') ops.push({ op: 'add', path: `/body/${lastIdx}/extra/aborted`, value: true });
            else ops.push({ op: 'add', path: `/body/${lastIdx}/extra`, value: { aborted: true } });
        };
        if (type === 'regenerate') {
            /* 中止的 regen 覆盖末楼 = 单路同款(整楼换,swipe 组弃置)。 */
            ops.push({ op: 'replace', path: `/body/${lastIdx}`, value: mkGroupAssistantFloor(mem, text, { jobId, aborted }) });
        } else if (type === 'swipe') {
            const info = { send_date: new Date().toISOString(), gen_started: null, gen_finished: null, extra: {} };
            if (Array.isArray(floor.swipes)) {
                ops.push({ op: 'add', path: `/body/${lastIdx}/swipes/-`, value: text });
                ops.push({ op: 'replace', path: `/body/${lastIdx}/swipe_id`, value: floor.swipes.length });
                if (Array.isArray(floor.swipe_info)) ops.push({ op: 'add', path: `/body/${lastIdx}/swipe_info/-`, value: info });
                else ops.push({ op: 'add', path: `/body/${lastIdx}/swipe_info`, value: [...floor.swipes.map(() => ({})), info] });
            } else {
                ops.push({ op: 'add', path: `/body/${lastIdx}/swipes`, value: [floor.mes ?? '', text] });
                ops.push({ op: 'replace', path: `/body/${lastIdx}/swipe_id`, value: 1 });
                ops.push({ op: 'add', path: `/body/${lastIdx}/swipe_info`, value: [{ send_date: floor.send_date, extra: floor.extra ?? {} }, info] });
            }
            ops.push({ op: 'replace', path: `/body/${lastIdx}/mes`, value: text });
            abortedOps();
        } else if (type === 'continue') {
            const next = String(floor.mes ?? '') + text;
            ops.push({ op: 'replace', path: `/body/${lastIdx}/mes`, value: next });
            const sid = Number(floor.swipe_id ?? 0);
            if (Array.isArray(floor.swipes) && floor.swipes.length > sid) {
                ops.push({ op: 'replace', path: `/body/${lastIdx}/swipes/${sid}`, value: next });
            }
            abortedOps();
        }
        if (ops.length) await patchGroupChat(gid, chatId, ops, { lukerGenerationId: jobId });
    }, [s.chat, groupDoc]);

    const runGroupGenerate = useCallback(async (type: GenerateVerb, opts?: { member?: string }) => {
        const chat = s.chat;
        const gid = chat?.groupId;
        if (!chat || !gid || busy) return;
        const imp = type === 'impersonate';
        /* 服务端 persist 只覆盖追加型动词;swipe/continue/imp/quiet 客户端写回。 */
        const clientWrite = type !== 'normal' && type !== 'regenerate';
        const presetClean = s.activePresetId ? s.activePresetId.replace(/\.json$/i, '') : undefined;
        const userBody = s.persona
            ? { name: s.persona.name, description: s.persona.description }
            : { name: s.currentUser?.name || s.currentUser?.handle || 'User' };
        const rosterName = (avatar: string) => groupDoc?.roster?.find((m) => m.avatar === avatar)?.name ?? '';
        setBusy(true);

        /* 单成员一轮:post → stream → 写回分工 → 回执(供队链)。 */
        const runOne = async (member?: string): Promise<GroupGenerateResult | null> => {
            const floorId = imp ? Number.NaN : --transientRef.current;
            if (!imp) setMsgs((prev) => [...prev, { id: floorId, role: 'assistant', name: member ? (rosterName(member) || member) : '', content: '', streaming: true, timestamp: Date.now() }]);
            accRef.current = '';
            let report: GroupGenerateResult | null = null;
            try {
                const post = await postGroupGenerate({
                    groupId: gid,
                    chatId: chat.chatName,
                    type,
                    ...(member ? { member } : {}),
                    ...(presetClean ? { presetName: presetClean } : {}),
                    user: userBody,
                    clientWriteBack: clientWrite,
                });
                report = post;
                if (post.skipped || !post.jobId) {
                    /* 空激活(MANUAL+isUserInput/无可载成员)→ 撤瞬态楼;
                       用户楼已落,无人应答照实报 —— 不在 UI 层绕过。 */
                    if (!imp) setMsgs((prev) => prev.filter((m) => m.id !== floorId));
                    return report;
                }
                const jobId = post.jobId;
                if (!imp && report?.group?.member?.name) patchFloor(floorId, { name: report.group.member.name });
                setJob({ id: jobId, type, floorId });
                const res = await new Promise<{ text: string; error?: string }>((resolve) => {
                    const settle = (r: { text: string; error?: string }) => {
                        if (settleRef.current !== settle) return;
                        settleRef.current = null;
                        resolve(r);
                    };
                    settleRef.current = settle;
                    streamJob(jobId, {
                        onDelta: (acc) => {
                            accRef.current = acc;
                            if (imp) setDraft(acc);
                            else patchFloor(floorId, { content: acc });
                        },
                        onEnd: () => settle({ text: accRef.current }),
                        onError: (message) => settle({ text: accRef.current, error: message }),
                    }).then((close) => { wsClose.current = close; })
                        .catch((e) => settle({ text: accRef.current, error: errText(e) }));
                });
                const aborted = abortingRef.current === jobId;
                if (aborted) {
                    if (imp) {
                        /* 草稿已留输入框 */
                    } else if (res.text.trim()) {
                        patchFloor(floorId, { streaming: false, aborted: true });
                        try { await writeBackGroupGeneration(type, res.text, jobId, true, report?.group?.member ?? null); await reload(); }
                        catch (e) { s.hint(t('stage.patch.failed') + ': ' + errText(e), true); }
                    } else {
                        setMsgs((prev) => prev.filter((m) => m.id !== floorId));
                    }
                } else if (res.error !== undefined) {
                    if (imp) pushErrorFloor({ code: 'job_error', message: res.error, jobId, retry: { type } });
                    else patchFloor(floorId, { streaming: false, error: { code: 'job_error', message: res.error, jobId, retry: { type } } });
                } else {
                    if (!imp) setMsgs((prev) => prev.filter((m) => m.id !== floorId));
                    if (clientWrite) {
                        try { await writeBackGroupGeneration(type, res.text, jobId, false, report?.group?.member ?? null); }
                        catch (e) { s.hint(t('stage.patch.failed') + ': ' + errText(e), true); }
                    } else {
                        /* 服务端 persist —— 等落盘,queue 链下一位组装要吃上新楼层 */
                        await waitJobPersisted(jobId);
                    }
                }
                void refreshTokens(jobId);
                void refreshMvu();
                return report;
            } catch (e) {
                const message = errText(e);
                const code = errCode(e);
                if (imp) pushErrorFloor({ code, message, retry: { type } });
                else patchFloor(floorId, { streaming: false, error: { code, message, retry: { type } } });
                return report;
            }
        };

        try {
            const first = await runOne(opts?.member);
            if (first?.skipped) s.hint(t('group.noAnswer'));
            /* 激活队列链(queue[1..] 挨个强指 —— LIST/多成员拍全播;
               手动点名(opts.member)只拍指定者,不链)。 */
            const tail = (!opts?.member && first?.group?.queue && first.group.queue.length > 1) ? first.group.queue.slice(1) : [];
            for (const avatar of tail) {
                if (abortingRef.current) break;
                await runOne(avatar);
            }
            await reload();
        } finally {
            abortingRef.current = '';
            settleRef.current = null;
            wsClose.current = null;
            setJob(null);
            setBusy(false);
        }
    }, [s, busy, groupDoc, patchFloor, reload, writeBackGroupGeneration, refreshTokens, refreshMvu, t, waitJobPersisted]);

    /* ——— 生成写回(legacy save_decision 同构:除 impersonate/quiet 外,
     *     客户端写盘是常路,gen-id/命中末楼 ack 掉 awaiting_ack job,
     *     服务端 15s 兜底 persist 只兜 tab 丢失;aborted 半截文本照写
     *     并打 extra.aborted,cancelled job 无兜底 → 不会双写)———
     *   normal      → 追加助手楼(消息体 gen-id → 值 ack)
     *   regenerate  → 末楼非 user 则 replace 整楼(旧楼连 swipes 弃置);
     *                 末楼 user/空聊 → 追加(legacy Generate() 同语义)
     *   swipe       → 末楼 swipes 增槽 + swipe_id 跳新槽 + mes/swipe_info 同步
     *   continue    → 末楼 mes 与当前 swipe 槽各加半截
     *   impersonate/quiet → 不落楼,纯 gen-id 记账 patch(applied:0 早退
     *                 分支:侧车去重 + hitsLast persistTarget ack)*/
    const writeBackGeneration = useCallback(async (type: GenerateVerb, text: string, jobId: string, aborted: boolean) => {
        const chat = s.chat!;
        const charName = s.cards.get(chat.charDir)?.name ?? chat.charDir;
        if (type === 'normal') {
            if (text.trim()) await appendAssistantMessage(chat.charDir, chat.chatName, charName, text, { jobId, aborted });
            return;
        }
        const { raw } = await getChat(chat.charDir, chat.chatName);
        const lastIdx = raw.length - 1;
        const floor = lastIdx >= 0 ? raw[lastIdx]! : null;
        if (type === 'impersonate' || type === 'quiet') {
            await patchChat(chat.charDir, chat.chatName,
                [{ op: 'replace', path: `/body/${Math.max(0, lastIdx)}/extra/luker_generation_id`, value: jobId }],
                { lukerGenerationId: jobId });
            return;
        }
        if (!floor || floor.is_user) {
            // swipe/continue/regenerate 在末楼 user/空聊时无锚点 → 追加新楼
            if (text.trim()) await appendAssistantMessage(chat.charDir, chat.chatName, charName, text, { jobId, aborted });
            return;
        }
        if (type === 'regenerate') {
            await patchChat(chat.charDir, chat.chatName,
                [{ op: 'replace', path: `/body/${lastIdx}`, value: mkAssistantFloor(charName, text, { jobId, aborted }) }],
                { lukerGenerationId: jobId });
            return;
        }
        const ops: ChatPatchOp[] = [];
        const abortedOps = () => {
            if (!aborted) return;
            if (floor.extra && typeof floor.extra === 'object') ops.push({ op: 'add', path: `/body/${lastIdx}/extra/aborted`, value: true });
            else ops.push({ op: 'add', path: `/body/${lastIdx}/extra`, value: { aborted: true } });
        };
        if (type === 'swipe') {
            const info = { send_date: new Date().toISOString(), gen_started: null, gen_finished: null, extra: {} };
            if (Array.isArray(floor.swipes)) {
                ops.push({ op: 'add', path: `/body/${lastIdx}/swipes/-`, value: text });
                ops.push({ op: 'replace', path: `/body/${lastIdx}/swipe_id`, value: floor.swipes.length });
                if (Array.isArray(floor.swipe_info)) ops.push({ op: 'add', path: `/body/${lastIdx}/swipe_info/-`, value: info });
                else ops.push({ op: 'add', path: `/body/${lastIdx}/swipe_info`, value: [...floor.swipes.map(() => ({})), info] });
            } else {
                ops.push({ op: 'add', path: `/body/${lastIdx}/swipes`, value: [floor.mes ?? '', text] });
                ops.push({ op: 'replace', path: `/body/${lastIdx}/swipe_id`, value: 1 });
                ops.push({ op: 'add', path: `/body/${lastIdx}/swipe_info`, value: [{ send_date: floor.send_date, extra: floor.extra ?? {} }, info] });
            }
            ops.push({ op: 'replace', path: `/body/${lastIdx}/mes`, value: text });
            abortedOps();
        } else if (type === 'continue') {
            const next = String(floor.mes ?? '') + text;
            ops.push({ op: 'replace', path: `/body/${lastIdx}/mes`, value: next });
            const sid = Number(floor.swipe_id ?? 0);
            if (Array.isArray(floor.swipes) && floor.swipes.length > sid) {
                ops.push({ op: 'replace', path: `/body/${lastIdx}/swipes/${sid}`, value: next });
            }
            abortedOps();
        }
        if (ops.length) await patchChat(chat.charDir, chat.chatName, ops, { lukerGenerationId: jobId });
    }, [s.chat, s.cards]);

    /* ——— 生成主路:postGenerate + streamJob resume → 写回 → reload ——— */
    /* 自动命名:默认时间戳名(YYYY-M-D @HHh MMm SSs,createChatFor 同槽)
       的会话在首轮回复落定后 → 取首条 user 楼前 12 字改名;改名即换
       chatName,模式串脱配天然只跑一次。无 user 楼/群会话不碰。 */
    const AUTO_NAME_RE = /^\d{4}-\d{1,2}-\d{1,2} @\d{2}h \d{2}m \d{2}s$/;
    const maybeAutoName = useCallback(() => {
        const chat = s.chat;
        if (!chat || chat.groupId || !AUTO_NAME_RE.test(chat.chatName)) return;
        const firstUser = msgs.find((m) => m.role === 'user' && (m.content ?? '').trim());
        const snippet = (firstUser?.content ?? '').trim().replace(/\s+/g, ' ').slice(0, 12);
        if (snippet) s.renameChat(chat, snippet);
    }, [s, msgs]);

    const runGenerate = useCallback(async (type: GenerateVerb) => {
        const chat = s.chat;
        if (!chat || busy) return;
        /* 群分支(TASK-062):服务端 groupId 编排路;单路原样。 */
        if (chat.groupId) return runGroupGenerate(type);
        const imp = type === 'impersonate';
        const floorId = imp ? Number.NaN : --transientRef.current;
        const charName = s.cards.get(chat.charDir)?.name ?? chat.charDir;
        if (!imp) {
            setMsgs((prev) => [...prev, { id: floorId, role: 'assistant', name: charName, content: '', streaming: true, timestamp: Date.now() }]);
        }
        setBusy(true);
        accRef.current = '';
        try {
            const fallbackUser = s.currentUser?.name || s.currentUser?.handle || 'User';
            const presetClean = s.activePresetId ? s.activePresetId.replace(/\.json$/i, '') : undefined;
            const body: GenerateBody = {
                charDir: chat.charDir,
                chatName: chat.chatName,
                type,
                ...(presetClean ? { presetName: presetClean } : {}),
                user: s.persona ? { name: s.persona.name, description: s.persona.description } : { name: fallbackUser },
            };
            const { jobId } = await postGenerate(body);
            setJob({ id: jobId, type, floorId });
            const res = await new Promise<{ text: string; error?: string }>((resolve) => {
                const settle = (r: { text: string; error?: string }) => {
                    if (settleRef.current !== settle) return;
                    settleRef.current = null;
                    resolve(r);
                };
                settleRef.current = settle;
                streamJob(jobId, {
                    onDelta: (acc) => {
                        accRef.current = acc;
                        if (imp) setDraft(acc);
                        else patchFloor(floorId, { content: acc });
                    },
                    onEnd: () => settle({ text: accRef.current }),
                    onError: (message) => settle({ text: accRef.current, error: message }),
                }).then((close) => { wsClose.current = close; })
                    .catch((e) => settle({ text: accRef.current, error: errText(e) }));
            });
            const aborted = abortingRef.current === jobId;
            if (aborted) {
                if (imp) {
                    /* 草稿已留在输入框,无楼可标 */
                } else if (res.text.trim()) {
                    patchFloor(floorId, { streaming: false, aborted: true });
                    try { await writeBackGeneration(type, res.text, jobId, true); await reload(); }
                    catch (e) { s.hint(t('stage.patch.failed') + ': ' + errText(e), true); }
                } else {
                    setMsgs((prev) => prev.filter((m) => m.id !== floorId));
                }
            } else if (res.error !== undefined) {
                if (imp) {
                    pushErrorFloor({ code: 'job_error', message: res.error, jobId, retry: { type } });
                } else {
                    patchFloor(floorId, {
                        streaming: false,
                        error: { code: 'job_error', message: res.error, jobId, retry: { type } },
                    });
                }
            } else {
                if (!imp) setMsgs((prev) => prev.filter((m) => m.id !== floorId));
                try { await writeBackGeneration(type, res.text, jobId, false); await reload(); }
                catch (e) {
                    s.hint(t('stage.patch.failed') + ': ' + errText(e), true);
                    void reload();
                }
                /* 自动命名:默认时间戳名 + 首轮回复落定 → 取首条 user 楼
                   前 12 字改名(改名即换 key,模式串脱配,天然只跑一次)。 */
                maybeAutoName();
            }
            void refreshTokens(jobId);
            void refreshMvu();
        } catch (e) {
            const message = errText(e);
            const code = errCode(e);
            if (imp) {
                pushErrorFloor({ code, message, retry: { type } });
            } else {
                patchFloor(floorId, { streaming: false, error: { code, message, retry: { type } } });
            }
        } finally {
            abortingRef.current = '';
            settleRef.current = null;
            wsClose.current = null;
            setJob(null);
            setBusy(false);
        }
    }, [s, busy, patchFloor, reload, writeBackGeneration, runGroupGenerate, refreshTokens, refreshMvu, maybeAutoName, t]);

    /* ——— QR/斜杠文本:斜杠指令走真服务端 STscript runner(楼层副作用
     *     env 已落库 → 跑完 reload);非斜杠 = 普通用户输入 ——— */
    const runScript = useCallback(async (script: string) => {
        const chat = s.chat;
        if (!s.live || !chat || busy) return;
        setBusy(true);
        try {
            /* 群会话:stscript-env 绑卡域聊天(群键显式跳过,该域本任务不动)
               → 脚本以无会话 env 跑;要绑楼的命令吃服务端结构化 error,
               照实 hint —— 不假装绑上群聊。 */
            const body = chat.groupId
                ? { script }
                : { charDir: chat.charDir, chatName: chat.chatName, script };
            let res = await apiPost<ScriptRunRes>('/api/utopinn/script/run', body);
            /* TASK-069 挂起回执环:awaiting → 模态驻留等用户 → interact
               兑现 → 可能再 awaiting(多轮交互)直至终态。弹层 promise
               自带 finally 清场,interact 抛错由外层 catch 兜底。 */
            while (res.awaiting) {
                const a = res.awaiting;
                let reply: ScriptInteractReply;
                try {
                    reply = await new Promise<ScriptInteractReply>((resolve) => {
                        scriptDlgResolve.current = resolve;
                        setScriptAwait(a);
                    });
                } finally {
                    scriptDlgResolve.current = null;
                    setScriptAwait(null);
                }
                res = await apiPost<ScriptRunRes>('/api/utopinn/script/interact', {
                    runId: a.runId, action: reply.action, value: reply.value,
                });
            }
            for (const n of res.notifications ?? []) {
                if (n?.text) s.hint(String(n.text), n.severity === 'error' || n.severity === 'warning');
            }
            // TASK-064:结构化 error 回执(/del /swipe 等命令失败)→ hint 行,
            // 原先是裸 HTTP 500 只出 'stage.script.failed'。
            if (res.error?.message) {
                const at = res.error.commandName ? ` /${res.error.commandName}` : '';
                s.hint(`${res.error.code ?? 'error'}${at}: ${res.error.message}`, true);
            }
            if (typeof res.pipe === 'string' && res.pipe.trim()) s.hint(res.pipe.trim());
            /* TASK-069 回执面:阻塞 /popup /input /buttons 走 awaiting
               模态(上)已真渲;残余 sink —— showPopup(非阻塞 toast
               语义)→ 逐条 hint;setinput(草稿填充语义)→ 写回
               composer draft(上游 setInput 同款副作用)。 */
            for (const p of res.popups ?? []) {
                const text = typeof p === 'string' ? p : (p && typeof p === 'object' ? String((p as { text?: unknown }).text ?? '') : '');
                if (text.trim()) s.hint(text.trim());
            }
            for (const i of res.inputs ?? []) {
                const text = typeof i === 'string' ? i : (i && typeof i === 'object' ? String((i as { text?: unknown }).text ?? '') : '');
                /* setinput 回执写 draft —— 命令 chip 若驻留会被写成
                   `/<cmd> <填充文本>` 怪串,顺手清掉。 */
                if (text) { setDraft(text); setPendingCmd(null); }
            }
            await reload();
            void refreshMvu();
        } catch (e) {
            /* 挂起中被打断(interact 404/网络)→ 卸弹层,resolve 已随
               finally 置空,不残留死 promise。 */
            scriptDlgResolve.current = null;
            setScriptAwait(null);
            s.hint(t('stage.script.failed') + ': ' + errText(e), true);
        } finally {
            setBusy(false);
        }
    }, [s, busy, t, reload, refreshMvu]);

    /* ——— 发送 ——— */
    const send = useCallback(async (text: string, forceCmd = false) => {
        const v = text.trim();
        if (!v || busy || offline || (s.live && !s.chat)) return;
        /* STscript 路由(上游 processCommands 同义:trim 后 / 起头整条当脚本,
           不落成用户消息):
             // 起头 = 注释命令(parser 收为空操作,原样透传服务端)
             \/ 起头 = 不路由,原样当文本(上游无输入层转义,不剥反斜杠)
             裸 '/' = 菜单触发态,不发不跑
             /continue = QR chip 同款快路径(上游 /continue 本就是客户端续写命令)
           总闸关掉(utopinn.slash.enabled='0')→ / 起头不按脚本路由,整条当
           普通文本发(「不使用」语义,不是拦截);forceCmd = chip 显式选定命令
           的提交,绕过环境闸 —— 用户明摆着要跑这条命令。 */
        if (v === '/' && slashPrefs.enabled) return;
        setDraft('');
        setMenu('none');
        setPendingCmd(null);
        if (v.startsWith('/') && (slashPrefs.enabled || forceCmd)) {
            /* token 边界:/continue、/continue <args> 走续写快路径;
               /continueX 是另一命令名,仍透传服务端吃 error 回执。 */
            if (/^\/continue(?:\s|$)/i.test(v)) { void runGenerate('continue'); return; }
            if (!s.live || !s.chat) { s.hint(t('status.stub')); return; }
            void runScript(v);
            return;
        }
        if (!s.live || !s.chat) {
            mockStagePush(stageKind, v);
            setBusy(true);
            setTimeout(() => { mockStageReply(stageKind, mockReplyFor(stageKind)); setBusy(false); }, 600);
            return;
        }
        const chat = s.chat;
        const senderName = s.persona?.name || s.currentUser?.name || s.currentUser?.handle || 'User';
        const uid = transientRef.current - 1;
        transientRef.current = uid;
        setMsgs((prev) => [...prev, { id: uid, role: 'user', name: senderName, content: v, timestamp: Date.now() }]);
        setBusy(true);
        try {
            /* 群路:用户楼先落(服务端 deriveActivationInput 读它判 isUserInput),
               再群编排生成 —— 与单聊同款次序。 */
            if (chat.groupId) await appendGroupUserMessage(chat.groupId, chat.chatName, senderName, v);
            else await appendUserMessage(chat.charDir, chat.chatName, senderName, v);
            setBusy(false);
            void runGenerate('normal');
        } catch (e) {
            pushErrorFloor({ code: errCode(e), message: errText(e), retry: { type: 'send', text: v } });
            setBusy(false);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [busy, offline, s, runGenerate, runScript, t, stageKind, mockStagePush, mockStageReply, slashPrefs.enabled]);

    /* ——— 中止:POST /api/utopinn/jobs/:id/abort(走 api/jobs.ts 面;
     *     服务端中止后 WS 未必回终帧 → settleRef 本地兜底 + 关 socket) ——— */
    const onStop = useCallback(async () => {
        const j = job;
        if (!j) return;
        abortingRef.current = j.id;
        try {
            await abortJob(j.id);
        } catch (e) {
            abortingRef.current = '';
            s.hint(errText(e), true);
            return;
        }
        settleRef.current?.({ text: accRef.current });
        wsClose.current?.();
    }, [job, s]);

    /* ——— swipe ‹ › 与绝对跳版(分支选项直跳同一实现) ——— */
    const swipeTo = useCallback(async (m: FloorMsg, next: number) => {
        const count = m.swipes?.length ?? 0;
        const active = m.activeSwipe ?? 0;
        if (next === active) return;
        if (next >= count) {
            // 末版 › = 再生成一版:只对末楼有意义(服务端 swipe 弹末层)
            const lastAi = msgs.reduce((acc, x, i) => (x.role === 'assistant' && !x.error ? i : acc), -1);
            if (msgs.indexOf(m) !== lastAi) { s.hint(t('stage.swipe.needLast'), true); return; }
            void runGenerate('swipe');
            return;
        }
        if (next < 0) return;
        const content = m.swipes?.[next]?.content ?? m.content;
        /* reasoning 跟 swipe 走(swipe_info[i].extra 各自独立 —— 不换槽会留旧版推理) */
        patchFloor(m.id, { activeSwipe: next, content, reasoning: m.swipes?.[next]?.reasoning });
        if (s.live && s.chat && m.id >= 0) {
            try {
                if (s.chat.groupId) await patchGroupSwipe(s.chat.groupId, s.chat.chatName, m.id, next);
                else await patchSwipe(s.chat.charDir, s.chat.chatName, m.id, next);
                void refreshMvu();
            }
            catch (e) {
                patchFloor(m.id, { activeSwipe: active, content: m.content, reasoning: m.reasoning });
                s.hint(t('stage.patch.failed') + ': ' + errText(e), true);
            }
        }
    }, [msgs, s, patchFloor, runGenerate, refreshMvu, t]);

    const onSwipe = useCallback((m: FloorMsg, dir: -1 | 1) => {
        void swipeTo(m, (m.activeSwipe ?? 0) + dir);
    }, [swipeTo]);

    const onSwipeTo = useCallback((m: FloorMsg, index: number) => {
        void swipeTo(m, index);
    }, [swipeTo]);

    /* ——— 楼操作 ——— */
    /* 「引用」:楼层展示文本(markdown `> ` 逐行)置顶进 composer 草稿,
       已有草稿接在其后 —— 用户补「改这段」类指令即发送。 */
    const onQuote = useCallback((m: FloorMsg) => {
        const src = (m.displayContent ?? m.content).trim();
        if (!src) return;
        const block = src.split('\n').map((l) => `> ${l}`).join('\n') + '\n\n';
        setDraft((prev) => block + prev);
        /* 引用块前置后 draft 必非 / 起头 —— slash 菜单若开着顺手收掉,
           命令 chip 也摘掉(参数区已被引用块占用,chip 拼回会成怪串)。 */
        setMenu('none');
        setPendingCmd(null);
        draftTaRef.current?.focus();
    }, []);

    const onCopy = useCallback((m: FloorMsg) => {
        void navigator.clipboard?.writeText(m.displayContent ?? m.content).then(() => s.hint(t('stage.op.copied'))).catch(() => s.hint(t('stage.op.copyFailed'), true));
    }, [s, t]);

    /* PATCH 路径一律用 m.id(= getChat 时的 body 下标);数组下标会
       被 transient 错误楼(负 id)顶偏,不能当服务端楼号使。 */
    const onDelete = useCallback(async (m: FloorMsg) => {
        if (s.chatSettings.confirmDelete && !window.confirm(t('stage.op.delConfirm'))) return;
        setMsgs((prev) => prev.filter((x) => x.id !== m.id));
        if (s.live && s.chat && m.id >= 0) {
            try {
                if (s.chat.groupId) await patchGroupChat(s.chat.groupId, s.chat.chatName, [{ op: 'remove', path: `/body/${m.id}` }]);
                else await patchChat(s.chat.charDir, s.chat.chatName, [{ op: 'remove', path: `/body/${m.id}` }]);
                void refreshMvu();
            } catch (e) {
                s.hint(t('stage.patch.failed') + ': ' + errText(e), true);
                void reload();
            }
        }
    }, [s, t, reload, refreshMvu]);

    const onSaveEdit = useCallback(async (m: FloorMsg) => {
        const text = editing?.text ?? '';
        setEditing(null);
        patchFloor(m.id, {
            content: text,
            displayContent: undefined,
            swipes: m.swipes?.map((sw, i) => (i === m.activeSwipe ? { ...sw, content: text } : sw)),
        });
        if (s.live && s.chat && m.id >= 0) {
            const ops: ChatPatchOp[] = [{ op: 'replace', path: `/body/${m.id}/mes`, value: text }];
            if (m.swipes && m.activeSwipe !== undefined) {
                ops.push({ op: 'replace', path: `/body/${m.id}/swipes/${m.activeSwipe}`, value: text });
            }
            /* 保存后 reload —— 本地 content 是编辑原文,重拉让 regex 展示
               投影重新生效(顺带刷新 m.raw,再编时种子仍是真原文)。 */
            try {
                if (s.chat.groupId) await patchGroupChat(s.chat.groupId, s.chat.chatName, ops);
                else await patchChat(s.chat.charDir, s.chat.chatName, ops);
                void refreshMvu(); void reload();
            }
            catch (e) {
                s.hint(t('stage.patch.failed') + ': ' + errText(e), true);
                void reload();
            }
        }
    }, [s, editing, t, patchFloor, reload, refreshMvu]);

    /* ——— 新建分支(TASK-065 fork):从该楼直岔新会话 —— POST fork 深拷贝
     *     header + 0..id 楼层(整楼 swipe 组随拷贝),原会话不动;岔出即跳。
     *     瞬态楼(负 id)不占 body 位,不出钮也拦双保险。 ——— */
    const onForkFloor = useCallback(async (m: FloorMsg) => {
        const chat = s.chat;
        if (!s.live || !chat || m.id < 0 || forkBusy !== null) return;
        setForkBusy(m.id);
        try {
            const res = await forkChat(chat.charDir, chat.chatName, { messageId: m.id });
            await s.refreshChats();
            s.selectChat(`${chat.charDir}/${res.name}`);
            s.hint(t('bk.forked'));
        } catch (e) {
            s.hint(`${t('bk.failed')}: ${errText(e)}`, true);
        } finally {
            setForkBusy(null);
        }
    }, [s, t, forkBusy]);

    /* 「跳回该层」:发一次性请求,消费在形态体(chat 楼层列展开+滚动);
       弹层顺手收掉。 */
    const requestJump = useCallback((floor: number) => {
        setJumpReq({ floor, seq: Date.now() });
        setMenu('none');
    }, []);

    /* ——— 回滚:PATCH 删 m.id 之后的所有服务端楼(瞬态楼不占 body 位),
     *     再 settleMvu(m.id) 恢复该楼 MVU 快照 ——— */
    const onRewind = useCallback(async (m: FloorMsg) => {
        const chat = s.chat;
        const target = mvuTarget(chat);
        if (!s.live || !chat || !target || m.id < 0) return;
        if (!window.confirm(t('stage.op.rewindConfirm'))) return;
        const tail = msgs.filter((x) => x.id > m.id).length;
        const ops: ChatPatchOp[] = Array.from({ length: tail }, () => ({ op: 'remove' as const, path: `/body/${m.id + 1}` }));
        try {
            if (ops.length) {
                if (chat.groupId) await patchGroupChat(chat.groupId, chat.chatName, ops);
                else await patchChat(chat.charDir, chat.chatName, ops);
            }
            await settleMvu(target, { message_index: m.id });
            await reload();
            void refreshMvu();
            s.hint(t('stage.rewind.done'));
        } catch (e) {
            s.hint(t('stage.rewind.failed') + ': ' + errText(e), true);
            void reload();
        }
    }, [s, msgs, t, reload, refreshMvu]);

    const onRetry = useCallback((m: FloorMsg) => {
        const r = m.error?.retry;
        if (!r) return;
        setMsgs((prev) => prev.filter((x) => x.id !== m.id));
        if (r.type === 'send' && r.text) void send(r.text);
        else if (r.type !== 'send') void runGenerate(r.type as GenerateVerb);
    }, [send, runGenerate]);

    const onMvuSync = useCallback(async () => {
        const target = mvuTarget(s.chat);
        if (!s.live || !target) { s.hint(t('status.stub')); return; }
        try {
            await settleMvu(target);
            void refreshMvu();
            s.hint(t('stage.mvu.synced'));
        } catch (e) {
            s.hint(t('stage.mvu.failed') + ': ' + errText(e), true);
        }
    }, [s, t, refreshMvu]);

    const onSlash = useCallback((key: string) => {
        setMenu('none');
        setPendingCmd(null);
        /* 菜单执行类快捷项落地时,`/`-前缀的半截脚本草稿作废(用户已选动作)。 */
        setDraft((d) => (d.startsWith('/') ? '' : d));
        if (!s.live || !s.chat) {
            if (key === 'impersonate') { setDraft(MOCK_IMPERSONATE_DRAFT); return; }
            if (key === 'mvu') { s.hint(t('status.stub')); return; }
            setBusy(true);
            setTimeout(() => { mockStageReply(stageKind, mockReplyFor(stageKind)); setBusy(false); }, 500);
            return;
        }
        if (busy) return;
        if (key === 'continue') void runGenerate('continue');
        else if (key === 'regen') void runGenerate('regenerate');
        else if (key === 'impersonate') void runGenerate('impersonate');
        else if (key === 'mvu') void onMvuSync();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [s, busy, runGenerate, onMvuSync, t, stageKind, mockStageReply]);

    /* ——— 斜杠偏好写面(localStorage utopinn.slash.*)——— */
    const mutSlashPrefs = useCallback((fn: (p: SlashPrefs) => SlashPrefs) => {
        setSlashPrefs((p) => { const n = fn(p); saveSlashPrefs(n); return n; });
    }, []);
    const toggleSlashEnabled = useCallback(() => {
        mutSlashPrefs((p) => ({ ...p, enabled: !p.enabled }));
        /* 关停即退出命令态:chip 还原成文本草稿,内容不丢。 */
        if (pendingCmd) {
            const args = draft.trim();
            setPendingCmd(null);
            setDraft(`/${pendingCmd}${args ? ` ${args}` : ''}`);
        }
    }, [mutSlashPrefs, pendingCmd, draft]);
    const toggleGroupOpen = useCallback((g: SlashGroupKey) =>
        mutSlashPrefs((p) => ({ ...p, open: p.open.includes(g) ? p.open.filter((x) => x !== g) : [...p.open, g] })), [mutSlashPrefs]);
    const setGroupHidden = useCallback((g: SlashGroupKey, hide: boolean) =>
        mutSlashPrefs((p) => ({ ...p, hidden: hide ? [...p.hidden, g] : p.hidden.filter((x) => x !== g) })), [mutSlashPrefs]);

    /* 草稿改值后把光标放回末尾(focus 不带选区移动)。 */
    const focusDraftEnd = useCallback(() => {
        requestAnimationFrame(() => {
            const ta = draftTaRef.current;
            if (!ta) return;
            ta.focus();
            const n = ta.value.length;
            ta.setSelectionRange(n, n);
        });
    }, []);

    /* 命令选定落 chip:菜单点选/Tab/Enter 把命令词锁成 coral chip,
       draft 只剩参数区(`/` 片段作废;普通正文留作参数种子 ——
       原补全行为是整段顶掉,chip 语义下保住更诚实);不执行 ——
       Enter 才跑。 */
    const pickCommand = useCallback((name: string) => {
        setPendingCmd(name);
        setDraft((d) => (d.startsWith('/') ? '' : d));
        setMenu('none');
        setSlashHi(0);
        focusDraftEnd();
    }, [focusDraftEnd]);

    /* 退出命令态两种手感:
       reopen=true(参数空 + Backspace)→ chip 化回 `/name` 文本、菜单
         重开仍过滤在 name —— 像「撤销选定」,可继续改名或再退;
       reopen=false(Esc)→ 还原成 `/name args` 原始文本,所见即所发。 */
    const dissolveChip = useCallback((reopen: boolean) => {
        const cmd = pendingCmd;
        if (!cmd) return;
        const args = draft.trim();
        setPendingCmd(null);
        setDraft(reopen ? `/${cmd}` : `/${cmd}${args ? ` ${args}` : ''}`);
        if (reopen) { setMenu('slash'); setSlashHi(0); }
        focusDraftEnd();
    }, [pendingCmd, draft, focusDraftEnd]);

    /* chip+参数 → 发送载荷;无 chip 时就是 draft 本体。 */
    const composerPayload = pendingCmd
        ? `/${pendingCmd}${draft.trim() ? ` ${draft.trim()}` : ''}`
        : draft;
    const submitDraft = useCallback(() => {
        void send(composerPayload, !!pendingCmd);
    }, [send, composerPayload, pendingCmd]);

    /* draft 的 `/` 前缀解析(上游 trim().startsWith('/') 同语义):
       token = `/` 后首个空白前的命令词(菜单按它前缀过滤);
       inArgs = token 后已有空白 → 精确命中才显示(签名卡参考)。 */
    const slashActive = draft.startsWith('/');
    const slashToken = slashActive ? (draft.slice(1).match(/^\S*/)?.[0] ?? '') : null;
    const slashInArgs = slashActive && /\s/.test(draft.slice(1));
    const visibleCmds = useMemo(() => {
        if (slashToken === null) return scriptCmds;
        const q = slashToken.toLowerCase();
        const match = (c: ScriptCommandInfo, pred: (n: string) => boolean) =>
            pred(c.name.toLowerCase()) || c.aliases.some((a) => pred(a.toLowerCase()));
        return slashInArgs
            ? scriptCmds.filter((c) => match(c, (n) => n === q))
            : scriptCmds.filter((c) => match(c, (n) => n.startsWith(q)));
    }, [scriptCmds, slashToken, slashInArgs]);
    /* 菜单实际展示的注册表行 —— 草稿有非 `/` 正文时为空
       (补全语境只在空草稿或 `/` 草稿下成立),键盘导航同表。 */
    const menuCmds = draft === '' || slashToken !== null ? visibleCmds : [];
    /* 平铺 = 补全语境(正在打 token 或已进参数区)→ 无组头,过滤结果直列;
       分组 = 仅 `/` 或 `/` 钮开的全量视图 → 折成组头,open 组才展开。
       导航行(组头+命令行)同供键盘 ↑↓/Enter/Tab 与菜单渲染。 */
    const slashFlat = slashInArgs || (slashToken !== null && slashToken.length > 0);
    const slashNav = buildSlashNav(menuCmds, { flat: slashFlat, prefs: slashPrefs });
    const navRows = slashNav.rows;
    const navHi = Math.min(Math.max(slashHi, 0), Math.max(0, navRows.length - 1));

    const opsOf = (m: FloorMsg, idx: number): FloorOps => ({
        isLast: idx === msgs.length - 1,
        editing,
        onSwipe: (mm, dir) => onSwipe(mm, dir),
        onSwipeTo: (mm, i) => onSwipeTo(mm, i),
        onCopy,
        onQuote,
        /* 编辑框种子=存储原文(ST:编辑框给原文)—— content 槽是 GH#3 展示
           投影文本,直接用会把投影烤进 mes/swipes[k]。 */
        onEdit: (mm) => setEditing({ id: mm.id, text: floorRawText(mm) }),
        onEditText: (text) => setEditing((prev) => (prev ? { ...prev, text } : prev)),
        onSaveEdit: (mm) => void onSaveEdit(mm),
        onCancelEdit: () => setEditing(null),
        onDelete: (mm) => void onDelete(mm),
        onRewind: (mm) => void onRewind(mm),
        onForkFloor: (mm) => void onForkFloor(mm),
        onRetry,
        // 错误楼「查看 Trace」→ 该楼 jobId 的 trace 页;无 jobId(发送失败)
        // 落 jobs 列表让人自己找 —— 不复用上次 trace 现场,避免看错 job。
        onTrace: (mm) => s.openPanel('diag', mm.error?.jobId ? diagTraceParams(mm.error.jobId) : { sub: 'jobs' }),
        onContinue: () => void runGenerate('continue'),
    });

    const engine: StageEngine = {
        msgs, loadErr, opsOf, reload,
        send: (text) => void send(text),
        advance: () => void runGenerate('normal'),
        jump: jumpReq, requestJump,
    };

    const effectiveCtxLen = ctxLen ?? s.presetParams.ctxLen;
    const tokenPct = lastTokens != null && effectiveCtxLen > 0 ? Math.min(100, Math.round((lastTokens / effectiveCtxLen) * 100)) : 0;

    /* 册存在即有行(chip 区在册未启用时换成行内启用 CTA —— 启停是持久面,
       最短恢复路径留在原处);弹层开着时行保留,遮罩负责收口。 */
    const qrSelOn = qrSel !== '' && qrEnabled.has(qrSel);
    const qrVisible = qrOpen && qrNames.length > 0 && (menu === 'none' || qrPick) && stageKind === 'chat';
    /* 弹层抬升量看「QR 开关态」而非可见态 —— 规范稿弹层打开时 QR 条隐藏,
       但弹层锚位仍按 quickRepliesOpen 抬(126/92 桌面,122/88 移动)。 */
    const qrSpace = qrOpen && qrNames.length > 0 && stageKind === 'chat';
    const card = s.chat ? s.cards.get(s.chat.charDir) : undefined;
    const headerAvatar = card?.avatar ? charImageUrl(card.avatar) : builtinCoverSrc(s.chat?.charDir ?? '');
    /* 群会话(TASK-062):roster 可载成员数(禁/缺卡照实显示在 GroupPop)。 */
    const groupRoster = groupDoc?.roster ?? [];
    const groupActiveCount = groupRoster.filter((m) => !m.disabled && m.loadable).length;
    /* 舞台头读数(TASK-026):persona 当前项 + 卡绑定资产 + 激活预设 ——
       全部真值;读不到的面(chip 数据源缺席)照实不画,不凑数。 */
    const personaItem = s.personas.find((p) => p.avatar === s.persona?.avatar);
    /* 本会话立绘绑定(TASK-067):chip + 楼层头像共用此读数。 */
    const boundEmote = useBoundEmote(s.chat?.id);
    const charDocData = cardData(charDoc);
    const stageChipCls = 'inline-flex h-7 min-w-0 max-w-[150px] items-center gap-1.5 rounded-full border border-[color:var(--border-hairline)] bg-[color:var(--bg-surface)] px-2.5 text-[12px] text-[color:var(--fg-secondary)] transition-colors hover:bg-[color:var(--bg-active)] hover:text-[color:var(--fg-primary)]';
    return (
        <EngineCtx.Provider value={engine}>
            <section
                className="relative flex min-h-0 min-w-0 flex-1 flex-col"
                style={{
                    background: 'var(--bg-canvas)',
                    ['--composer-pop-bottom' as never]: qrSpace ? (s.isMobile ? '122px' : '126px') : (s.isMobile ? '88px' : '92px'),
                    ['--slash-pop-bottom' as never]: qrSpace ? '128px' : '94px',
                }}
            >
                {/* 规范稿 stage-header h-12 px-4:左 ctx 钮(卡环+名·题+⌄)→ ctx 弹层;右 wb/移动 sheet 钮 */}
                <header className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-[color:var(--border-hairline)] px-4">
                    <div className="flex min-w-0 items-center gap-1.5">
                        {/* 规范稿移动端 stage-header 左侧 ≡ → mob drawer */}
                        {s.isMobile && (
                            <button className="ghost-btn h-8 w-8 shrink-0" onClick={() => s.setMobileDrawer(true)} title={t('mob.menu')}>
                                <Icon name="menu" size={20} active={s.mobileDrawer} />
                            </button>
                        )}
                        {/* 标题钮 → 会话信息弹层(改名/元信息);群会话 → 群名册/编排弹层。 */}
                        <button
                            className="heading-tight flex min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-[14px] font-medium transition-colors hover:bg-[color:var(--bg-surface)]"
                            onClick={() => {
                                if (!s.chat) return;
                                if (s.chat.groupId) setMenu(menu === 'group' ? 'none' : 'group');
                                else setMenu(menu === 'info' ? 'none' : 'info');
                            }}
                            title={s.chat?.groupId ? t('group.roster') : t('chat.info')}
                        >
                            {s.chat?.groupId ? (
                                <span className="char-avatar-ring flex h-7 w-7 shrink-0 items-center justify-center"><Icon name="users" size={16} /></span>
                            ) : (
                                <span className="char-avatar-ring h-7 w-7 shrink-0"><img src={headerAvatar} alt="" className="h-full w-full object-cover" onError={charImgFallback} data-cover-key={s.chat?.charDir ?? ''} /></span>
                            )}
                            <span className="truncate text-[color:var(--fg-primary)]">
                                {s.chat ? (s.chat.title || s.chat.chatName) : t('chat.none')}
                            </span>
                        </button>
                        {/* 群成员数 chip(可载且未禁 = 会说话的;详情在弹层)。 */}
                        {s.chat?.groupId && groupDoc && (
                            <button
                                type="button"
                                className={stageChipCls}
                                title={t('group.roster')}
                                onClick={() => setMenu(menu === 'group' ? 'none' : 'group')}
                            >
                                <Icon name="users" size={11} /><span className="truncate">{groupActiveCount}/{groupRoster.length}</span>
                            </button>
                        )}
                        {/* persona 快切徽标(TASK-026):头像+名+⌄ → PersonaPop;
                            无人设目录时不画(诚实空,不占假名)。 */}
                        {s.personas.length > 0 && (
                            <button
                                type="button"
                                className="flex h-7 max-w-[150px] shrink-0 items-center gap-1.5 rounded-full border border-[color:var(--border-hairline)] bg-[color:var(--bg-surface)] py-1 pl-1 pr-2 text-[11.5px] text-[color:var(--fg-secondary)] transition-colors hover:bg-[color:var(--bg-active)] hover:text-[color:var(--fg-primary)]"
                                onClick={() => setMenu(menu === 'persona' ? 'none' : 'persona')}
                                title={t('ctx.persona')}
                            >
                                <img
                                    src={personaAvatarSrc(s.persona?.avatar, personaItem?.hasImage)}
                                    alt=""
                                    className="h-5 w-5 shrink-0 rounded-full object-cover"
                                    onError={(e) => { e.currentTarget.src = '/assets/avatars/user-redpanda.png'; }}
                                />
                                <span className="truncate">{s.persona?.name || s.currentUser?.name || s.currentUser?.handle || 'User'}</span>
                                <span className="shrink-0"><Icon name="chevronDown" size={11} /></span>
                            </button>
                        )}
                        {/* 立绘 chip(TASK-067):绑定态显 sprite 图,未绑显图标;
                            点击开 EmotesPop 选格绑定。无会话不画。
                            群会话无单卡绑定位 —— 不画,不假装成员共用一套立绘。 */}
                        {s.chat && !s.chat.groupId && (
                            <button
                                type="button"
                                className="flex h-7 max-w-[110px] shrink-0 items-center gap-1.5 rounded-full border border-[color:var(--border-hairline)] bg-[color:var(--bg-surface)] py-1 pl-1 pr-2 text-[11.5px] text-[color:var(--fg-secondary)] transition-colors hover:bg-[color:var(--bg-active)] hover:text-[color:var(--fg-primary)]"
                                onClick={() => setMenu(menu === 'emotes' ? 'none' : 'emotes')}
                                title={t('stage.emotes.title')}
                            >
                                {boundEmote ? (
                                    <img src={boundEmote.url} alt="" className="h-5 w-5 shrink-0 rounded-full object-cover" />
                                ) : (
                                    <span className="flex h-5 w-5 shrink-0 items-center justify-center"><Icon name="image" size={13} /></span>
                                )}
                                <span className="truncate">{boundEmote?.label ?? t('stage.emotes.title')}</span>
                            </button>
                        )}
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                        {/* 会话置顶:accountStorage.pinnedChats 写面(ST 同槽)——
                            顶栏直钮,群会话无 pin 面不画,不假装。 */}
                        {s.chat && s.live && !s.chat.groupId && (
                            <button
                                className="ghost-btn h-8 w-8"
                                style={s.chat.pinned ? { color: 'var(--brand)' } : undefined}
                                title={s.chat.pinned ? t('chat.unpin') : t('chat.pin')}
                                onClick={() => s.togglePin(s.chat!)}
                            >
                                <Icon name="pin" size={16} active={!!s.chat.pinned} />
                            </button>
                        )}
                        {/* 会话导出(TASK-067):GET /export/chat → ST JSONL 附件。
                            群会话导出面未接(utopinn 导出是卡域)→ 不画。 */}
                        {s.chat && s.live && !s.chat.groupId && (
                            <button
                                className="ghost-btn h-8 w-8"
                                title={t('stage.export.chat')}
                                onClick={() => { void downloadExport(exportChatUrl(s.chat!.charDir, s.chat!.chatName)); }}
                            >
                                <Icon name="upload" size={16} />
                            </button>
                        )}
                        {s.isMobile ? (
                            <button
                                className="ghost-btn h-8 gap-1.5 border px-3 text-[12px] text-[color:var(--fg-primary)]"
                                style={{
                                    borderRadius: 999,
                                    background: s.sheetSnap !== 'closed' ? 'var(--bg-active)' : 'var(--bg-surface)',
                                    borderColor: s.sheetSnap !== 'closed' ? 'var(--border-bold)' : 'var(--border-hairline)',
                                }}
                                onClick={() => s.setSheetSnap(s.sheetSnap === 'closed' ? 'half' : 'closed')}
                            >
                                <Icon name="panelRight" size={15} active={s.sheetSnap !== 'closed'} /><span>{t('mob.panel')}</span>
                            </button>
                        ) : (
                            <button className="ghost-btn h-8 w-8" onClick={s.toggleWorkbench} title={t('chrome.workbench')}>
                                <Icon name="panelRight" size={20} active={s.workbenchOpen} />
                            </button>
                        )}
                    </div>
                </header>
                {/* 规范稿离线 banner L1324-1332 */}
                {offline && (
                    <div className="flex shrink-0 items-center justify-between gap-2 border-b px-4 py-2" style={{ background: 'rgba(248, 113, 113, 0.09)', borderColor: 'rgba(248, 113, 113, 0.28)' }}>
                        <div className="flex items-center gap-2 text-[12px]" style={{ color: 'var(--status-danger)' }}>
                            <span className="h-2 w-2 rounded-full" style={{ background: 'var(--status-danger)' }} />
                            <span>{t('stage.offline.banner')}</span>
                        </div>
                        {/* ctx 暂无 serverStatus 写面/探测入口 —— refreshCards 是唯一握手重试 */}
                        <button className="rounded-md border border-[color:var(--border-hairline)] bg-[color:var(--bg-surface)] px-2.5 py-0.5 text-[11.5px] font-medium text-[color:var(--fg-primary)]" onClick={() => void s.refreshCards()}>
                            {t('stage.offline.reconnect')}
                        </button>
                    </div>
                )}
                {/* 规范稿三弹层锚在 section(绝对位),不是 composer 里 */}
                {menu === 'info' && (
                    <ChatInfoPop
                        chatBound={chatBound}
                        charDoc={charDoc}
                        slashOn={slashPrefs.enabled}
                        onToggleSlash={toggleSlashEnabled}
                        onClose={() => setMenu('none')}
                    />
                )}
                {menu === 'persona' && <PersonaPop onClose={() => setMenu('none')} />}
                {menu === 'emotes' && <EmotesPop onClose={() => setMenu('none')} />}
                {menu === 'slash' && (
                    <SlashMenu
                        onPick={onSlash}
                        onPickCommand={pickCommand}
                        nav={slashNav}
                        cmdCount={menuCmds.length}
                        hi={navHi}
                        setHi={setSlashHi}
                        filter={slashToken}
                        inArgs={slashInArgs}
                        flat={slashFlat}
                        enabled={slashPrefs.enabled}
                        onToggleEnabled={toggleSlashEnabled}
                        onToggleGroup={toggleGroupOpen}
                        onHideGroup={(g) => setGroupHidden(g, true)}
                        onShowGroup={(g) => setGroupHidden(g, false)}
                        onClose={() => setMenu('none')}
                    />
                )}
                {menu === 'preset' && <PresetPop onClose={() => setMenu('none')} />}
                {menu === 'group' && s.chat?.groupId && (
                    <GroupPop
                        doc={groupDoc}
                        busy={busy}
                        onSpeak={(member) => { setMenu('none'); void runGroupGenerate('normal', { member }); }}
                        onPatch={async (patch) => {
                            try {
                                const d = await patchGroup(s.chat!.groupId!, patch);
                                setGroupDoc(d);
                                s.hint(t('group.saved'));
                            } catch (e) {
                                s.hint(t('group.save.failed') + ': ' + errText(e), true);
                            }
                        }}
                        onClose={() => setMenu('none')}
                    />
                )}
                {/* QR 册弹层:全册名录 + 绑定域徽 + 行内启停 + 管理入口 */}
                {qrPick && (
                    <QrSetPop
                        names={qrNames}
                        sel={qrSel}
                        enabled={qrEnabled}
                        qr={qrSettings}
                        chatCfg={qrChatCfg}
                        charKey={qrCharKey}
                        onPick={(n) => { setQrSel(n); setQrPick(false); }}
                        onToggle={(n, on) => void toggleQrSet(n, on)}
                        onManage={() => { setQrPick(false); openQrStudio(); }}
                        onClose={() => setQrPick(false)}
                    />
                )}
                {/* 形态体插槽:chat 楼层列 / novel 章节 / messenger 频道 / theater 场景 */}
                {children}
                {/* composer-shell:QR 条 + form p-3(textarea + 底行 /·token | 预设⌄·send) */}
                <div className="shrink-0 px-4 pb-4 pt-1 sm:px-6">
                    {/* QR 条(TASK-063):册丸(切换/启停弹层)+ 当前册 chip 列;
                        册本会话未启用 → chip 区换成行内启用 CTA;点击三分支
                        (/continue 快路径、/ 前缀 runScript、普通 send)不动。 */}
                    {qrVisible && (
                        <div className="mx-auto mb-2 flex w-full max-w-[660px] items-center gap-1.5">
                            <button
                                type="button"
                                className="flex h-7 shrink-0 items-center gap-1 rounded-full border border-[color:var(--border-hairline)] bg-[color:var(--bg-surface)] pl-2 pr-1.5 text-[11.5px] font-medium text-[color:var(--fg-primary)] transition-colors hover:bg-[color:var(--bg-active)]"
                                title={t('stage.qr.pick')}
                                onClick={() => setQrPick((v) => !v)}
                            >
                                <Icon name="zap" size={11} />
                                <span className="max-w-[96px] truncate">{qrSel}</span>
                                <Icon name="chevronDown" size={10} />
                            </button>
                            <div className="no-scrollbar flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto pr-2" style={{ WebkitMaskImage: 'linear-gradient(to right, black 88%, transparent 100%)', maskImage: 'linear-gradient(to right, black 88%, transparent 100%)' }}>
                                {qrSelOn ? (
                                    qrChips.length ? qrChips.map((q) => (
                                        <button
                                            key={q.label + q.message}
                                            type="button"
                                            className="h-7 shrink-0 rounded-full border border-[color:var(--border-hairline)] bg-[color:var(--bg-surface)] px-2.5 text-[11.5px] text-[color:var(--fg-secondary)] transition-colors hover:bg-[color:var(--bg-active)]"
                                            onClick={() => {
                                                const msg = q.message.trim();
                                                if (msg.toLowerCase().startsWith('/continue')) void runGenerate('continue');
                                                else if (msg.startsWith('/')) void runScript(msg);
                                                else void send(msg);
                                            }}
                                        >
                                            {q.label}
                                        </button>
                                    )) : (
                                        <span className="shrink-0 px-1 text-[11px] text-[color:var(--fg-faint)]">{t('stage.qr.empty')}</span>
                                    )
                                ) : (
                                    <button
                                        type="button"
                                        className="h-7 shrink-0 rounded-full border border-dashed border-[color:var(--border-hairline)] px-2.5 text-[11.5px] text-[color:var(--fg-faint)] transition-colors hover:border-[color:var(--fg-faint)] hover:text-[color:var(--fg-secondary)]"
                                        onClick={() => void toggleQrSet(qrSel, true)}
                                    >
                                        {t('stage.qr.enable')}
                                    </button>
                                )}
                            </div>
                            <button type="button" className="ghost-btn h-6 w-6 shrink-0 text-[color:var(--fg-faint)]" title={t('stage.qr.manage')} onClick={openQrStudio}>
                                <Icon name="sliders" size={12} />
                            </button>
                            <button type="button" className="ghost-btn h-6 w-6 shrink-0 text-[color:var(--fg-faint)]" title={t('stage.qr.collapse')} onClick={() => setQrOpen(false)}>
                                <Icon name="x" size={12} />
                            </button>
                        </div>
                    )}
                    <div className="composer-shell mx-auto w-full max-w-[660px] space-y-2.5 rounded-[14px] p-3">
                        <div className="flex items-start gap-2">
                            {/* 命令 chip:菜单选定后命令词锁在 coral 徽上,draft 只剩参数区;
                                × = 整条丢弃,Esc 还原 `/cmd args` 文本,空参数 Backspace 化回 `/cmd` 重选。 */}
                            {pendingCmd && (
                                <span
                                    className="mt-[2px] inline-flex h-[22px] shrink-0 select-none items-center gap-1 rounded-md border px-1.5 font-mono-ui text-[12px] font-medium"
                                    style={{ background: 'var(--brand-soft)', borderColor: 'rgba(255,107,91,0.38)', color: 'var(--brand)' }}
                                    title={t('slash.chip.title')}
                                >
                                    /{pendingCmd}
                                    <button
                                        type="button"
                                        className="flex items-center justify-center rounded-sm opacity-70 transition-opacity hover:opacity-100"
                                        onClick={() => { setPendingCmd(null); setDraft(''); draftTaRef.current?.focus(); }}
                                        title={t('slash.chip.discard')}
                                    >
                                        <Icon name="x" size={10} />
                                    </button>
                                </span>
                            )}
                            <textarea
                                ref={draftTaRef}
                                value={draft}
                                onChange={(e) => {
                                    const v = e.target.value;
                                    setDraft(v);
                                    setSlashHi(0);
                                    /* `/` 起头 → 开 slash 菜单并按 token 过滤(打 /xx 实时收);
                                       非 / 起头 → 收起 slash(其它弹层状态不碰)。
                                       chip 态 draft 是参数区(参数里可合法含 /)+ 总闸关闭,
                                       都不触发菜单。 */
                                    if (!pendingCmd && slashPrefs.enabled && v.startsWith('/')) setMenu('slash');
                                    else setMenu((m) => (m === 'slash' ? 'none' : m));
                                }}
                                onKeyDown={(e) => {
                                    /* 菜单开着先走菜单键位(chip 态同此 —— 开着菜单就是
                                       在挑/换命令):↑↓ 移高亮(组头也在导航序里)、→/Enter 展组、
                                       ← 收组、Tab/Enter 选定落 chip、Esc 收菜单;
                                       参数区已开始打(签名卡语境)的 Enter 恒发草稿 —— 草稿即真相。 */
                                    if (menu === 'slash') {
                                        if (e.key === 'Escape') { setMenu('none'); return; }
                                        const row = navRows[navHi];
                                        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                                            if (!navRows.length) return;
                                            e.preventDefault();
                                            const n = navRows.length;
                                            setSlashHi((h) => (e.key === 'ArrowDown' ? h + 1 : h - 1 + n) % n);
                                            return;
                                        }
                                        if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && row?.kind === 'head') {
                                            if (e.key === 'ArrowRight' === row.open) return;
                                            e.preventDefault();
                                            toggleGroupOpen(row.group);
                                            return;
                                        }
                                        if (e.key === 'Tab') {
                                            e.preventDefault();
                                            if (row?.kind === 'head') toggleGroupOpen(row.group);
                                            else if (row?.kind === 'cmd') pickCommand(row.cmd.name);
                                            return;
                                        }
                                        if (e.key === 'Enter' && !e.shiftKey) {
                                            if (row?.kind === 'head') { e.preventDefault(); toggleGroupOpen(row.group); return; }
                                            if (row?.kind === 'cmd' && !slashInArgs) { e.preventDefault(); pickCommand(row.cmd.name); return; }
                                        }
                                    }
                                    /* 命令 chip 态(菜单已合):Esc 还原文本、空参数 Backspace
                                       化回 `/cmd` 重选、Enter 提交 chip+参数。 */
                                    if (pendingCmd) {
                                        if (e.key === 'Escape') { e.preventDefault(); dissolveChip(false); return; }
                                        if (e.key === 'Backspace' && draft === '') { e.preventDefault(); dissolveChip(true); return; }
                                        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitDraft(); return; }
                                        return;
                                    }
                                    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitDraft(); return; }
                                }}
                                placeholder={pendingCmd ? t('slash.args.ph') : t(`composer.ph.${stageKind}`)}
                                rows={1}
                                className="max-h-32 min-w-0 flex-1 resize-none bg-transparent text-[14px] leading-relaxed text-[color:var(--fg-primary)] outline-none"
                            />
                        </div>
                        {/* chip 态签名提示行:注册表快照的命名/匿名参数 + 一句话 help,
                            跟菜单签名卡同一数据源,单行截断不堆说明。 */}
                        {pendingCmd && (() => {
                            const info = scriptCmds.find((c) => c.name === pendingCmd);
                            if (!info || (!info.args.length && !info.unnamed.length && !info.help)) return null;
                            return (
                                <div className="no-scrollbar flex min-h-[18px] items-center gap-1 overflow-x-auto">
                                    {info.args.map((a) => (
                                        <span
                                            key={a.name}
                                            className="shrink-0 rounded-md border border-[color:var(--border-hairline)] bg-[color:var(--bg-surface)] px-1 py-px font-mono-ui text-[9.5px] text-[color:var(--fg-faint)]"
                                        >
                                            {a.name}{a.required ? '*' : a.def != null ? `=${a.def}` : '='}
                                        </span>
                                    ))}
                                    {info.unnamed.map((u, j) => (
                                        <span key={`u${j}`} className="shrink-0 px-0.5 font-mono-ui text-[9.5px] italic text-[color:var(--fg-faint)]">⟨{u}⟩</span>
                                    ))}
                                    {info.help && <span className="truncate px-0.5 text-[10px] text-[color:var(--fg-faint)]">· {info.help}</span>}
                                </div>
                            );
                        })()}
                        <div className="flex items-center justify-between gap-2">
                            <div className="flex min-w-0 items-center gap-1.5">
                                {/* SLASH COMMAND BUTTON("/"):稿 ghost-btn w-8 h-8 rounded-[8px];
                                    chip 态点亮 brand(命令模式信号),总闸关 → 淡显(仍可点开)。 */}
                                <button
                                    type="button"
                                    className="ghost-btn h-8 w-8 shrink-0 rounded-[8px]"
                                    style={
                                        menu === 'slash' ? { background: 'var(--bg-active)', color: 'var(--fg-primary)' }
                                            : pendingCmd ? { color: 'var(--brand)' }
                                                : { color: 'var(--fg-secondary)', opacity: slashPrefs.enabled ? 1 : 0.4 }
                                    }
                                    onClick={() => setMenu(menu === 'slash' ? 'none' : 'slash')}
                                    title={slashPrefs.enabled ? t('slash.menu.title') : t('slash.menu.disabled')}
                                >
                                    <Icon name="slash" size={20} active={menu === 'slash' || !!pendingCmd} />
                                </button>
                                {/* 规范稿 token 胶囊 L1353-1356:上轮组装 tokens / ctxLen,点击开 trace 面 */}
                                <button
                                    type="button"
                                    className="inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-1 font-mono-ui text-[10.5px] text-[color:var(--fg-muted)] transition-colors hover:bg-[color:var(--bg-active)]"
                                    title={t('stage.token.title')}
                                    onClick={() => s.openPanel('diag', lastJobId ? diagTraceParams(lastJobId) : { sub: 'jobs' })}
                                >
                                    <span>{lastTokens != null ? (s.isMobile ? `${(lastTokens / 1000).toFixed(1)}k` : lastTokens.toLocaleString()) : '—'} / {Math.round(effectiveCtxLen / 1000)}k</span>
                                    <span className="hidden h-1 w-8 overflow-hidden rounded-full sm:block" style={{ background: 'var(--bg-active)' }}>
                                        <span className="block h-full rounded-full" style={{ width: `${tokenPct}%`, background: 'var(--brand)' }} />
                                    </span>
                                </button>
                            </div>
                            <div className="flex shrink-0 items-center gap-2">
                                {/* 点模型原地弹「预设与模型」快捷调参 */}
                                <button
                                    type="button"
                                    className="inline-flex items-center gap-1 rounded-lg px-2 py-1 font-mono-ui text-[11.5px] transition-colors"
                                    style={menu === 'preset' ? { background: 'var(--bg-active)', color: 'var(--fg-primary)' } : { color: 'var(--fg-secondary)' }}
                                    onClick={() => setMenu(menu === 'preset' ? 'none' : 'preset')}
                                    title={t('composer.presetModel')}
                                >
                                    <span className="hidden sm:inline">{model?.short ?? t('composer.presetModel')}</span>
                                    <span className="sm:hidden">{t('composer.presetModelShort')}</span>
                                    <Icon name="chevronDown" size={12} />
                                </button>
                                {streaming ? (
                                    /* 规范稿中止钮 L1365-1366:w-8 h-8 brand 圆 + 白方块 */
                                    <button
                                        type="button"
                                        className="flex h-8 w-8 items-center justify-center rounded-full transition-transform active:scale-90"
                                        style={{ background: 'var(--brand)', color: '#fff' }}
                                        onClick={() => void onStop()}
                                        title={t('stage.abort.title')}
                                    >
                                        <span className="block h-2.5 w-2.5 rounded-[2px] bg-white" />
                                    </button>
                                ) : (
                                    <button
                                        id="btn-send"
                                        type="button"
                                        data-ready={!!composerPayload.trim() || undefined}
                                        className="flex h-8 w-8 items-center justify-center rounded-full transition-transform active:scale-90"
                                        style={{ color: composerPayload.trim() ? 'var(--brand)' : 'var(--fg-secondary)', opacity: offline ? 0.35 : 1 }}
                                        onClick={submitDraft}
                                        disabled={offline || busy || (s.live && !s.chat)}
                                        title={pendingCmd ? `/${pendingCmd} ${draft.trim()}`.trim() : t('composer.send')}
                                    >
                                        <Icon name="send" size={26} active={!!composerPayload.trim()} />
                                    </button>
                                )}
                            </div>
                        </div>
                    </div>
                </div>
                {/* TASK-069 脚本交互模态:input/popup/buttons 阻塞回执;
                    与 menu pops 不同层 —— 这是模态(挡舞台),不是角弹层 */}
                {scriptAwait && <ScriptAwaitDialog a={scriptAwait} onDone={(r) => scriptDlgResolve.current?.(r)} />}
            </section>
        </EngineCtx.Provider>
    );
}

/* ——— TASK-069 脚本挂起回执面 ——— */

/** /run /interact 响应:终态字段 + awaiting 挂起回执(二态互斥)。 */
interface ScriptRunRes {
    ok?: boolean; pipe?: unknown; isAborted?: boolean;
    error?: { code?: string; message?: string; commandName?: string; line?: number; column?: string };
    notifications?: { severity?: string; text?: string }[];
    popups?: unknown[]; inputs?: unknown[];
    awaiting?: ScriptAwaiting | null;
}

/** 服务端 awaiting 回执(script-runs.awaitingOf 展开 payload)。 */
interface ScriptAwaiting {
    runId: string;
    kind: 'input' | 'popup' | 'buttons';
    at?: number;
    // input
    prompt?: string; defaultInput?: string;
    // popup / buttons
    text?: string; header?: string | null;
    okButton?: string; cancelButton?: string | null;
    wide?: boolean; wider?: boolean; large?: boolean;
    allowVerticalScrolling?: boolean;
    buttons?: { text: string; tooltip?: string; icon?: string }[];
    multiple?: boolean;
    [k: string]: unknown;
}

/** 模态回给 runScript 的决定:submit(带值)/cancel(取消语义)/abort(杀 run)。 */
interface ScriptInteractReply { action: 'submit' | 'cancel' | 'abort'; value?: unknown }

/** 脚本阻塞回执模态 —— /input 文本、/popup 确认、/buttons 单多选。
 *  兑现语义对服务端 script-runs.resolveInteraction:input→string,
 *  popup→1(ok)/0(cancel),buttons→code[](label 下标+2);dismiss= cancel。 */
function ScriptAwaitDialog({ a, onDone }: { a: ScriptAwaiting; onDone: (r: ScriptInteractReply) => void }) {
    const { t } = useI18n();
    const [val, setVal] = useState(String(a.defaultInput ?? ''));
    const [picked, setPicked] = useState<Set<number>>(new Set());
    const btnCls = 'rounded-md border border-[color:var(--border-hairline)] px-3 py-1.5 text-[12px] font-medium text-[color:var(--fg-primary)] transition-colors hover:bg-[color:var(--bg-hover)]';
    const okCls = 'rounded-md px-3 py-1.5 text-[12px] font-medium text-white transition-opacity hover:opacity-90';
    return (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/45 p-4" onClick={() => onDone({ action: 'cancel' })}>
            <div
                className={`w-full rounded-xl border border-[color:var(--border-hairline)] bg-[color:var(--bg-surface)] shadow-xl ${a.wider ? 'max-w-3xl' : a.wide || a.large ? 'max-w-xl' : 'max-w-md'}`}
                onClick={(e) => e.stopPropagation()}
            >
                {(a.header || a.kind !== 'input') && (
                    <div className="border-b border-[color:var(--border-hairline)] px-4 py-2.5 text-[13px] font-semibold text-[color:var(--fg-primary)]">
                        {a.header ?? t(`stage.script.dlg.${a.kind}`)}
                    </div>
                )}
                <div className={`px-4 py-3 ${a.allowVerticalScrolling !== false ? 'max-h-[50vh] overflow-y-auto' : ''}`}>
                    {a.kind === 'input' ? (
                        <>
                            {a.prompt && <div className="mb-2 whitespace-pre-wrap text-[12.5px] leading-relaxed text-[color:var(--fg-primary)]">{a.prompt}</div>}
                            <textarea
                                autoFocus
                                className="w-full rounded-md border border-[color:var(--border-hairline)] bg-[color:var(--bg-inset)] px-2.5 py-1.5 text-[12.5px] text-[color:var(--fg-primary)] outline-none focus:border-[color:var(--brand)]"
                                rows={3}
                                value={val}
                                onChange={(e) => setVal(e.target.value)}
                                onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) onDone({ action: 'submit', value: val }); }}
                            />
                        </>
                    ) : (
                        <div className="whitespace-pre-wrap text-[12.5px] leading-relaxed text-[color:var(--fg-primary)]">{a.text}</div>
                    )}
                    {a.kind === 'buttons' && (
                        <div className="mt-3 flex flex-wrap gap-1.5">
                            {(a.buttons ?? []).map((b, i) => {
                                const code = i + 2; // 上游 result code:labels 下标 +2(0/1 留给取消/确认位)
                                const on = picked.has(code);
                                return (
                                    <button
                                        key={code}
                                        type="button"
                                        title={b.tooltip}
                                        className={btnCls}
                                        style={on ? { background: 'var(--bg-active)', borderColor: 'var(--brand)' } : undefined}
                                        onClick={() => {
                                            if (a.multiple) {
                                                setPicked((prev) => { const nx = new Set(prev); if (nx.has(code)) nx.delete(code); else nx.add(code); return nx; });
                                            } else {
                                                onDone({ action: 'submit', value: [code] });
                                            }
                                        }}
                                    >
                                        {b.icon ? <Icon name={b.icon as IconName} size={13} /> : null}{b.text}
                                    </button>
                                );
                            })}
                        </div>
                    )}
                </div>
                <div className="flex items-center justify-between gap-2 border-t border-[color:var(--border-hairline)] px-4 py-2.5">
                    <button type="button" className="text-[11px] text-[color:var(--fg-faint)] transition-colors hover:text-[color:var(--status-danger)]" onClick={() => onDone({ action: 'abort' })}>
                        {t('stage.script.dlg.abort')}
                    </button>
                    <div className="flex items-center gap-2">
                        {a.kind !== 'buttons' && (a.kind === 'input' || a.cancelButton !== null) && (
                            <button type="button" className={btnCls} onClick={() => onDone(a.kind === 'popup' ? { action: 'submit', value: 0 } : { action: 'cancel' })}>
                                {a.kind === 'popup' && a.cancelButton ? a.cancelButton : t('stage.script.dlg.cancel')}
                            </button>
                        )}
                        {a.kind === 'input' && (
                            <button type="button" className={okCls} style={{ background: 'var(--brand)' }} onClick={() => onDone({ action: 'submit', value: val })}>
                                {t('stage.script.dlg.ok')}
                            </button>
                        )}
                        {a.kind === 'popup' && (
                            <button type="button" autoFocus className={okCls} style={{ background: 'var(--brand)' }} onClick={() => onDone({ action: 'submit', value: 1 })}>
                                {a.okButton || t('stage.script.dlg.ok')}
                            </button>
                        )}
                        {a.kind === 'buttons' && a.multiple && (
                            <button type="button" className={okCls} style={{ background: 'var(--brand)' }} onClick={() => onDone({ action: 'submit', value: [...picked] })}>
                                {t('stage.script.dlg.ok')}
                            </button>
                        )}
                        {a.kind === 'buttons' && !a.multiple && (
                            <button type="button" className={btnCls} onClick={() => onDone({ action: 'cancel' })}>
                                {t('stage.script.dlg.cancel')}
                            </button>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}
