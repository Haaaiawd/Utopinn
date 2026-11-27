// 中列舞台:stage.form 贡献点按 chat.stage 分发,缺省标准聊天形态。
// 帧壳(stage-header/离线 banner/三弹层/QR 条/composer/生成引擎)收编到
// StageFrame —— stagepack 三形态同帧接入,数据面语义不变。
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
import { useEffect, useMemo, useRef, useState } from 'react';
import { useShell, useContribs } from '../../kernel/context';
import { useI18n } from '../../i18n';
import { Icon } from '../Icon';
import { charImageUrl } from '../../api/characters';
import { builtinCoverSrc } from '../../api/personas';
import type { FloorMsg } from '../../api/chats';
import { extractFrontendBlocks } from '../../cardapp/messageFrame';
import { MessageIframe } from '../../cardapp/MessageIframe';
import { FloorRenderProvider, ProseFloor } from './prose';
import { StageFrame, useStageEngine, charImgFallback, type FloorOps } from './StageFrame';
import { useBoundEmote } from './emotes';

/** 贡献点出口:chat.stage → stage.form 组件;无匹配回落 ChatStage。 */
export function CenterStage() {
    const { chat } = useShell();
    const forms = useContribs('stage.form');
    const C = forms.find((f) => f.kind === (chat?.stage ?? 'chat'))?.Component ?? forms.find((f) => f.kind === 'chat')?.Component;
    return C ? <C /> : <ChatStage />;
}

/* ——— 消息泡(规范稿 renderStageContent chat 分支:
 *     assistant=article gap-3.5 + w-9 头像环 + ops 条(左 swipe/copy/edit/del/回滚,
 *     右 deltas mono 芯);user=右列 rounded-2xl bg-user-bubble)——— */
function StageAvatar({ name, m }: { name: string; m?: FloorMsg }) {
    const s = useShell();
    const card = s.chat ? s.cards.get(s.chat.charDir) : undefined;
    const coverKey = s.chat?.charDir ?? name;
    /* 本会话立绘绑定(TASK-067):绑了则楼层头像渲 sprite;未绑回落卡头像。 */
    const bound = useBoundEmote(s.chat?.id);
    /* 群楼层(TASK-062):每楼发言成员自己的头像 —— wire 层 original_avatar
       (avatar 文件名)/force_avatar(thumbnail 直链);都没有才回落会话
       封面兜底 —— 不再全员共用主卡头像。 */
    const groupSrc = s.chat?.groupId
        ? (m?.raw?.force_avatar || (m?.raw?.original_avatar ? charImageUrl(m.raw.original_avatar) : ''))
        : '';
    const src = groupSrc || bound?.url || (card?.avatar ? charImageUrl(card.avatar) : builtinCoverSrc(coverKey));
    return (
        <span className="char-avatar-ring mt-0.5 h-9 w-9 shrink-0">
            <img src={src} alt={name} className="h-full w-full object-cover" onError={charImgFallback} data-cover-key={coverKey} />
        </span>
    );
}

/** 楼层展示正文:TH「前端界面」检测 —— 文本里 pre>code 含 <body/<head/html>
 *  (卡惯用 ```html 栅栏块或整楼文档)→ 摘出挂 doc-mount iframe;
 *  余下文本面走 'renderer' 贡献点(缺省 ProseFloor,TASK-026 四惯例),
 *  楼层经 FloorRenderCtx 下发 —— 换渲染器不换宿主 chrome。
 *  streaming 中不挂帧(内容未稳);编辑中走 textarea 不进本面。 */
function FloorBody({ m, streaming, greeting }: { m: FloorMsg; streaming?: boolean; greeting?: boolean }) {
    const s = useShell();
    const text = m.displayContent ?? m.content;
    const split = extractFrontendBlocks(text);
    /* 群楼层:成员楼内嵌 CardApp 挂帧的 charDir 是该楼发言成员的
       (original_avatar 剥扩展名),不是会话键 —— 会话 charDir 群路是空串。 */
    const charDir = s.chat?.groupId
        ? (m.raw?.original_avatar ?? '').replace(/\.(png|webp|jpe?g)$/i, '') || undefined
        : s.chat?.charDir;
    const chatName = s.chat?.chatName;
    /* renderer seam:order 最小者上岗;贡献缺席回落内建 ProseFloor(诚实兜底)。 */
    const renderers = useContribs('renderer');
    const Renderer = useMemo(
        () => [...renderers].sort((a, b) => a.order - b.order)[0]?.Component ?? ProseFloor,
        [renderers],
    );
    return (
        <>
            {(split.text || streaming || !split.blocks.length) && (
                <FloorRenderProvider value={{ m, text: split.text || text, streaming, greeting, fontSize: s.chatSettings.fontSize }}>
                    <Renderer />
                </FloorRenderProvider>
            )}
            {!streaming && charDir && split.blocks.map((b, i) => (
                <MessageIframe key={`${m.id}-${i}`} charDir={charDir} chatName={chatName} html={b.html} messageId={m.id} blockIndex={i} />
            ))}
        </>
    );
}

function Msg({ m, idx, ops, greeting }: { m: FloorMsg; idx: number; ops: FloorOps; greeting?: boolean }) {
    const { t } = useI18n();
    const s = useShell();
    const [thinkOpen, setThinkOpen] = useState(false);
    const isUser = m.role === 'user';
    const fallbackUser = s.persona?.name || s.currentUser?.name || s.currentUser?.handle || 'User';
    /* 规范稿 sender = 卡名 · 线名合成;m.name 有值(真 char 名/群成员名)优先;
       群路兜底群名,不拿 charDir 空串拼名。 */
    const name = m.name || (isUser
        ? fallbackUser
        : (s.chat
            ? s.chat.groupId
                ? (s.chat.group ?? s.chat.title)
                : `${s.cards.get(s.chat.charDir)?.name ?? s.chat.charDir} · ${s.chat.title}`
            : '我没想当掌门啊'));
    const time = typeof m.timestamp === 'number' && Number.isFinite(m.timestamp) ? new Date(m.timestamp).toTimeString().slice(0, 5) : '';
    if (isUser) {
        return (
            <div className="group/msg flex flex-col items-end" data-floor={m.id}>
                <div className="max-w-[80%] rounded-2xl px-4 py-2.5 text-[14px] leading-relaxed" style={{ background: 'var(--bg-user-bubble)' }}>
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
                        <FloorBody m={m} streaming={m.streaming} greeting={greeting} />
                    )}
                </div>
                {/* 触屏无 hover —— 移动端 ops 常显(opacity-90),桌面保留 hover 显现 */}
                <div className={`flex items-center gap-1 pt-0.5 transition-opacity duration-150 mob:opacity-90 ${ops.isLast ? 'opacity-90' : 'opacity-0 group-hover/msg:opacity-100'}`}>
                    <button className="ghost-btn h-7 w-7" title={t('floor.quote')} onClick={() => ops.onQuote(m)}><Icon name="quote" size={14} /></button>
                    <button className="ghost-btn h-7 w-7" title={t('stage.op.copy')} onClick={() => ops.onCopy(m)}><Icon name="copy" size={14} /></button>
                    <button className="ghost-btn h-7 w-7" title={t('stage.op.edit')} onClick={() => ops.onEdit(m)}><Icon name="pencil" size={14} /></button>
                    <button className="ghost-btn h-7 w-7" title={t('stage.op.del')} onClick={() => ops.onDelete(m)}><Icon name="trash" size={14} /></button>
                    {/* 新建分支:从该楼直岔新会话(整楼 swipe 组随拷贝);
                        真会话真楼才出钮;群会话无卡域 fork 路由不画 */}
                    {s.live && s.chat && !s.chat.groupId && m.id >= 0 && (
                        <button className="ghost-btn h-7 w-7" title={t('floor.fork')} onClick={() => ops.onForkFloor(m)}>
                            <Icon name="gitFork" size={14} />
                        </button>
                    )}
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
    const tOpen = s.chatSettings.autoExpandThink || thinkOpen;
    const receipts = (m.receipts ?? []).map((r) => r.summary).filter((x): x is string => !!x);
    return (
        /* greeting = 首条可见 assistant 楼(TASK-026 首楼版式待遇):
           .prose-greeting 给 article 发丝线+间距,正文由渲染器抬字号档。 */
        <article className={`group/msg flex items-start gap-3.5${greeting ? ' prose-greeting' : ''}`} data-floor={m.id}>
            <StageAvatar name={name} m={m} />
            <div className="min-w-0 flex-1 space-y-2">
                <div className="flex items-center gap-2">
                    <span className="heading-tight text-[13px] font-medium text-[color:var(--fg-primary)]">{name}</span>
                    {s.chatSettings.showFloorNum && <span className="font-mono-ui text-[11px] text-[color:var(--fg-faint)]">#{m.id + 1}</span>}
                    {time && <span className="font-mono-ui text-[11px] text-[color:var(--fg-muted)]">{time}</span>}
                    {m.reasoning && s.chatSettings.autoParseThink && (
                        <button
                            className="ml-1 inline-flex items-center gap-1 text-[11.5px] text-[color:var(--fg-muted)] transition-colors hover:text-[color:var(--fg-primary)]"
                            onClick={() => setThinkOpen(!thinkOpen)}
                        >
                            <span>{t('stage.think')}</span>
                            <span className="inline-flex transition-transform" style={{ transform: tOpen ? 'rotate(180deg)' : undefined }}><Icon name="chevronDown" size={11} /></span>
                        </button>
                    )}
                </div>
                {m.reasoning && s.chatSettings.autoParseThink && tOpen && (
                    <div className="border-l pl-3 text-[12.5px] leading-relaxed text-[color:var(--fg-muted)]" style={{ borderColor: 'var(--border-subtle)' }}>{m.reasoning}</div>
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
                            className="chat-body-text w-full resize-none rounded-[10px] p-3 outline-none select-text"
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
                        <FloorBody m={m} streaming={m.streaming} greeting={greeting} />
                        {m.aborted && !m.streaming && (
                            /* 规范稿已中止楼层 L1189 */
                            <span className="inline-flex items-center gap-2 rounded-lg border border-[color:var(--border-hairline)] bg-[color:var(--bg-surface)] px-2.5 py-1 text-[11.5px] text-[color:var(--fg-muted)]">
                                <span>{t('stage.aborted')}</span>
                                <button className="font-medium text-[color:var(--brand)] hover:underline" onClick={ops.onContinue}>{t('stage.aborted.continue')}</button>
                            </span>
                        )}
                    </>
                )}
                {/* 规范稿楼层操作条 L1191-1206:左 swipe 胶囊+copy/edit/del/回滚,右 deltas mono 芯 */}
                {showOps && (
                    <div className={`flex items-center justify-between gap-2 pt-0.5 transition-opacity duration-150 mob:opacity-90 ${ops.isLast ? 'opacity-90' : 'opacity-0 group-hover/msg:opacity-100'}`}>
                        <div className="flex items-center gap-1">
                            {(m.swipes || ops.isLast) && (
                                <span className="mr-1 inline-flex items-center rounded-lg border border-[color:var(--border-hairline)] bg-[color:var(--bg-surface)] px-0.5">
                                    <button className="ghost-btn h-6 w-6 text-[12px]" title={t('stage.swipe.prev')} style={swipeIdx <= 0 ? { opacity: 0.35 } : undefined} onClick={() => ops.onSwipe(m, -1)}>‹</button>
                                    <span className="px-1.5 font-mono-ui text-[11px] text-[color:var(--fg-secondary)]">{Math.min(swipeIdx + 1, Math.max(swipeCount, 1))}/{Math.max(swipeCount, 1)}</span>
                                    <button className="ghost-btn h-6 w-6 text-[12px]" title={t('stage.swipe.next')} onClick={() => ops.onSwipe(m, 1)}>›</button>
                                </span>
                            )}
                            <button className="ghost-btn h-7 w-7" title={t('floor.quote')} onClick={() => ops.onQuote(m)}><Icon name="quote" size={14} /></button>
                            <button className="ghost-btn h-7 w-7" title={t('stage.op.copy')} onClick={() => ops.onCopy(m)}><Icon name="copy" size={14} /></button>
                            <button className="ghost-btn h-7 w-7" title={t('stage.op.edit')} onClick={() => ops.onEdit(m)}><Icon name="pencil" size={14} /></button>
                            <button className="ghost-btn h-7 w-7" title={t('stage.op.del')} onClick={() => ops.onDelete(m)}><Icon name="trash" size={14} /></button>
                            {/* 新建分支:从该楼直岔新会话(整楼 swipe 组随拷贝);
                                真会话真楼才出钮;群会话无卡域 fork 路由不画 */}
                            {s.live && s.chat && !s.chat.groupId && m.id >= 0 && (
                                <button className="ghost-btn h-7 w-7" title={t('floor.fork')} onClick={() => ops.onForkFloor(m)}>
                                    <Icon name="gitFork" size={14} />
                                </button>
                            )}
                            {m.snapshot && (
                                <button className="ghost-btn h-7 gap-1 px-2 text-[11.5px]" title={t('stage.op.rewind') + ` #${idx + 1}`} onClick={() => ops.onRewind(m)}>
                                    <Icon name="rewind" size={14} /><span>{t('stage.op.rewind')}</span>
                                </button>
                            )}
                        </div>
                        {receipts.length > 0 && (
                            <div className="flex items-center gap-1.5">
                                {receipts.map((d, i) => (
                                    <span key={i} className="rounded-md bg-[color:var(--bg-surface)] px-2 py-0.5 font-mono-ui text-[10.5px] text-[color:var(--fg-secondary)]">{d}</span>
                                ))}
                            </div>
                        )}
                    </div>
                )}
            </div>
        </article>
    );
}

/* ——— 聊天楼层列(StageFrame 形态体插槽,引擎经 ctx 取)——— */
function ChatFloors() {
    const { t } = useI18n();
    const s = useShell();
    const eng = useStageEngine();
    const scrollRef = useRef<HTMLDivElement>(null);
    const [showAll, setShowAll] = useState(false);

    useEffect(() => {
        setShowAll(false);
    }, [s.chat?.id]);

    useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }); }, [eng.msgs]);

    /* 「跳回该层」(书签面板):目标楼在收起的窗口外 → 先展开全部再滚;
       data-floor 锚只在 chat 形态打(其余形态 jump 请求静默落空 ——
       面板侧已按形态禁钮,这里是兜底)。 */
    useEffect(() => {
        if (!eng.jump) return;
        const el = document.querySelector(`[data-floor="${eng.jump.floor}"]`);
        if (el) {
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            el.classList.add('floor-jump');
            window.setTimeout(() => el.classList.remove('floor-jump'), 1400);
            return;
        }
        if (!showAll) setShowAll(true); // 展开后 effect 重跑,命中再走上面分支
    }, [eng.jump, showAll]);

    const renderable = eng.msgs
        .map((m, origIdx) => ({ m, origIdx }))
        .filter(({ m }) => m.role !== 'system' || m.content);
    const limit = Math.max(5, s.chatSettings.renderCount || 30);
    const hiddenCount = !showAll && renderable.length > limit ? renderable.length - limit : 0;
    const visible = hiddenCount > 0 ? renderable.slice(-limit) : renderable;
    /* greeting 身份归数据:首条可见 assistant 楼(卡 first_mes 落位),
       收缩窗口不影响判定(renderable[0],非可见切片头)。 */
    const greetingId = renderable[0]?.m.role === 'assistant' ? renderable[0].m.id : undefined;

    /* 壁纸已上移到 App 根全局 AmbientBackdrop(半透明 chrome 透出)——
       舞台不再自绘大图;会话锁/全局槽的数据语义不变,只是渲染收口。 */
    return (
        <div className="relative flex min-h-0 flex-1 flex-col">
        {/* spec stage-scroll px-5 sm:px-8 py-6 + scroll-fade-mask */
        }
        <div ref={scrollRef} className="scroll-fade-mask relative min-h-0 flex-1 select-text overflow-y-auto px-5 py-6 sm:px-8">
            <div className="relative z-10 mx-auto max-w-[660px] space-y-7 pb-6">
                {eng.loadErr && (() => {
                    let code = '', detail = eng.loadErr;
                    try {
                        const j = JSON.parse(eng.loadErr) as Record<string, unknown>;
                        code = String(j.code ?? j.error ?? '');
                        const msg = j.message
                            ?? (typeof j.detail === 'string' ? j.detail
                            : j.detail && typeof j.detail === 'object' ? (j.detail as { message?: unknown }).message
                            : j.error);
                        detail = typeof msg === 'string' ? msg : '';
                    } catch { /* 非 JSON → e.message 原文展示 */ }
                    return (
                        <div className="my-8 flex flex-col items-center gap-2.5 text-center">
                            <span className="flex h-11 w-11 items-center justify-center rounded-xl border border-[color:var(--border-hairline)] bg-[color:var(--bg-surface)]" style={{ color: 'var(--status-danger)' }}>
                                <Icon name="warning" size={20} />
                            </span>
                            <div className="text-[13px] font-medium text-[color:var(--fg-primary)]">{t('stage.err.load')}</div>
                            {code && <div className="font-mono-ui text-[10.5px]" style={{ color: 'var(--status-danger)' }}>{code}</div>}
                            {detail && <div className="max-w-[420px] break-all font-mono-ui text-[10.5px] text-[color:var(--fg-faint)]">{detail}</div>}
                            <button className="ghost-btn mt-1 h-7 border border-[color:var(--border-hairline)] bg-[color:var(--bg-surface)] px-3 text-[11.5px]" onClick={() => void eng.reload()}>{t('panel.retry')}</button>
                        </div>
                    );
                })()}
                {s.live && !s.chat && !eng.loadErr && (
                    <div className="flex min-h-[220px] flex-col items-center justify-center px-6 py-10 text-center">
                        <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-[12px] border border-[color:var(--border-hairline)] bg-[color:var(--bg-surface)] text-[color:var(--fg-muted)]">
                            <Icon name="chat" size={20} />
                        </div>
                        <div className="heading-tight text-[13.5px] font-medium text-[color:var(--fg-primary)]">{t('chat.pick.title')}</div>
                        <div className="mt-1 max-w-[260px] text-[12px] leading-relaxed text-[color:var(--fg-muted)]">{t('chat.pick.desc')}</div>
                        {(s.isMobile || !s.sidebarOpen) && (
                            <button
                                className="mt-4 h-8 rounded-lg border border-[color:var(--border-strong)] bg-[color:var(--bg-surface)] px-3.5 text-[12px] font-medium text-[color:var(--fg-primary)] transition-colors hover:bg-[color:var(--bg-active)]"
                                onClick={() => (s.isMobile ? s.setMobileDrawer(true) : s.toggleSidebar())}
                            >
                                {t('chat.pick.btn')}
                            </button>
                        )}
                    </div>
                )}
                {hiddenCount > 0 && (
                    <div className="flex justify-center">
                        <button
                            type="button"
                            onClick={() => setShowAll(true)}
                            className="rounded-full border border-[color:var(--border-hairline)] bg-[color:var(--bg-surface)] px-3.5 py-1 text-[11.5px] text-[color:var(--fg-muted)] transition-colors hover:bg-[color:var(--bg-active)] hover:text-[color:var(--fg-primary)]"
                        >
                            {t('stage.olderFloors')} ({hiddenCount})
                        </button>
                    </div>
                )}
                {visible.map(({ m, origIdx }) => <Msg key={m.id} m={m} idx={origIdx} ops={eng.opsOf(m, origIdx)} greeting={m.id === greetingId} />)}
            </div>
        </div>
        </div>
    );
}

/* ——— 标准聊天形态 ——— */
export function ChatStage() {
    return (
        <StageFrame>
            <ChatFloors />
        </StageFrame>
    );
}
