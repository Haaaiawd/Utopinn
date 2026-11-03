// Chat view — the host around the renderer seam. It owns message state,
// swipe/edit semantics and host chrome (top bar, composer); message DRAWING
// is delegated to `renderer` (default: prose). A bubble renderer swaps in
// with zero changes here — same props, different chrome (design §2).
//
// View tabs: 对话 (the conversation) | 提示词预览 (/api/uberge/preview output
// rendered through the SAME renderer — the assembled prompt is just a
// message list, which is exactly what the seam consumes).
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ConversationView, MessageViewModel, RendererActions, RendererMessageRole } from '@uberge/protocol';
import { useI18n } from '../../i18n';
import { MOCK_MESSAGES } from '../../api/mock';
import type { ChatSummary, PreviewResponse, PreviewResult } from '../../types';
import { Icon } from '../Icon';
import { Composer } from './Composer';
import { ProseRenderer } from './renderers/ProseRenderer';
import type { ConversationRendererComponent } from './renderers/types';

const USER_NAME = '旅人';

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

export interface ChatViewProps {
    chat: ChatSummary;
    /** Pluggable conversation renderer — defaults to builtin prose. */
    renderer?: ConversationRendererComponent;
    preview: PreviewResult | null;
    previewLoading: boolean;
    onRunPreview: () => void;
    onTogglePanel: () => void;
    /** Status-bar hint for unwired actions. */
    onHint: (msg: string) => void;
}

export function ChatView({
    chat,
    renderer: Renderer = ProseRenderer,
    preview,
    previewLoading,
    onRunPreview,
    onTogglePanel,
    onHint,
}: ChatViewProps) {
    const { t } = useI18n();
    const [tab, setTab] = useState<'conversation' | 'preview'>('conversation');
    const [messages, setMessages] = useState<MessageViewModel[]>(() =>
        MOCK_MESSAGES.map((m) => ({ ...m })),
    );
    const nextId = useRef(messages.length);

    // Prove the wiring on first paint: dry-run the assembly for this chat.
    useEffect(() => {
        onRunPreview();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [chat.id]);

    const actions = useMemo<RendererActions>(() => ({
        swipe: (messageId, index) => {
            // Host-owned semantics: swipe switch replaces the whole floor
            // (design R5 — renderers never implement swipe meaning).
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
        beginEdit: () => onHint(t('chat.action.unwired')),
        submitEdit: () => onHint(t('chat.action.unwired')),
        regenerate: () => onHint(t('chat.action.unwired')),
        branch: () => onHint(t('chat.action.unwired')),
        more: () => onHint(t('chat.action.unwired')),
    }), [onHint, t]);

    const conversationView = useMemo<ConversationView>(() => ({
        chatRef: { kind: 'chat', character: chat.charDir, file: `${chat.chatName}.jsonl` },
        messages,
        typing: {},
        revision: 0,
    }), [chat, messages]);

    const previewView = useMemo<ConversationView | null>(() =>
        preview?.data ? previewToView(preview.data) : null,
    [preview]);

    const sendDraft = (text: string) => {
        setMessages((prev) => [
            ...prev,
            { id: nextId.current++, role: 'user', name: USER_NAME, content: text },
        ]);
        onHint(t('chat.send.draftOnly'));
    };

    return (
        <>
            <div className="ctbar">
                <h1>{chat.title}</h1>
                <span className="sub">{chat.charDir} · {chat.chatName}.jsonl</span>
                {preview?.mock && <span className="chip warn">{t('chat.preview.mock')}</span>}
                <span className="grow" />
                <div className="vtabs" role="tablist">
                    <button type="button" className={tab === 'conversation' ? 'on' : ''}
                        onClick={() => setTab('conversation')}>
                        {t('chat.tabs.conversation')}
                    </button>
                    <button type="button" className={tab === 'preview' ? 'on' : ''}
                        onClick={() => setTab('preview')}>
                        {t('chat.tabs.preview')}
                    </button>
                </div>
                <button type="button" className="ibtn" title={t('chat.preview')}
                    disabled={previewLoading} onClick={onRunPreview}>
                    <Icon name="eye" size={15} />
                </button>
                <button type="button" className="ibtn" title={t('menu.view.togglePanel')}
                    onClick={onTogglePanel}>
                    <Icon name="panelRight" size={15} />
                </button>
            </div>

            <div className="read-zone">
                {tab === 'conversation' ? (
                    <Renderer view={conversationView} actions={actions} />
                ) : previewView ? (
                    <Renderer view={previewView} actions={actions} />
                ) : (
                    <div className="empty-hint">
                        <div className="glyph"><Icon name="eye" size={22} /></div>
                        {preview?.error
                            ? <p>{t('chat.preview.failed')}: {preview.error}</p>
                            : <p>{previewLoading ? '…' : t('chat.preview.empty')}</p>}
                    </div>
                )}
                {tab === 'conversation' && <Composer onSend={sendDraft} />}
            </div>
        </>
    );
}
