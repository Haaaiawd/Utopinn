// 'prose' — builtin novel-flow renderer (design §2: serif single column,
// 32px avatars, hover second-tier actions, receipts inline). All chrome here
// is renderer-owned: bubble-style renderers carry different chrome over the
// exact same props — that's the seam's self-proof.
//
// TASK-026 消息惯例(RP 文本事实):
//   *动作*        → em.act 斜体弱墨
//   「…」/“…”/"…" → span.say 引号高亮(--quote token)
//   首条 assistant = greeting 楼层 → .greeting 版式待遇
//   streaming 空文 → .tdots 三点脉冲;有文 → .caret 照旧
import { Fragment, type ReactNode } from 'react';
import type { MessageReceipt, MessageViewModel } from '@utopinn/protocol';
import { useI18n } from '../../../i18n';
import { Icon } from '../../Icon';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../../ui/collapsible';
import { IconButton } from '../../ui/icon-button';
import type { ConversationRendererProps } from './types';

/**
 * 行内切分:动作段与引号段互斥匹配,一次 split 出全部锚点。
 * *…* 不吃换行/嵌套星号;引号三族(直角/弯引/直引)各自成对。
 */
const INLINE_RE = /(\*[^*\n]+\*|「[^」\n]*」|“[^”\n]*”|"[^"\n]*")/g;

function renderInline(text: string): ReactNode {
    const parts = text.split(INLINE_RE);
    if (parts.length === 1) return text;
    return parts.map((seg, i) => {
        if (!seg) return null;
        const head = seg[0]!;
        const tail = seg[seg.length - 1]!;
        if (seg.length > 1 && head === '*' && tail === '*') {
            return <em key={i} className="act">{seg.slice(1, -1)}</em>;
        }
        if (seg.length > 1 && (
            (head === '「' && tail === '」')
            || (head === '“' && tail === '”')
            || (head === '"' && tail === '"')
        )) {
            return <span key={i} className="say">{seg}</span>;
        }
        return <Fragment key={i}>{seg}</Fragment>;
    });
}

function Avatar({ name, url }: { name: string; url?: string }) {
    if (url) {
        return <span className="ava"><img src={url} alt="" /></span>;
    }
    return <span className="ava">{name.slice(0, 1) || '?'}</span>;
}

function ReceiptRow({ receipt }: { receipt: MessageReceipt }) {
    return (
        <Collapsible className="vreceipt">
            <CollapsibleTrigger className="vr-head">
                <span className="dot" />
                <span>{receipt.kind}</span>
                {receipt.summary && <span className="mut2">{receipt.summary}</span>}
            </CollapsibleTrigger>
            {(receipt.ops?.length ?? 0) > 0 && (
                <CollapsibleContent className="vr-body">
                    {receipt.ops!.map((op, i) => (
                        <div className="op" key={i}>
                            <span className="path">{op.op} {op.key}{op.path ? `.${op.path}` : ''}</span>
                            {' '}<span>{JSON.stringify(op.value)}</span>
                            {op.previous !== undefined && <span className="old"> {JSON.stringify(op.previous)}</span>}
                        </div>
                    ))}
                </CollapsibleContent>
            )}
        </Collapsible>
    );
}

function Message({ msg, actions, greeting }: {
    msg: MessageViewModel;
    actions: ConversationRendererProps['actions'];
    /** greeting = 首条 assistant 楼层,版式待遇(c.ai 开场先例)。 */
    greeting: boolean;
}) {
    const { t } = useI18n();
    const text = msg.displayContent ?? msg.content;
    const paragraphs = text.split(/\n{2,}/).filter(Boolean);
    const swipes = msg.swipes ?? [];
    const active = msg.activeSwipe ?? 0;

    return (
        <div className={`msg ${msg.role}${greeting ? ' greeting' : ''}`} data-id={msg.id}>
            <Avatar name={msg.name} url={msg.avatar?.url} />
            <div className="who">
                <span>{msg.name}</span>
            </div>
            {paragraphs.map((p, i) => <p key={i}>{renderInline(p)}</p>)}
            {/* typing:空文楼层画三点脉冲;有文则文尾随 caret。 */}
            {msg.streaming && (text
                ? <span className="caret" />
                : <span className="tdots" aria-hidden="true"><i /><i /><i /></span>
            )}
            {swipes.length > 1 && (
                <span className="swipe">
                    <button
                        type="button"
                        disabled={active <= 0}
                        onClick={() => actions.swipe(msg.id, active - 1)}
                        aria-label="prev"
                    ><Icon name="chevronLeft" size={12} /></button>
                    <span>{active + 1}/{swipes.length}</span>
                    <button
                        type="button"
                        disabled={active >= swipes.length - 1}
                        onClick={() => actions.swipe(msg.id, active + 1)}
                        aria-label="next"
                    ><Icon name="chevronRight" size={12} /></button>
                </span>
            )}
            <div className="acts">
                <IconButton size="icon-sm" label={t('chat.action.edit')} icon={<Icon name="edit" size={12} />}
                    onClick={() => actions.beginEdit(msg.id)} />
                <IconButton size="icon-sm" label={t('chat.action.regen')} icon={<Icon name="refresh" size={12} />}
                    onClick={() => actions.regenerate(msg.id)} />
                <IconButton size="icon-sm" label={t('chat.action.more')} icon={<Icon name="more" size={12} />}
                    onClick={() => actions.more(msg.id)} />
            </div>
            {(msg.receipts ?? []).map((r, i) => <ReceiptRow key={i} receipt={r} />)}
        </div>
    );
}

export function ProseRenderer({ view, actions }: ConversationRendererProps) {
    const columnWidth = view.typing.columnWidth ?? 'var(--read-width)';
    /** greeting 身份由宿主数据定(首条 assistant 楼层),渲染器不发明状态。 */
    const greetingId = view.messages.find((m) => m.role === 'assistant')?.id;
    return (
        <div className="ub-prose read-scroll" style={{ overflowY: 'auto' }}>
            <div className="read-col" style={{ maxWidth: columnWidth }}>
                {view.messages.map((m) => (
                    <Message key={m.id} msg={m} actions={actions} greeting={m.id === greetingId} />
                ))}
            </div>
        </div>
    );
}
