// 中列舞台:stage.form 贡献点按 chat.stage 分发,缺省标准聊天形态。
// 规范稿中列:stage-header | 消息流 | composer-shell。
// 楼层交互(规范稿 final 面,全部真协议):
//   · swipe ‹k/n› —— PATCH /body/<i>/swipe_id(utopinn-library L984);末版 ›
//     即「再生成一版」= generate swipe 流 + 客户端 PATCH swipes 写回
//   · 中止 —— streaming 时发送钮变 ■,POST /api/generation/:id/abort;
//     半截文本按动词写回楼层(swipe/continue=PATCH, normal/regenerate=append)
//     并打 extra.aborted → stToView 重放「已中止」态
//   · 错误楼层 —— {code,message,jobId,retry} 红卡,重试重放生成,Trace → diag 板块
//   · 楼操作条 —— copy / 编辑(PATCH mes+swipes[k])/ 删除(remove /body/<i>)/
//     回滚(remove 尾楼至 i+1 + settleMvu(i))
//   · QR 条 —— presets apiId=quickReplies 第一册 qrList;空档整条不渲染
//   · token 胶囊 —— 最近 job trace 组装 tokens / 预设 openai_max_context
//   · 离线 banner —— ctx.serverStatus==='offline',重连走 ctx 唯一探测 refreshCards
// 生成写盘分工(legacy save_decision 同构):客户端写盘是常路,写回带
//   gen-id/命中末楼 → ack 掉 awaiting_ack job;服务端 15s 兜底 persist
//   只兜 tab 丢失。normal=append / regenerate=replace 末楼 / swipe=增槽
//   / continue=末楼拼接 / impersonate·quiet=纯 gen-id 记账 patch。
import { useCallback, useEffect, useRef, useState } from 'react';
import { useShell, useContribs } from '../../kernel/context';
import { useI18n } from '../../i18n';
import { Icon, type IconName } from '../Icon';
import { postGenerate, streamJob } from '../../api/generate';
import { getJob, listJobs } from '../../api/jobs';
import { getPreset, listPresets } from '../../api/presets';
import { getMvuState, settleMvu, type MvuTarget } from '../../api/mvu';
import {
    appendAssistantMessage, appendUserMessage, getChat, mkAssistantFloor, patchChat, patchSwipe,
    type ChatPatchOp, type FloorMsg, type GenerateBody, type GenerateVerb,
} from '../../api/chats';
import { ApiError, apiFetch, apiPost } from '../../api/client';
import { MOCK_MESSAGES, MOCK_REPLY_CHAT, MOCK_IMPERSONATE_DRAFT } from '../../api/mock';
import { diagTraceParams } from '../panels/DiagPanel';
import type { ChatSummary } from '../../types';

let mockMid = 100;
const mkMock = (role: 'user' | 'assistant', content: string, streaming = false): FloorMsg => ({
    id: ++mockMid, role, name: role === 'user' ? 'haa' : '云栖宗 · 陈修线', content, streaming, timestamp: Date.now(),
});

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const errCode = (e: unknown) => (e instanceof ApiError ? `HTTP ${e.status ?? '?'}` : 'error');

/** chat → mvu/state target(与 chat_state 同形;不引 panels 域件)。 */
const mvuTarget = (chat: ChatSummary | null): MvuTarget | null =>
    chat?.charDir && chat?.chatName ? { avatar_url: `${chat.charDir}.png`, file_name: `${chat.chatName}.jsonl` } : null;

/** 贡献点出口:chat.stage → stage.form 组件;无匹配回落 ChatStage。 */
export function CenterStage() {
    const { chat } = useShell();
    const forms = useContribs('stage.form');
    const C = forms.find((f) => f.kind === (chat?.stage ?? 'chat'))?.Component ?? forms.find((f) => f.kind === 'chat')?.Component;
    return C ? <C /> : <ChatStage />;
}

/* ——— 规范稿 ctbar 三弹层 ——— */

function ContextPop({ onClose }: { onClose: () => void }) {
    const { t } = useI18n();
    const s = useShell();
    return (
        <>
            <div className="fixed inset-0 z-[29]" onClick={onClose} />
            <div className="pop-in absolute bottom-full left-0 z-[30] mb-2 w-[248px] rounded-[12px] p-1.5" style={{ background: 'var(--bg-elevated)', boxShadow: 'var(--shadow-pop)' }}>
                <div className="px-2 pb-1.5 pt-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-[color:var(--fg-faint)]">{t('ctx.title')}</div>
                {s.globalLore.map((g) => (
                    <button key={g.id} className="inset-row-btn flex w-full items-center justify-between rounded-md px-2 py-[7px] text-[11.5px]" onClick={() => s.toggleGlobalLore(g.id)}>
                        <span className="min-w-0 truncate text-[color:var(--fg-secondary)]">{g.name}</span>
                        <span className="shrink-0 font-mono-ui text-[9px]" style={{ color: g.enabled ? 'var(--status-ok)' : 'var(--fg-faint)' }}>{g.enabled ? `${g.tokens}t` : 'off'}</span>
                    </button>
                ))}
            </div>
        </>
    );
}

/** 规范稿斜杠菜单 L1100-1117:icon + label/desc + slash chip;attach 禁用徽标。 */
function SlashMenu({ onPick, onClose }: { onPick: (key: string) => void; onClose: () => void }) {
    const { t } = useI18n();
    const cmds: { key: string; icon: IconName; label: string; desc: string; slash: string; badge?: string }[] = [
        { key: 'continue', icon: 'fastForward', label: t('slash.continue'), desc: t('slash.continue.desc'), slash: '/continue' },
        { key: 'regen', icon: 'refresh', label: t('slash.regen'), desc: t('slash.regen.desc'), slash: '/regen' },
        { key: 'impersonate', icon: 'wand', label: t('slash.impersonate'), desc: t('slash.impersonate.desc'), slash: '/impersonate' },
        { key: 'mvu', icon: 'database', label: t('slash.mvu'), desc: t('slash.mvu.desc'), slash: '/mvu sync' },
        { key: 'attach', icon: 'paperclip', label: t('slash.attach'), desc: t('slash.attach.desc'), slash: '/attach', badge: t('slash.attach.badge') },
    ];
    return (
        <>
            <div className="fixed inset-0 z-[29]" onClick={onClose} />
            <div className="pop-in absolute bottom-full left-0 z-[30] mb-2 w-[288px] max-w-[calc(100%-32px)] rounded-[12px] p-1.5" style={{ background: 'var(--bg-elevated)', boxShadow: 'var(--shadow-pop)' }}>
                <div className="flex items-center justify-between px-2.5 py-1.5 text-[10.5px] font-medium text-[color:var(--fg-muted)]">
                    <span>{t('slash.menu.title')}</span><span className="font-mono-ui">/ commands</span>
                </div>
                {cmds.map((c) => (
                    <button
                        key={c.key}
                        className="inset-row-btn flex w-full items-center justify-between gap-2 rounded-[10px] px-2.5 py-2 text-left"
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
            </div>
        </>
    );
}

function PresetPop({ onClose }: { onClose: () => void }) {
    const { t } = useI18n();
    const s = useShell();
    const preset = s.presets.find((x) => x.id === s.activePresetId);
    const model = s.models.find((m) => m.id === s.activeModel);
    return (
        <>
            <div className="fixed inset-0 z-[29]" onClick={onClose} />
            <div className="pop-in absolute bottom-full right-0 z-[30] mb-2 w-[252px] rounded-[12px] p-3" style={{ background: 'var(--bg-elevated)', boxShadow: 'var(--shadow-pop)' }}>
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-[color:var(--fg-faint)]">{t('panel.preset.preset')}</div>
                <div className="relative mb-2">
                    <button className="sh-select-trigger" onClick={() => s.setOpenDropdown(s.openDropdown === 'preset' ? null : 'preset')}>
                        <span className="truncate font-mono-ui text-[11px]">{preset?.id ?? '—'}</span>
                        <Icon name="chevronDown" size={11} className="text-[color:var(--fg-faint)]" />
                    </button>
                    {s.openDropdown === 'preset' && (
                        <div className="sh-select-menu pop-in">
                            {s.presets.map((x) => (
                                <button key={x.id} className="inset-row-btn flex w-full items-center justify-between rounded-md px-2 py-1.5 text-[11px]" onClick={() => { s.pickPreset(x.id); s.setOpenDropdown(null); }}>
                                    <span className="truncate font-mono-ui">{x.id}</span>
                                    {x.id === s.activePresetId && <Icon name="check" size={11} className="text-[color:var(--brand)]" />}
                                </button>
                            ))}
                        </div>
                    )}
                </div>
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-[color:var(--fg-faint)]">{t('panel.preset.model')}</div>
                <div className="relative">
                    <button className="sh-select-trigger" onClick={() => s.setOpenDropdown(s.openDropdown === 'model' ? null : 'model')}>
                        <span className="truncate font-mono-ui text-[11px]">{model?.short ?? '—'}</span>
                        <Icon name="chevronDown" size={11} className="text-[color:var(--fg-faint)]" />
                    </button>
                    {s.openDropdown === 'model' && (
                        <div className="sh-select-menu pop-in">
                            {s.models.map((m) => (
                                <button key={m.id} className="inset-row-btn flex w-full items-center justify-between rounded-md px-2 py-1.5 text-[11px]" onClick={() => { s.setActiveModel(m.id); s.setOpenDropdown(null); }}>
                                    <span className="truncate font-mono-ui">{m.short}</span>
                                    {m.id === s.activeModel && <Icon name="check" size={11} className="text-[color:var(--brand)]" />}
                                </button>
                            ))}
                        </div>
                    )}
                </div>
                <button className="ghost-btn mt-2 w-full justify-center rounded-md py-1.5 text-[11px] text-[color:var(--fg-muted)]" onClick={() => { onClose(); s.openPanel('preset'); }}>
                    {t('panel.preset.more')} →
                </button>
            </div>
        </>
    );
}

/* ——— 楼层操作回调包 ——— */
interface FloorOps {
    isLast: boolean;
    editing: { id: number; text: string } | null;
    onSwipe: (m: FloorMsg, dir: -1 | 1) => void;
    onCopy: (m: FloorMsg) => void;
    onEdit: (m: FloorMsg) => void;
    onEditText: (text: string) => void;
    onSaveEdit: (m: FloorMsg) => void;
    onCancelEdit: () => void;
    onDelete: (m: FloorMsg) => void;
    onRewind: (m: FloorMsg) => void;
    onRetry: (m: FloorMsg) => void;
    onTrace: (m: FloorMsg) => void;
    onContinue: () => void;
}

/* ——— 消息泡(规范稿:assistant=头像列+正文列,ops 条在正文下;user=右列泡) ——— */
function Msg({ m, idx, ops }: { m: FloorMsg; idx: number; ops: FloorOps }) {
    const { t } = useI18n();
    const s = useShell();
    const [thinkOpen, setThinkOpen] = useState(false);
    const isUser = m.role === 'user';
    const name = m.name || (isUser ? 'haa' : (s.chat ? (s.cards.get(s.chat.charDir)?.name ?? s.chat.charDir) : 'Seraphina'));
    const time = typeof m.timestamp === 'number' && Number.isFinite(m.timestamp) ? new Date(m.timestamp).toTimeString().slice(0, 5) : '';
    if (isUser) {
        return (
            <div className="group/msg mx-auto flex w-full max-w-[680px] flex-col items-end px-1 py-2">
                <div className="max-w-[78%] rounded-[12px] px-3.5 py-2.5" style={{ background: 'var(--bg-surface-2, var(--bg-surface))', border: '1px solid var(--border-subtle)', boxShadow: 'var(--shadow-card)' }}>
                    {ops.editing?.id === m.id ? (
                        <div className="space-y-2">
                            <textarea
                                autoFocus
                                rows={3}
                                value={ops.editing.text}
                                onChange={(e) => ops.onEditText(e.target.value)}
                                className="chat-body-text w-full resize-none rounded-[10px] p-2.5 outline-none"
                                style={{ background: 'var(--bg-surface)', border: '1.5px solid var(--brand)', color: 'var(--fg-primary)', fontSize: s.chatSettings.fontSize }}
                            />
                            <div className="flex items-center justify-end gap-1.5">
                                <button className="h-7 rounded-lg px-3 text-[11.5px] font-medium" style={{ background: 'var(--brand)', color: 'var(--brand-fg)' }} onClick={() => ops.onSaveEdit(m)}>
                                    {t('stage.edit.save')}
                                </button>
                                <button className="h-7 rounded-lg bg-[color:var(--bg-active)] px-2.5 text-[11.5px] text-[color:var(--fg-secondary)]" onClick={ops.onCancelEdit}>
                                    {t('stage.edit.cancel')}
                                </button>
                            </div>
                        </div>
                    ) : (
                        <div className="chat-body-text whitespace-pre-wrap text-[color:var(--fg-primary)]" style={{ fontSize: s.chatSettings.fontSize }}>
                            {m.displayContent ?? m.content}
                        </div>
                    )}
                </div>
                <div className={`flex items-center gap-1 pt-0.5 transition-opacity duration-150 ${ops.isLast ? 'opacity-90' : 'opacity-0 group-hover/msg:opacity-100'}`}>
                    <button className="ghost-btn h-7 w-7" title={t('stage.op.copy')} onClick={() => ops.onCopy(m)}><Icon name="copy" size={14} /></button>
                    <button className="ghost-btn h-7 w-7" title={t('stage.op.edit')} onClick={() => ops.onEdit(m)}><Icon name="pencil" size={14} /></button>
                    <button className="ghost-btn h-7 w-7" title={t('stage.op.del')} onClick={() => ops.onDelete(m)}><Icon name="trash" size={14} /></button>
                    {m.snapshot && (
                        <button className="ghost-btn h-7 gap-1 px-2 text-[11.5px]" title={t('stage.op.rewind') + ` #${idx + 1}`} onClick={() => ops.onRewind(m)}>
                            <Icon name="rewind" size={14} /><span>{t('stage.op.rewind')}</span>
                        </button>
                    )}
                </div>
            </div>
        );
    }
    const swipeCount = m.swipes?.length ?? 0;
    const swipeIdx = m.activeSwipe ?? 0;
    const showOps = !m.streaming && !m.error;
    return (
        <article className="group/msg mx-auto flex w-full max-w-[680px] items-start gap-3 px-1 py-3">
            <span className="char-avatar-ring mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center text-[11px] font-semibold" style={{ background: 'linear-gradient(135deg,#4a6a8a,#2a3a4a)', color: 'var(--fg-primary)' }}>
                {name[0]}
            </span>
            <div className="min-w-0 flex-1">
                <div className="mb-1.5 flex items-center gap-2">
                    <span className="text-[11.5px] font-medium text-[color:var(--fg-primary)]">{name}</span>
                    {s.chatSettings.showFloorNum && <span className="font-mono-ui text-[9px] text-[color:var(--fg-faint)]">#{idx + 1}</span>}
                    {time && <span className="font-mono-ui text-[9px] text-[color:var(--fg-faint)]">{time}</span>}
                    {m.reasoning && (
                        <button className="flex items-center gap-1 text-[10px] text-[color:var(--fg-faint)]" onClick={() => setThinkOpen(!thinkOpen)}>
                            {t('stage.think')} <Icon name={thinkOpen ? 'chevronDown' : 'chevronRight'} size={8} />
                        </button>
                    )}
                </div>
                {thinkOpen && m.reasoning && (
                    <div className="mb-1.5 rounded-lg bg-[color:var(--bg-surface)] p-2.5 font-mono-ui text-[10px] leading-relaxed text-[color:var(--fg-muted)]">{m.reasoning}</div>
                )}
                {m.error ? (
                    /* 规范稿失败楼层 L1167-1178:code 红字 + 发送失败 + 重试/Trace */
                    <div className="space-y-2.5 rounded-[12px] p-3.5" style={{ background: 'rgba(248, 113, 113, 0.08)', border: '1px solid rgba(248, 113, 113, 0.35)' }}>
                        <div className="flex items-center justify-between gap-2">
                            <span className="font-mono-ui text-[12px] font-medium" style={{ color: 'var(--status-danger)' }}>{m.error.code}</span>
                            <span className="text-[11px] text-[color:var(--fg-muted)]">{t('stage.err.failed')}</span>
                        </div>
                        <div className="text-[12.5px] leading-relaxed text-[color:var(--fg-secondary)]">{m.error.message}</div>
                        <div className="flex items-center gap-2 pt-0.5">
                            {m.error.retry && (
                                <button className="h-7 rounded-lg px-2.5 text-[11.5px] font-medium" style={{ background: 'var(--brand)', color: 'var(--brand-fg)' }} onClick={() => ops.onRetry(m)}>
                                    {t('stage.err.retry')}
                                </button>
                            )}
                            <button className="h-7 rounded-lg border border-[color:var(--border-hairline)] bg-[color:var(--bg-surface)] px-2.5 text-[11.5px] text-[color:var(--fg-secondary)]" onClick={() => ops.onTrace(m)}>
                                {t('stage.err.trace')}
                            </button>
                        </div>
                    </div>
                ) : ops.editing?.id === m.id ? (
                    /* 规范稿楼层编辑 L1179-1186:textarea + 保存/取消 */
                    <div className="space-y-2">
                        <textarea
                            autoFocus
                            rows={4}
                            value={ops.editing.text}
                            onChange={(e) => ops.onEditText(e.target.value)}
                            className="chat-body-text w-full resize-none rounded-[10px] p-3 outline-none"
                            style={{ background: 'var(--bg-surface)', border: '1.5px solid var(--brand)', color: 'var(--fg-primary)', fontSize: s.chatSettings.fontSize }}
                        />
                        <div className="flex items-center gap-1.5">
                            <button className="h-7 rounded-lg px-3 text-[11.5px] font-medium" style={{ background: 'var(--brand)', color: 'var(--brand-fg)' }} onClick={() => ops.onSaveEdit(m)}>
                                {t('stage.edit.save')}
                            </button>
                            <button className="h-7 rounded-lg bg-[color:var(--bg-surface)] px-2.5 text-[11.5px] text-[color:var(--fg-secondary)]" onClick={ops.onCancelEdit}>
                                {t('stage.edit.cancel')}
                            </button>
                        </div>
                    </div>
                ) : (
                    <>
                        <div className="chat-body-text whitespace-pre-wrap text-[color:var(--fg-primary)]" style={{ fontSize: s.chatSettings.fontSize }}>
                            {m.displayContent ?? m.content}
                            {m.streaming && <span className="cursor-bar" />}
                        </div>
                        {m.aborted && !m.streaming && (
                            /* 规范稿已中止楼层 L1189 */
                            <span className="mt-1 inline-flex items-center gap-2 rounded-lg border border-[color:var(--border-hairline)] bg-[color:var(--bg-surface)] px-2.5 py-1 text-[11.5px] text-[color:var(--fg-muted)]">
                                <span>{t('stage.aborted')}</span>
                                <button className="font-medium text-[color:var(--brand)] hover:underline" onClick={ops.onContinue}>{t('stage.aborted.continue')}</button>
                            </span>
                        )}
                    </>
                )}
                {/* 规范稿楼层操作条 L1191-1206:swipe 胶囊 + copy/edit/del/回滚 */}
                {showOps && (
                    <div className={`flex items-center gap-1 pt-0.5 transition-opacity duration-150 ${ops.isLast || m.swipes ? 'opacity-90' : 'opacity-0 group-hover/msg:opacity-100'}`}>
                        {(m.swipes || ops.isLast) && (
                            <span className="mr-1 inline-flex items-center rounded-lg border border-[color:var(--border-hairline)] bg-[color:var(--bg-surface)] px-0.5">
                                <button className="ghost-btn h-6 w-6 text-[12px]" title={t('stage.swipe.prev')} style={swipeIdx <= 0 ? { opacity: 0.35 } : undefined} onClick={() => ops.onSwipe(m, -1)}>‹</button>
                                <span className="px-1.5 font-mono-ui text-[11px] text-[color:var(--fg-secondary)]">{Math.min(swipeIdx + 1, Math.max(swipeCount, 1))}/{Math.max(swipeCount, 1)}</span>
                                <button className="ghost-btn h-6 w-6 text-[12px]" title={t('stage.swipe.next')} onClick={() => ops.onSwipe(m, 1)}>›</button>
                            </span>
                        )}
                        <button className="ghost-btn h-7 w-7" title={t('stage.op.copy')} onClick={() => ops.onCopy(m)}><Icon name="copy" size={14} /></button>
                        <button className="ghost-btn h-7 w-7" title={t('stage.op.edit')} onClick={() => ops.onEdit(m)}><Icon name="pencil" size={14} /></button>
                        <button className="ghost-btn h-7 w-7" title={t('stage.op.del')} onClick={() => ops.onDelete(m)}><Icon name="trash" size={14} /></button>
                        {m.snapshot && (
                            <button className="ghost-btn h-7 gap-1 px-2 text-[11.5px]" title={t('stage.op.rewind') + ` #${idx + 1}`} onClick={() => ops.onRewind(m)}>
                                <Icon name="rewind" size={14} /><span>{t('stage.op.rewind')}</span>
                            </button>
                        )}
                    </div>
                )}
            </div>
        </article>
    );
}

/* ——— 标准聊天形态 ——— */
export function ChatStage() {
    const { t } = useI18n();
    const s = useShell();
    const [msgs, setMsgs] = useState<FloorMsg[]>(MOCK_MESSAGES);
    const [draft, setDraft] = useState('');
    const [busy, setBusy] = useState(false);
    const [job, setJob] = useState<{ id: string; type: GenerateVerb; floorId: number } | null>(null);
    const [editing, setEditing] = useState<{ id: number; text: string } | null>(null);
    const [menu, setMenu] = useState<'none' | 'context' | 'slash' | 'preset'>('none');
    const [qrChips, setQrChips] = useState<{ label: string; message: string }[]>([]);
    const [qrOpen, setQrOpen] = useState(true);
    const [ctxLen, setCtxLen] = useState<number | null>(null);
    const [lastTokens, setLastTokens] = useState<number | null>(null);
    /** 胶囊数字背后的 job —— 点开胶囊直跳该 job 的 trace 页。 */
    const [lastJobId, setLastJobId] = useState<string | null>(null);
    const [loadErr, setLoadErr] = useState<string | null>(null);
    const scrollRef = useRef<HTMLDivElement>(null);
    const transientRef = useRef(0);
    const accRef = useRef('');
    const abortingRef = useRef('');
    const wsClose = useRef<(() => void) | null>(null);
    /** 服务端中止后 WS 未必回终帧 —— 本地 settle 兜底,busy 不挂。 */
    const settleRef = useRef<((r: { text: string; error?: string }) => void) | null>(null);
    const model = s.models.find((m) => m.id === s.activeModel);
    const offline = s.serverStatus === 'offline';
    const streaming = busy && job !== null;
    const chatKey = s.chat?.charDir && s.chat?.chatName ? `${s.chat.charDir}/${s.chat.chatName}` : null;

    useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }); }, [msgs]);

    const patchFloor = useCallback((id: number, p: Partial<FloorMsg>) => {
        setMsgs((prev) => prev.map((m) => (m.id === id ? { ...m, ...p } : m)));
    }, []);

    const reload = useCallback(async () => {
        const chat = s.chat;
        if (!chat) return;
        try {
            const d = await getChat(chat.charDir, chat.chatName);
            setMsgs(d.messages);
        } catch { /* reload 失败不炸楼层,下一动作再拉 */ }
    }, [s.chat]);

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
        if (s.live && s.chat) {
            let dead = false;
            setMsgs([]);
            getChat(s.chat.charDir, s.chat.chatName)
                .then((d) => { if (!dead) setMsgs(d.messages); })
                .catch((e) => { if (!dead) { setMsgs([]); setLoadErr(errText(e)); } });
            return () => { dead = true; };
        }
        setMsgs(MOCK_MESSAGES);
        setQrChips([]);
        setCtxLen(null);
    }, [chatKey, s.live]); // eslint-disable-line react-hooks/exhaustive-deps

    /* ——— QR 条:presets apiId=quickReplies 第一册;空档整条不渲染 ——— */
    useEffect(() => {
        if (!s.live || !s.chat) { setQrChips([]); return; }
        let dead = false;
        void (async () => {
            try {
                const list = await listPresets('quickReplies');
                const first = list.items[0]?.name;
                if (!first) { if (!dead) setQrChips([]); return; }
                const { doc } = await getPreset(first, 'quickReplies');
                const raw = (doc as { qrList?: { label?: string; message?: string; isHidden?: boolean }[] }).qrList;
                const chips = (Array.isArray(raw) ? raw : [])
                    .filter((q) => q && q.isHidden !== true && typeof q.message === 'string' && q.message.trim().length > 0)
                    .slice(0, 12)
                    .map((q) => ({ label: (q.label ?? '').trim() || q.message!.trim().slice(0, 18), message: q.message!.trim() }));
                if (!dead) setQrChips(chips);
            } catch { if (!dead) setQrChips([]); }
        })();
        return () => { dead = true; };
    }, [s.live, s.chat?.id]);

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
                id = (await listJobs()).items
                    .slice()
                    .sort((a, b) => b.updated_at - a.updated_at)
                    .find((j) => j.chatKey === `char:${s.chat?.charDir}.png:${s.chat?.chatName}`)?.id;
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

    /* ——— MVU 快照同步进 ctx(胶囊/回滚后的真数据位) ——— */
    const refreshMvu = useCallback(async () => {
        const target = mvuTarget(s.chat);
        if (!s.live || !target) return;
        try {
            const v = await getMvuState(target);
            const stat = v.statData;
            if (stat && typeof stat === 'object' && !Array.isArray(stat)) {
                const flat: Record<string, string | number> = {};
                for (const [k, val] of Object.entries(stat as Record<string, unknown>).slice(0, 8)) {
                    const leaf = Array.isArray(val) ? val[0] : val;
                    if (typeof leaf === 'number' || typeof leaf === 'string') flat[k] = leaf;
                }
                if (Object.keys(flat).length) s.setMvu(flat);
            }
        } catch { /* 未初始化 → 保留现值 */ }
    }, [s]);

    useEffect(() => { if (s.live && chatKey) void refreshMvu(); }, [s.live, chatKey, refreshMvu]);

    const pushReply = (content: string) => setMsgs((prev) => [...prev, mkMock('assistant', content)]);
    const pushErrorFloor = (error: FloorMsg['error']) =>
        setMsgs((prev) => [...prev, { id: --transientRef.current, role: 'assistant', name: '', content: '', timestamp: Date.now(), error }]);

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
    const runGenerate = useCallback(async (type: GenerateVerb) => {
        const chat = s.chat;
        if (!chat || busy) return;
        const imp = type === 'impersonate';
        const floorId = imp ? Number.NaN : --transientRef.current;
        const charName = s.cards.get(chat.charDir)?.name ?? chat.charDir;
        if (!imp) {
            setMsgs((prev) => [...prev, { id: floorId, role: 'assistant', name: charName, content: '', streaming: true, timestamp: Date.now() }]);
        }
        setBusy(true);
        accRef.current = '';
        try {
            const body: GenerateBody = {
                charDir: chat.charDir, chatName: chat.chatName, type,
                user: s.persona ? { name: s.persona.name, description: s.persona.description } : { name: 'haa' },
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
    }, [s, busy, patchFloor, reload, writeBackGeneration, refreshTokens, refreshMvu, t]);

    /* ——— 发送 ——— */
    const send = useCallback(async (text: string) => {
        const v = text.trim();
        if (!v || busy || offline) return;
        setDraft('');
        if (!s.live || !s.chat) {
            setMsgs((prev) => [...prev, mkMock('user', v)]);
            setBusy(true);
            setTimeout(() => { pushReply(MOCK_REPLY_CHAT); setBusy(false); }, 600);
            return;
        }
        const chat = s.chat;
        const uid = transientRef.current - 1;
        transientRef.current = uid;
        setMsgs((prev) => [...prev, { id: uid, role: 'user', name: s.persona?.name ?? 'haa', content: v, timestamp: Date.now() }]);
        setBusy(true);
        try {
            await appendUserMessage(chat.charDir, chat.chatName, s.persona?.name ?? 'haa', v);
            setBusy(false);
            void runGenerate('normal');
        } catch (e) {
            pushErrorFloor({ code: errCode(e), message: errText(e), retry: { type: 'send', text: v } });
            setBusy(false);
        }
    }, [busy, offline, s, runGenerate]);

    /* ——— 中止:POST /api/generation/:id/abort(legacy 路由;
     *     服务端中止后 WS 未必回终帧 → settleRef 本地兜底 + 关 socket) ——— */
    const onStop = useCallback(async () => {
        const j = job;
        if (!j) return;
        abortingRef.current = j.id;
        try {
            const res = await apiFetch(`/api/generation/${encodeURIComponent(j.id)}/abort`, { method: 'POST' });
            const body = (await res.json().catch(() => null)) as { aborted?: boolean; error?: string } | null;
            if (!res.ok) throw new ApiError(body?.error || res.statusText, res.status);
        } catch (e) {
            abortingRef.current = '';
            s.hint(errText(e), true);
            return;
        }
        settleRef.current?.({ text: accRef.current });
        wsClose.current?.();
    }, [job, s]);

    /* ——— swipe ‹ › ——— */
    const onSwipe = useCallback(async (m: FloorMsg, dir: -1 | 1, idx: number) => {
        const count = m.swipes?.length ?? 0;
        const active = m.activeSwipe ?? 0;
        const next = active + dir;
        if (next >= count && dir > 0) {
            // 末版 › = 再生成一版:只对末楼有意义(服务端 swipe 弹末层)
            const lastAi = msgs.reduce((acc, x, i) => (x.role === 'assistant' && !x.error ? i : acc), -1);
            if (idx !== lastAi) { s.hint(t('stage.swipe.needLast'), true); return; }
            void runGenerate('swipe');
            return;
        }
        if (next < 0 || next >= count) return;
        const content = m.swipes?.[next]?.content ?? m.content;
        patchFloor(m.id, { activeSwipe: next, content });
        if (s.live && s.chat && m.id >= 0) {
            try { await patchSwipe(s.chat.charDir, s.chat.chatName, m.id, next); void refreshMvu(); }
            catch (e) {
                patchFloor(m.id, { activeSwipe: active, content: m.content });
                s.hint(t('stage.patch.failed') + ': ' + errText(e), true);
            }
        }
    }, [msgs, s, patchFloor, runGenerate, refreshMvu, t]);

    /* ——— 楼操作 ——— */
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
                await patchChat(s.chat.charDir, s.chat.chatName, [{ op: 'remove', path: `/body/${m.id}` }]);
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
            try { await patchChat(s.chat.charDir, s.chat.chatName, ops); void refreshMvu(); }
            catch (e) {
                s.hint(t('stage.patch.failed') + ': ' + errText(e), true);
                void reload();
            }
        }
    }, [s, editing, t, patchFloor, reload, refreshMvu]);

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
            if (ops.length) await patchChat(chat.charDir, chat.chatName, ops);
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

    /* ——— QR/斜杠文本:斜杠指令走真服务端 STscript runner(楼层副作用
     *     env 已落库 → 跑完 reload);非斜杠 = 普通用户输入 ——— */
    const runScript = useCallback(async (script: string) => {
        const chat = s.chat;
        if (!s.live || !chat || busy) return;
        setBusy(true);
        try {
            const res = await apiPost<{
                ok?: boolean; pipe?: unknown; isAborted?: boolean;
                notifications?: { severity?: string; text?: string }[];
                popups?: unknown[]; inputs?: unknown[];
            }>('/api/utopinn/script/run', { charDir: chat.charDir, chatName: chat.chatName, script });
            for (const n of res.notifications ?? []) {
                if (n?.text) s.hint(String(n.text), n.severity === 'error' || n.severity === 'warning');
            }
            if (typeof res.pipe === 'string' && res.pipe.trim()) s.hint(res.pipe.trim());
            if ((res.popups?.length ?? 0) + (res.inputs?.length ?? 0) > 0) s.hint(t('stage.script.popup'), true);
            await reload();
            void refreshMvu();
        } catch (e) {
            s.hint(t('stage.script.failed') + ': ' + errText(e), true);
        } finally {
            setBusy(false);
        }
    }, [s, busy, t, reload, refreshMvu]);

    const onSlash = useCallback((key: string) => {
        setMenu('none');
        if (!s.live || !s.chat) {
            if (key === 'impersonate') { setDraft(MOCK_IMPERSONATE_DRAFT); return; }
            if (key === 'mvu') { s.hint(t('status.stub')); return; }
            setMsgs((prev) => [...prev, mkMock('user', `/${key}`)]);
            setTimeout(() => pushReply(MOCK_REPLY_CHAT), 500);
            return;
        }
        if (busy) return;
        if (key === 'continue') void runGenerate('continue');
        else if (key === 'regen') void runGenerate('regenerate');
        else if (key === 'impersonate') void runGenerate('impersonate');
        else if (key === 'mvu') void onMvuSync();
    }, [s, busy, runGenerate, onMvuSync, t]);

    const opsOf = (m: FloorMsg, idx: number): FloorOps => ({
        isLast: idx === msgs.length - 1,
        editing,
        onSwipe: (mm, dir) => void onSwipe(mm, dir, idx),
        onCopy,
        onEdit: (mm) => setEditing({ id: mm.id, text: mm.displayContent ?? mm.content }),
        onEditText: (text) => setEditing((prev) => (prev ? { ...prev, text } : prev)),
        onSaveEdit: (mm) => void onSaveEdit(mm),
        onCancelEdit: () => setEditing(null),
        onDelete: (mm) => void onDelete(mm),
        onRewind: (mm) => void onRewind(mm),
        onRetry,
        // 错误楼「查看 Trace」→ 该楼 jobId 的 trace 页;无 jobId(发送失败)
        // 落 jobs 列表让人自己找 —— 不复用上次 trace 现场,避免看错 job。
        onTrace: (mm) => s.openPanel('diag', mm.error?.jobId ? diagTraceParams(mm.error.jobId) : { sub: 'jobs' }),
        onContinue: () => void runGenerate('continue'),
    });

    const effectiveCtxLen = ctxLen ?? s.presetParams.ctxLen;
    const tokenPct = lastTokens != null && effectiveCtxLen > 0 ? Math.min(100, Math.round((lastTokens / effectiveCtxLen) * 100)) : 0;

    return (
        <div className="flex min-h-0 flex-1 flex-col">
            {/* 规范稿瘦头:卡名 · 会话名 面包屑(移动端已由 hub 条承担则隐藏) */}
            {!s.isMobile && (
                <div className="flex h-10 shrink-0 items-center px-4">
                    <div className="mx-auto flex w-full max-w-[680px] items-center gap-1.5">
                        <span className="char-avatar-ring flex h-5 w-5 items-center justify-center text-[8.5px] font-semibold" style={{ background: 'linear-gradient(135deg,#4a6a8a,#2a3a4a)', color: 'var(--fg-primary)' }}>
                            {(s.chat?.title ?? '云')[0]}
                        </span>
                        <button className="heading-tight truncate text-[12.5px] text-[color:var(--fg-primary)]">
                            {s.chat ? `${s.cards.get(s.chat.charDir)?.name ?? s.chat.charDir} · ${s.chat.title}` : t('chat.none')}
                        </button>
                        <Icon name="chevronDown" size={10} className="text-[color:var(--fg-faint)]" />
                    </div>
                </div>
            )}
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
            {/* 消息流 */}
            <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
                {loadErr && (
                    <div className="mx-auto my-6 max-w-[680px] rounded-[12px] border border-[color:var(--border-hairline)] bg-[color:var(--bg-surface)] p-4 text-center">
                        <div className="break-all font-mono-ui text-[10.5px] text-[color:var(--fg-faint)]">{loadErr}</div>
                        <button className="ghost-btn mt-2 h-6 px-2.5 text-[10.5px]" onClick={() => void reload()}>{t('panel.retry')}</button>
                    </div>
                )}
                {msgs.filter((m) => m.role !== 'system' || m.content).map((m, i) => <Msg key={m.id} m={m} idx={i} ops={opsOf(m, i)} />)}
            </div>
            {/* composer-shell:textarea + 底行(/ · token 胶囊 · ctx · 预设/模型⌄ · 发送/中止) */}
            <div className="shrink-0 px-4 pb-4 pt-1">
                {/* 规范稿 QR 条 L1339-1346:仅 chat 形态 + 无弹层时;空档整条不出 */}
                {qrOpen && qrChips.length > 0 && menu === 'none' && (s.chat?.stage ?? 'chat') === 'chat' && (
                    <div className="mx-auto mb-2 flex w-full max-w-[680px] items-center gap-1.5">
                        <div className="no-scrollbar flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto pr-3" style={{ WebkitMaskImage: 'linear-gradient(to right, black 88%, transparent 100%)', maskImage: 'linear-gradient(to right, black 88%, transparent 100%)' }}>
                            {qrChips.map((q) => (
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
                            ))}
                        </div>
                        <button type="button" className="ghost-btn h-6 w-6 shrink-0 text-[color:var(--fg-faint)]" title={t('stage.qr.collapse')} onClick={() => setQrOpen(false)}>
                            <Icon name="x" size={12} />
                        </button>
                    </div>
                )}
                <div className="composer-shell relative mx-auto w-full max-w-[680px] rounded-[14px]">
                    {menu === 'slash' && <SlashMenu onPick={onSlash} onClose={() => setMenu('none')} />}
                    {menu === 'context' && <ContextPop onClose={() => setMenu('none')} />}
                    {menu === 'preset' && <PresetPop onClose={() => setMenu('none')} />}
                    <textarea
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(draft); }
                            if (e.key === '/' && !draft) { e.preventDefault(); setMenu('slash'); }
                        }}
                        placeholder={t('composer.placeholder')}
                        rows={3}
                        className="chat-body-text w-full resize-none bg-transparent px-3.5 pb-1 pt-3 outline-none"
                    />
                    <div className="flex items-center gap-1.5 px-2.5 pb-2.5">
                        <button className="ghost-btn h-7 w-7 rounded-md border border-[color:var(--border-subtle)]" onClick={() => setMenu(menu === 'slash' ? 'none' : 'slash')} title={t('slash.menu.title')}>
                            <Icon name="slash" size={13} />
                        </button>
                        {/* 规范稿 token 胶囊 L1353-1356:上轮组装 tokens / ctxLen,点击开 trace 面 */}
                        <button
                            className="inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-1 font-mono-ui text-[10.5px] text-[color:var(--fg-muted)] transition-colors hover:bg-[color:var(--bg-active)]"
                            title={t('stage.token.title')}
                            onClick={() => s.openPanel('diag', lastJobId ? diagTraceParams(lastJobId) : { sub: 'jobs' })}
                        >
                            <span>{lastTokens != null ? (s.isMobile ? `${(lastTokens / 1000).toFixed(1)}k` : lastTokens.toLocaleString()) : '—'} / {Math.round(effectiveCtxLen / 1000)}k</span>
                            <span className="hidden h-1 w-8 overflow-hidden rounded-full sm:block" style={{ background: 'var(--bg-active)' }}>
                                <span className="block h-full rounded-full" style={{ width: `${tokenPct}%`, background: 'var(--brand)' }} />
                            </span>
                        </button>
                        <button
                            className="ghost-btn h-7 gap-1 rounded-md px-1.5 font-mono-ui text-[10px] text-[color:var(--fg-muted)]"
                            onClick={() => setMenu(menu === 'context' ? 'none' : 'context')}
                            style={menu === 'context' ? { color: 'var(--brand)' } : undefined}
                            title={t('ctx.capsule')}
                        >
                            {Object.entries(s.mvu).slice(0, 2).map(([k, v]) => `${k} ${v}`).join(' · ')}
                            <Icon name="bookOpen" size={11} />
                        </button>
                        <span className="flex-1" />
                        <button
                            className="ghost-btn h-7 gap-1 rounded-md px-2 font-mono-ui text-[10.5px]"
                            style={menu === 'preset' ? { color: 'var(--brand)' } : { color: 'var(--fg-secondary)' }}
                            onClick={() => setMenu(menu === 'preset' ? 'none' : 'preset')}
                        >
                            <span className="hidden sm:inline">{model?.short ?? t('composer.presetModel')}</span>
                            <span className="sm:hidden">{t('composer.presetModel')}</span>
                            <Icon name="chevronDown" size={9} />
                        </button>
                        {streaming ? (
                            /* 规范稿中止钮 L1365-1366:brand 圆 + 白方块 */
                            <button
                                className="flex h-7 w-7 items-center justify-center rounded-full transition-transform active:scale-90"
                                style={{ background: 'var(--brand)', color: 'var(--brand-fg)' }}
                                onClick={() => void onStop()}
                                title={t('stage.abort.title')}
                            >
                                <span className="block h-2.5 w-2.5 rounded-[2px] bg-white" />
                            </button>
                        ) : (
                            <button
                                className="flex h-7 w-7 items-center justify-center rounded-full transition-transform active:scale-90"
                                style={{ color: draft.trim() ? 'var(--brand)' : 'var(--fg-secondary)', opacity: offline ? 0.35 : 1 }}
                                onClick={() => void send(draft)}
                                disabled={offline || busy}
                                title={t('composer.send')}
                            >
                                <Icon name="send" size={16} />
                            </button>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}
