// 中列舞台:stage.form 贡献点按 chat.stage 分发,缺省标准聊天形态。
// 规范稿中列:stage-header(标题 + 模型胶囊 + 预设胶囊 + 三弹层)|
// 消息流 | composer-shell。生成走 streamJob;mock 回文走 MOCK_REPLY_*。
import { useEffect, useRef, useState } from 'react';
import type { MessageViewModel } from '@utopinn/protocol';
import { useShell, useContribs } from '../../kernel/context';
import { useI18n } from '../../i18n';
import { Icon } from '../Icon';
import { postGenerate, streamJob } from '../../api/generate';
import { MOCK_MESSAGES, MOCK_REPLY_CHAT, MOCK_REPLY_CONTINUE, MOCK_REPLY_REGEN, MOCK_IMPERSONATE_DRAFT } from '../../api/mock';

let mid = 100;
const mkMsg = (role: 'user' | 'assistant', content: string, streaming = false): MessageViewModel => ({
    id: ++mid, role, name: role === 'user' ? 'haa' : '云栖宗 · 陈修线', content, streaming, timestamp: Date.now(),
});

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

function SlashMenu({ onPick, onClose }: { onPick: (cmd: string) => void; onClose: () => void }) {
    const { t } = useI18n();
    const cmds: [string, string][] = [['/continue', 'slash.continue'], ['/regen', 'slash.regen'], ['/impersonate', 'slash.impersonate']];
    return (
        <>
            <div className="fixed inset-0 z-[29]" onClick={onClose} />
            <div className="pop-in absolute bottom-full left-0 z-[30] mb-2 w-[220px] rounded-[12px] p-1.5" style={{ background: 'var(--bg-elevated)', boxShadow: 'var(--shadow-pop)' }}>
                {cmds.map(([cmd, k]) => (
                    <button key={cmd} className="inset-row-btn flex w-full items-center gap-2.5 rounded-md px-2 py-[7px] text-[11.5px]" onClick={() => onPick(cmd)}>
                        <code className="font-mono-ui text-[10.5px] text-[color:var(--brand)]">{cmd}</code>
                        <span className="truncate text-[color:var(--fg-muted)]">{t(k)}</span>
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

/* ——— 消息泡(规范稿:assistant=头像行+正文,user=右列深泡) ——— */
function Msg({ m, idx }: { m: MessageViewModel; idx: number }) {
    const s = useShell();
    const [thinkOpen, setThinkOpen] = useState(false);
    const isUser = m.role === 'user';
    const name = m.name || (isUser ? 'haa' : (s.chat ? (s.cards.get(s.chat.charDir)?.name ?? s.chat.charDir) : 'Seraphina'));
    const time = typeof m.timestamp === 'number' ? new Date(m.timestamp).toTimeString().slice(0, 5) : '';
    if (isUser) {
        return (
            <div className="group/msg mx-auto flex w-full max-w-[680px] justify-end px-1 py-2">
                <div className="max-w-[78%] rounded-[12px] px-3.5 py-2.5" style={{ background: 'var(--bg-surface-2, var(--bg-surface))', border: '1px solid var(--border-subtle)', boxShadow: 'var(--shadow-card)' }}>
                    <div className="chat-body-text whitespace-pre-wrap text-[color:var(--fg-primary)]" style={{ fontSize: s.chatSettings.fontSize }}>
                        {m.displayContent ?? m.content}
                    </div>
                </div>
            </div>
        );
    }
    return (
        <div className="group/msg mx-auto w-full max-w-[680px] px-1 py-3">
            <div className="mb-1.5 flex items-center gap-2">
                <span className="char-avatar-ring flex h-6 w-6 items-center justify-center text-[9.5px] font-semibold" style={{ background: 'linear-gradient(135deg,#4a6a8a,#2a3a4a)', color: 'var(--fg-primary)' }}>
                    {name[0]}
                </span>
                <span className="text-[11.5px] font-medium text-[color:var(--fg-primary)]">{name}</span>
                {s.chatSettings.showFloorNum && <span className="font-mono-ui text-[9px] text-[color:var(--fg-faint)]">#{idx + 1}</span>}
                {time && <span className="font-mono-ui text-[9px] text-[color:var(--fg-faint)]">{time}</span>}
                {m.reasoning && (
                    <button className="flex items-center gap-1 text-[10px] text-[color:var(--fg-faint)]" onClick={() => setThinkOpen(!thinkOpen)}>
                        思考链 <Icon name={thinkOpen ? 'chevronDown' : 'chevronRight'} size={8} />
                    </button>
                )}
                <span className="ml-auto flex gap-0.5 opacity-0 transition-opacity group-hover/msg:opacity-100">
                    <button className="ghost-btn h-5 w-5" title="edit"><Icon name="pencil" size={10} /></button>
                    <button className="ghost-btn h-5 w-5" title="fork"><Icon name="gitFork" size={10} /></button>
                    <button className="ghost-btn h-5 w-5" title="del"><Icon name="trash" size={10} /></button>
                </span>
            </div>
            {thinkOpen && m.reasoning && (
                <div className="mb-1.5 ml-8 rounded-lg bg-[color:var(--bg-surface)] p-2.5 font-mono-ui text-[10px] leading-relaxed text-[color:var(--fg-muted)]">{m.reasoning}</div>
            )}
            <div className="chat-body-text whitespace-pre-wrap text-[color:var(--fg-primary)]" style={{ fontSize: s.chatSettings.fontSize }}>
                {m.displayContent ?? m.content}
                {m.streaming && <span className="cursor-bar" />}
            </div>
        </div>
    );
}

/* ——— 标准聊天形态 ——— */
export function ChatStage() {
    const { t } = useI18n();
    const s = useShell();
    const [msgs, setMsgs] = useState<MessageViewModel[]>(MOCK_MESSAGES);
    const [draft, setDraft] = useState('');
    const [busy, setBusy] = useState(false);
    const [menu, setMenu] = useState<'none' | 'context' | 'slash' | 'preset'>('none');
    const scrollRef = useRef<HTMLDivElement>(null);
    const model = s.models.find((m) => m.id === s.activeModel);

    useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }); }, [msgs.length]);

    const pushReply = (content: string) => setMsgs((prev) => [...prev, mkMsg('assistant', content)]);

    const send = async (text: string) => {
        const v = text.trim();
        if (!v || busy) return;
        setDraft('');
        setMsgs((prev) => [...prev, mkMsg('user', v)]);
        setBusy(true);
        if (s.live && s.chat) {
            try {
                const rid = ++mid + 1;
                setMsgs((prev) => [...prev, { ...mkMsg('assistant', '', true), id: rid }]);
                // SPEC-DATA: 服务端 generate 是会话续写 —— mes 不上行,
                // 真实用户楼应先进 chat append 端点(未接),这里诚实标注。
                const { jobId } = await postGenerate({
                    charDir: s.chat.charDir, chatName: s.chat.chatName,
                    user: s.persona ?? { name: 'haa' },
                });
                await streamJob(jobId, {
                    onDelta: (acc) => {
                        setMsgs((prev) => prev.map((m) => (m.id === rid ? { ...m, content: acc } : m)));
                    },
                    onEnd: () => setMsgs((prev) => prev.map((m) => (m.id === rid ? { ...m, streaming: false } : m))),
                    onError: (msg) => {
                        setMsgs((prev) => prev.map((m) => (m.id === rid ? { ...m, streaming: false, content: m.content || `⚠ ${msg}` } : m)));
                    },
                });
            } catch {
                s.hint(t('chat.send.failed'), true);
            }
        } else {
            setTimeout(() => pushReply(MOCK_REPLY_CHAT), 600);
        }
        setBusy(false);
    };

    const onSlash = (cmd: string) => {
        setMenu('none');
        if (cmd === '/impersonate') { setDraft(MOCK_IMPERSONATE_DRAFT); return; }
        setMsgs((prev) => [...prev, mkMsg('user', cmd)]);
        setTimeout(() => pushReply(cmd === '/continue' ? MOCK_REPLY_CONTINUE : MOCK_REPLY_REGEN), 500);
    };

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
            {/* 消息流 */}
            <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
                {msgs.map((m, i) => <Msg key={m.id} m={m} idx={i} />)}
            </div>
            {/* composer-shell:textarea + 底行(/ · MVU 胶囊 · 预设/模型⌄ · 发送) */}
            <div className="shrink-0 px-4 pb-4 pt-1">
                <div className="composer-shell relative mx-auto w-full max-w-[680px] rounded-[14px]">
                    {menu === 'slash' && <SlashMenu onPick={onSlash} onClose={() => setMenu('none')} />}
                    {menu === 'context' && <ContextPop onClose={() => setMenu('none')} />}
                    {menu === 'preset' && <PresetPop onClose={() => setMenu('none')} />}
                    <textarea
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(draft); }
                            if (e.key === '/' && !draft) setMenu('slash');
                        }}
                        placeholder={t('composer.placeholder')}
                        rows={3}
                        className="chat-body-text w-full resize-none bg-transparent px-3.5 pb-1 pt-3 outline-none"
                    />
                    <div className="flex items-center gap-1.5 px-2.5 pb-2.5">
                        <button className="ghost-btn h-7 w-7 rounded-md border border-[color:var(--border-subtle)]" onClick={() => setMenu(menu === 'slash' ? 'none' : 'slash')} title="/">
                            <Icon name="slash" size={13} />
                        </button>
                        <button className="ghost-btn h-7 w-7" title={t('composer.attach')}><Icon name="paperclip" size={13} /></button>
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
                            className="ghost-btn h-7 gap-1 rounded-md px-2 font-mono-ui text-[10.5px] text-[color:var(--fg-secondary)]"
                            style={menu === 'preset' ? { color: 'var(--brand)' } : undefined}
                            onClick={() => setMenu(menu === 'preset' ? 'none' : 'preset')}
                        >
                            预设/模型 <Icon name="chevronDown" size={9} />
                        </button>
                        <button
                            className="ghost-btn h-7 w-7 rounded-full"
                            style={{ background: 'var(--brand)', color: 'var(--brand-fg)' }}
                            onClick={() => void send(draft)}
                            disabled={busy}
                            title={t('composer.send')}
                        >
                            <Icon name="send" size={13} />
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
