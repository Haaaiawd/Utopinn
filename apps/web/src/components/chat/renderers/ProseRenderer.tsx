// 'prose' — builtin novel-flow renderer (design §2: serif single column,
// 32px avatars, hover second-tier actions, receipts inline). All chrome here
// is renderer-owned: bubble-style renderers carry different chrome over the
// exact same props — that's the seam's self-proof.
import type { MessageReceipt, MessageViewModel } from '@uberge/protocol';
import { useI18n } from '../../../i18n';
import { Icon } from '../../Icon';
import type { ConversationRendererProps } from './types';

/** Stable, cheap hue from a name — placeholder until avatar URLs resolve. */
function hueFor(name: string): number {
    let h = 0;
    for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
    return h;
}

function Avatar({ name, url }: { name: string; url?: string }) {
    if (url) {
        return <span className="ava"><img src={url} alt="" /></span>;
    }
    return (
        <span className="ava" style={{ background: `hsl(${hueFor(name)} 32% 42%)` }}>
            {name.slice(0, 1) || '?'}
        </span>
    );
}

function ReceiptRow({ receipt }: { receipt: MessageReceipt }) {
    return (
        <details className="vreceipt">
            <summary className="vr-head">
                <span className="dot" />
                <span>{receipt.kind}</span>
                {receipt.summary && <span className="mut">{receipt.summary}</span>}
            </summary>
            {(receipt.ops?.length ?? 0) > 0 && (
                <div className="vr-body">
                    {receipt.ops!.map((op, i) => (
                        <div className="op" key={i}>
                            <span className="path">{op.op} {op.key}{op.path ? `.${op.path}` : ''}</span>
                            {' '}<span>{JSON.stringify(op.value)}</span>
                            {op.previous !== undefined && <span className="old"> {JSON.stringify(op.previous)}</span>}
                        </div>
                    ))}
                </div>
            )}
        </details>
    );
}

function Message({ msg, actions }: { msg: MessageViewModel; actions: ConversationRendererProps['actions'] }) {
    const { t } = useI18n();
    const text = msg.displayContent ?? msg.content;
    const paragraphs = text.split(/\n{2,}/).filter(Boolean);
    const swipes = msg.swipes ?? [];
    const active = msg.activeSwipe ?? 0;

    return (
        <div className={`msg ${msg.role}`} data-id={msg.id}>
            <Avatar name={msg.name} url={msg.avatar?.url} />
            <div className="who">
                <span>{msg.name}</span>
            </div>
            {paragraphs.map((p, i) => <p key={i}>{p}</p>)}
            {msg.streaming && <span className="caret" />}
            {swipes.length > 1 && (
                <span className="swipe">
                    <button
                        type="button"
                        disabled={active <= 0}
                        onClick={() => actions.swipe(msg.id, active - 1)}
                        aria-label="prev"
                    ><Icon name="chevronLeft" size={11} /></button>
                    <span>{active + 1}/{swipes.length}</span>
                    <button
                        type="button"
                        disabled={active >= swipes.length - 1}
                        onClick={() => actions.swipe(msg.id, active + 1)}
                        aria-label="next"
                    ><Icon name="chevronRight" size={11} /></button>
                </span>
            )}
            <div className="acts">
                <button type="button" className="ibtn" title={t('chat.action.edit')}
                    onClick={() => actions.beginEdit(msg.id)}>
                    <Icon name="edit" size={12} />
                </button>
                <button type="button" className="ibtn" title={t('chat.action.regen')}
                    onClick={() => actions.regenerate(msg.id)}>
                    <Icon name="refresh" size={12} />
                </button>
                <button type="button" className="ibtn" title={t('chat.action.more')}
                    onClick={() => actions.more(msg.id)}>
                    <Icon name="more" size={12} />
                </button>
            </div>
            {(msg.receipts ?? []).map((r, i) => <ReceiptRow key={i} receipt={r} />)}
        </div>
    );
}

export function ProseRenderer({ view, actions }: ConversationRendererProps) {
    const columnWidth = view.typing.columnWidth ?? 'var(--read-width)';
    return (
        <div className="ub-prose read-scroll" style={{ overflowY: 'auto' }}>
            <div className="read-col" style={{ maxWidth: columnWidth }}>
                {view.messages.map((m) => <Message key={m.id} msg={m} actions={actions} />)}
            </div>
        </div>
    );
}
