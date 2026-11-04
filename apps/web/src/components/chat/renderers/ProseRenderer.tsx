// 'prose' — builtin novel-flow renderer (design §2: serif single column,
// 32px avatars, hover second-tier actions, receipts inline). All chrome here
// is renderer-owned: bubble-style renderers carry different chrome over the
// exact same props — that's the seam's self-proof.
import type { MessageReceipt, MessageViewModel } from '@uberge/protocol';
import { useI18n } from '../../../i18n';
import { Icon } from '../../Icon';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../../ui/collapsible';
import { IconButton } from '../../ui/icon-button';
import type { ConversationRendererProps } from './types';

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
    return (
        <div className="ub-prose read-scroll" style={{ overflowY: 'auto' }}>
            <div className="read-col" style={{ maxWidth: columnWidth }}>
                {view.messages.map((m) => <Message key={m.id} msg={m} actions={actions} />)}
            </div>
        </div>
    );
}
