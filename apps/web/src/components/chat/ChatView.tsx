// Chat view — the host around the renderer seam. It owns message state,
// swipe/edit semantics and host chrome (top bar, composer); message DRAWING
// is delegated to `renderer` (default: prose). A bubble renderer swaps in
// with zero changes here — same props, different chrome (design §2).
//
// View tabs: 对话 (the conversation) | 提示词预览 (/api/utopinn/preview output
// rendered through the SAME renderer — the assembled prompt is just a
// message list, which is exactly what the seam consumes).
//
// 舞台头(TASK-026):角色头像/名/会话名 + persona 徽标(快切,本地选择态,
// 生成时以 body.user 携带)+ 绑定书/预设 chip(有则显示,无为空态)。
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ConversationView, MessageViewModel, RendererActions, RendererMessageRole } from '@utopinn/protocol';
import { useI18n } from '../../i18n';
import { MOCK_MESSAGES, MOCK_PERSONAS } from '../../api/mock';
import { cardData, charImageUrl, getCharacter, type CardDoc } from '../../api/characters';
import { listPersonas, type PersonaItem } from '../../api/personas';
import { getChat, appendUserMessage, patchSwipe } from '../../api/chats';
import { postGenerate, streamJob } from '../../api/generate';
import { useContribs, useShell } from '../../kernel/context';
import type { PreviewResponse } from '../../types';
import { Icon } from '../Icon';
import { Tabs, TabsList, TabsTrigger } from '../ui/tabs';
import {
    DropdownMenu, DropdownMenuContent, DropdownMenuItem,
    DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { Composer } from './Composer';

/** persona 未装载/列表为空时的兜底身份(与 App 预览兜底同名)。 */
const USER_NAME = '旅人';

/** per-chat persona 选择态的本地键(服务端无 per-chat 端点,TASK-026 诚实路径)。 */
const personaKey = (chatId: string) => `utopinn.persona.${chatId}`;

/** Assembled-prompt rows → floors. Preview messages carry {role,content,name}. */
function previewToView(data: PreviewResponse): ConversationView {
    const roleOf = (r: string): RendererMessageRole =>
        r === 'assistant' ? 'assistant' : r === 'user' ? 'user' : 'system';
    return {
        messages: data.messages.map((m, i): MessageViewModel => ({
            id: i,
            role: roleOf(m.role),
            name: m.name ?? m.role,
            content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content, null, 2),
        })),
        typing: {},
        revision: 0,
    };
}

/** 渲染器 = renderer 贡献点里 order 最小的那条;无注册回落不该发生(feature 兜底)。 */
function useRenderer() {
    const renderers = useContribs('renderer');
    return useMemo(() => [...renderers].sort((a, b) => a.order - b.order)[0]?.Component, [renderers]);
}

/** 舞台头圆形角色脸:真卡图,404/无图落首字(同 sb-group-ava 回落)。 */
function StageAvatar({ name, file }: { name: string; file: string | null }) {
    const [err, setErr] = useState(false);
    if (!file || err) return <span className="stage-ava">{name.slice(0, 1) || '?'}</span>;
    return (
        <span className="stage-ava">
            <img src={charImageUrl(file)} alt="" onError={() => setErr(true)} />
        </span>
    );
}

export function ChatView() {
    const { t } = useI18n();
    const {
        chat, preview, previewLoading, runPreview, hint, live,
        cards, persona, setPersona, setView, models, activeModel, setActiveModel,
    } = useShell();
    const ctbarActions = useContribs('ctbar.chat');
    const Renderer = useRenderer();
    const [tab, setTab] = useState<'conversation' | 'preview'>('conversation');
    const [messages, setMessages] = useState<MessageViewModel[]>(() =>
        MOCK_MESSAGES.map((m) => ({ ...m })),
    );
    const [streaming, setStreaming] = useState(false);
    const [personas, setPersonas] = useState<PersonaItem[]>([]);
    const [cardDoc, setCardDoc] = useState<CardDoc | null>(null);
    const nextId = useRef(messages.length);
    const abortRef = useRef<(() => void) | null>(null);

    const card = chat ? cards.get(chat.charDir) : undefined;
    /** 显示名 = 卡名 → charDir;mock 的 group:'ungrouped' 不做名源。 */
    const charName = card?.name ?? chat?.charDir ?? '';
    const charImg = card?.avatar ?? (/\.(png|webp)$/i.test(card?.fileName ?? '') ? card!.fileName : null);

    // persona 列表:在线真拉,离线回 MOCK(列表形态不变,写路径本就离线短路)。
    useEffect(() => {
        let dead = false;
        listPersonas()
            .then((r) => { if (!dead) setPersonas(r.items); })
            .catch(() => { if (!dead) setPersonas(MOCK_PERSONAS); });
        return () => { dead = true; };
    }, [live]);

    // 每个会话一个 persona 选择:本地存的 avatar → 默认 persona → 列表头 → 兜底名。
    useEffect(() => {
        if (!chat) return;
        if (personas.length === 0) { setPersona(null); return; }
        let stored: string | null = null;
        try { stored = localStorage.getItem(personaKey(chat.id)); } catch { /* storage off */ }
        const hit = personas.find((p) => p.avatar === stored)
            ?? personas.find((p) => p.isDefault)
            ?? personas[0];
        if (!hit) return; // noUncheckedIndexedAccess:personas[0] 可为 undefined
        setPersona({ avatar: hit.avatar, name: hit.name, description: hit.description });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [chat?.id, personas]);

    // 绑定书读数:卡文档 extensions.world / character_book(角色页同源字段)。
    useEffect(() => {
        if (!live || !chat) { setCardDoc(null); return; }
        let dead = false;
        getCharacter(chat.charDir)
            .then((d) => { if (!dead) setCardDoc(d); })
            .catch(() => { if (!dead) setCardDoc(null); });
        return () => { dead = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [live, chat?.charDir]);

    const pickPersona = (p: PersonaItem) => {
        setPersona({ avatar: p.avatar, name: p.name, description: p.description });
        try { if (chat) localStorage.setItem(personaKey(chat.id), p.avatar); } catch { /* storage off */ }
    };

    // Prove the wiring on first paint: dry-run the assembly for this chat.
    useEffect(() => {
        runPreview();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [chat?.id]);

    // persona 进组装 → 换 persona 后既有预览作废,重跑一次保读数诚实。
    useEffect(() => {
        if (preview) runPreview();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [persona]);

    // Real chat load — floors replace mock content when the server is live.
    // Falls back to mock silently labelled via the preview badge/hint path.
    useEffect(() => {
        if (!live || !chat) return;
        let dead = false;
        getChat(chat.charDir, chat.chatName)
            .then(({ messages: loaded }) => {
                if (dead || !loaded.length) return;
                nextId.current = loaded.length;
                setMessages(loaded);
            })
            .catch(() => { /* 404/offline → keep mock floors, honest badge */ });
        return () => { dead = true; };
    }, [live, chat]);

    const actions = useMemo<RendererActions>(() => ({
        swipe: (messageId, index) => {
            // Host-owned semantics: swipe switch replaces the whole floor
            // (design R5 — renderers never implement swipe meaning). Loaded
            // floors carry the storage index as id → persist swipe_id.
            if (live) {
                patchSwipe(chat!.charDir, chat!.chatName, Number(messageId), index)
                    .catch((e) => hint(`${t('chat.swipe')} ${t('chat.send.failed')}: ${e instanceof Error ? e.message : e}`, true));
            }
            setMessages((prev) => prev.map((m) => {
                if (m.id !== messageId || !m.swipes?.[index]) return m;
                const s = m.swipes[index];
                return {
                    ...m,
                    activeSwipe: index,
                    content: s.content,
                    reasoning: s.reasoning,
                    receipts: s.receipts ?? m.receipts,
                };
            }));
        },
        beginEdit: () => hint(t('chat.action.unwired')),
        submitEdit: () => hint(t('chat.action.unwired')),
        regenerate: () => hint(t('chat.action.unwired')),
        branch: () => hint(t('chat.action.unwired')),
        more: () => hint(t('chat.action.unwired')),
    }), [hint, t, live, chat]);

    const conversationView = useMemo<ConversationView>(() => ({
        chatRef: chat ? { kind: 'chat', character: chat.charDir, file: `${chat.chatName}.jsonl` } : undefined,
        messages,
        typing: {},
        revision: 0,
    }), [chat, messages]);

    const previewView = useMemo<ConversationView | null>(() =>
        preview?.data ? previewToView(preview.data) : null,
    [preview]);

    /** 生效用户身份:persona 选择优先,未装载落兜底名。 */
    const userName = persona?.name?.trim() || USER_NAME;

    const sendDraft = (text: string) => {
        if (!live || streaming) {
            setMessages((prev) => [
                ...prev,
                { id: nextId.current++, role: 'user', name: userName, content: text },
            ]);
            hint(t('chat.send.draftOnly'));
            return;
        }
        void sendLive(text);
    };

    /**
     * Real send: append user floor → /api/utopinn/generate → WS stream folds
     * deltas into a live assistant floor → on end the server has persisted
     * the reply, so we reload the chat for ground truth (swipes/receipts).
     * persona 选择经 body.user 进组装(服务端唯一生效路径)。
     */
    const sendLive = async (text: string) => {
        abortRef.current?.();
        setStreaming(true);
        setMessages((prev) => [
            ...prev,
            { id: nextId.current++, role: 'user', name: userName, content: text, timestamp: Date.now() },
        ]);
        const floorId = nextId.current++;
        const upsertFloor = (content: string) =>
            setMessages((prev) => {
                const i = prev.findIndex((m) => m.id === floorId);
                const floor: MessageViewModel = { id: floorId, role: 'assistant', name: charName || chat!.charDir, content, streaming: true };
                return i < 0 ? [...prev, floor] : prev.map((m) => (m.id === floorId ? floor : m));
            });
        try {
            await appendUserMessage(chat!.charDir, chat!.chatName, userName, text);
            const { jobId } = await postGenerate({
                charDir: chat!.charDir, chatName: chat!.chatName, type: 'normal',
                user: { name: userName, description: persona?.description },
            });
            abortRef.current = await streamJob(jobId, {
                onDelta: (acc) => upsertFloor(acc),
                onEnd: () => {
                    setStreaming(false);
                    void getChat(chat!.charDir, chat!.chatName)
                        .then(({ messages: loaded }) => {
                            if (loaded.length) { nextId.current = loaded.length; setMessages(loaded); }
                        })
                        .catch(() => { /* keep streamed text */ });
                },
                onError: (msg) => { setStreaming(false); hint(t('chat.send.failed') + ': ' + msg, true); },
            });
        } catch (e) {
            setStreaming(false);
            hint(t('chat.send.failed') + ': ' + (e instanceof Error ? e.message : String(e)), true);
        }
    };

    // —— 舞台头读数:绑定书(卡声明)/预设(上次组装)/WI 命中数 ——
    const docData = cardData(cardDoc);
    const boundWorld = typeof docData.extensions?.world === 'string' ? docData.extensions.world : '';
    const embeddedBook = docData.character_book != null && typeof docData.character_book === 'object';
    const presetName = preview?.data?.sources?.presetName ?? '';
    const wiCount = preview?.data?.sources?.worldInfoActivated ?? 0;

    return (
        <>
            <div className="ctbar">
                <StageAvatar name={charName} file={charImg} />
                <span className="stage-id">
                    <h1>{charName || chat?.title}</h1>
                    {chat && <span className="stage-sub">{chat.title}</span>}
                </span>
                {/* persona 徽标:点开快切;选择态存本地,生成时携带(设计 web-rp-form §2.3)。
                    顺序按 mockup:persona ▾ · 书×N · 预设。 */}
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <button type="button" className="stage-persona" aria-label={t('stage.persona.pick')}>
                            <Icon name="user" size={12} />
                            <span className="stage-persona-name">{userName}</span>
                            <Icon name="chevronDown" size={12} />
                        </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent side="bottom" align="start">
                        <DropdownMenuLabel>{t('stage.persona')}</DropdownMenuLabel>
                        {personas.map((p) => (
                            <DropdownMenuItem key={p.avatar} onClick={() => pickPersona(p)}>
                                <Icon name={p.avatar === persona?.avatar ? 'check' : 'user'} size={12} />
                                <span className="stage-persona-item">{p.name || p.avatar}</span>
                                {p.isDefault && <span className="mut ml-auto">{t('persona.default')}</span>}
                            </DropdownMenuItem>
                        ))}
                        {personas.length === 0 && (
                            <DropdownMenuItem disabled>{t('stage.persona.none')}</DropdownMenuItem>
                        )}
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onClick={() => setView('settings')}>
                            <Icon name="settings" size={12} />{t('stage.persona.manage')}
                        </DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
                {(boundWorld || embeddedBook) && (
                    <span className="stage-chip" title={t('stage.world')}>
                        <Icon name="book" size={12} />
                        <span className="stage-chip-lbl">{boundWorld || t('stage.book.embedded')}</span>
                        {wiCount > 0 && <span className="stage-chip-n">×{wiCount}</span>}
                    </span>
                )}
                {presetName && (
                    <span className="stage-chip" title={t('stage.preset')}>
                        <Icon name="zap" size={12} />
                        <span className="stage-chip-lbl">{presetName}</span>
                    </span>
                )}
                {/* 模型胶囊(规范稿 context capsule)—— SPEC-DATA: 待接,
                    目录是 ctx mock;生成时未携带进 body。 */}
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <button type="button" className="stage-chip stage-model" title={t('stage.model')}>
                            <Icon name="sparkles" size={12} />
                            <span className="stage-chip-lbl">{models.find((m) => m.id === activeModel)?.name ?? '—'}</span>
                            <Icon name="chevronDown" size={10} />
                        </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent side="bottom" align="start">
                        <DropdownMenuLabel>{t('stage.model')}</DropdownMenuLabel>
                        {models.map((m) => (
                            <DropdownMenuItem key={m.id} onClick={() => setActiveModel(m.id)}>
                                <Icon name={m.id === activeModel ? 'check' : 'sparkles'} size={12} />
                                <span className="stage-persona-item">{m.name}</span>
                                <span className="mut ml-auto">{m.context}</span>
                            </DropdownMenuItem>
                        ))}
                    </DropdownMenuContent>
                </DropdownMenu>
                <span className="grow" />
                <Tabs value={tab} onValueChange={(v) => {
                    setTab(v as typeof tab);
                    // 预览按需装配:首次切到 preview tab 才打 /preview,不做常驻请求
                    if (v === 'preview' && !preview && !previewLoading) runPreview();
                }}>
                    <TabsList>
                        <TabsTrigger value="conversation">{t('chat.tabs.conversation')}</TabsTrigger>
                        <TabsTrigger value="preview">{t('chat.tabs.preview')}</TabsTrigger>
                    </TabsList>
                </Tabs>
                {/* ctbar.chat 贡献位:"+" 加板块 / 沉浸 等动作由 feature 注册进来。 */}
                {[...ctbarActions].sort((a, b) => a.order - b.order).map((a) => {
                    const Action = a.Component;
                    return <Action key={a.id} />;
                })}
            </div>

            <div className="read-zone">
                {/* 零会话(门厅首入且库空)→ 诚实空态,Composer 不挂(chat 为 null)。 */}
                {!chat ? (
                    <div className="empty-hint">
                        <div className="glyph"><Icon name="chat" size={22} /></div>
                        <p>{t('chat.noChat')}</p>
                    </div>
                ) : !Renderer ? null : tab === 'conversation' ? (
                    <Renderer view={conversationView} actions={actions} />
                ) : previewView ? (
                    <Renderer view={previewView} actions={actions} />
                ) : (
                    <div className="empty-hint">
                        <div className="glyph"><Icon name="eye" size={22} /></div>
                        {preview?.error
                            ? <p className="err">{t('chat.preview.failed')}: {preview.error}</p>
                            : <p>{previewLoading ? '…' : t('chat.preview.empty')}</p>}
                    </div>
                )}
                {chat && tab === 'conversation' && <Composer onSend={sendDraft} disabled={streaming} />}
            </div>
        </>
    );
}
