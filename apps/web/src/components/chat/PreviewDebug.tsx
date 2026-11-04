// Diagnostics face for /api/uberge/preview — the request-inspector spirit
// (web-ia.md §11 diagnostics domain). Shows sources + assembly trace; the
// assembled messages themselves render in the main area via the renderer seam.
import { useI18n } from '../../i18n';
import type { PreviewResult } from '../../types';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible';
import { Icon } from '../Icon';

export function PreviewDebug({ result }: { result: PreviewResult | null }) {
    const { t } = useI18n();

    if (!result || (!result.data && !result.error)) {
        return (
            <div className="pnl-empty">
                <span className="glyph"><Icon name="pulse" size={18} /></span>
                <p>{t('panel.diag.noData')}</p>
            </div>
        );
    }
    if (result.error) {
        return <div className="err">{t('chat.preview.failed')}: {result.error}</div>;
    }

    const { data, mock } = result;
    if (!data) return null;
    const { trace, sources } = data;

    return (
        <div>
            {mock && <div className="warn" style={{ marginBottom: 10 }}>{t('chat.preview.mock')}</div>}

            <Collapsible className="fold" defaultOpen>
                <CollapsibleTrigger className="fold-trigger">
                    <Icon name="chevronRight" size={12} className="fold-caret" />{t('diag.sources')}
                </CollapsibleTrigger>
                <CollapsibleContent className="fold-body">
                    <dl className="diag-kv">
                        <dt>{t('diag.preset')}</dt><dd>{sources?.presetName ?? '—'}</dd>
                        <dt>{t('diag.model')}</dt><dd>{sources?.model ?? '—'}</dd>
                        <dt>{t('diag.wi')}</dt><dd>{sources?.worldInfoActivated ?? 0}</dd>
                        <dt>{t('diag.chatCount')}</dt><dd>{sources?.chatCount ?? 0}</dd>
                    </dl>
                </CollapsibleContent>
            </Collapsible>

            {trace && (
                <Collapsible className="fold" defaultOpen>
                    <CollapsibleTrigger className="fold-trigger">
                        <Icon name="chevronRight" size={12} className="fold-caret" />{t('diag.trace')}
                    </CollapsibleTrigger>
                    <CollapsibleContent className="fold-body">
                        <dl className="diag-kv" style={{ marginBottom: 8 }}>
                            <dt>{t('diag.budget')}</dt><dd>{trace.tokenBudget}</dd>
                            <dt>{t('diag.remaining')}</dt><dd>{trace.remainingBudget}</dd>
                            <dt>{t('diag.dropped')}</dt><dd>{trace.droppedChatCount}</dd>
                            <dt>{t('diag.injected')}</dt><dd>{trace.injectedCount}</dd>
                        </dl>
                        <table className="diag-table">
                            <thead>
                                <tr><th>{t('diag.collections')}</th><th>{t('diag.col.tokens')}</th><th>{t('diag.col.count')}</th></tr>
                            </thead>
                            <tbody>
                                {trace.collections.map((c) => (
                                    <tr key={c.identifier}>
                                        <td>{c.identifier}</td>
                                        <td>{c.tokens}</td>
                                        <td>{c.count}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </CollapsibleContent>
                </Collapsible>
            )}

            <Collapsible className="fold">
                <CollapsibleTrigger className="fold-trigger">
                    <Icon name="chevronRight" size={12} className="fold-caret" />{t('diag.messages')} ({data.messages.length})
                </CollapsibleTrigger>
                <CollapsibleContent className="fold-body">
                    <dl className="diag-kv">
                        {data.messages.map((m, i) => (
                            <span key={i} style={{ display: 'contents' }}>
                                <dt><span className="diag-src">{m.name ?? m.role}</span></dt>
                                <dd style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                    {typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}
                                </dd>
                            </span>
                        ))}
                    </dl>
                </CollapsibleContent>
            </Collapsible>

            <Collapsible className="fold">
                <CollapsibleTrigger className="fold-trigger">
                    <Icon name="chevronRight" size={12} className="fold-caret" />{t('diag.raw')}
                </CollapsibleTrigger>
                <CollapsibleContent className="fold-body">
                    <pre style={{ fontSize: 12, overflowX: 'auto', color: 'var(--ink2)', fontFamily: 'var(--font-mono)', lineHeight: 1.7 }}>
                        {JSON.stringify(data, null, 2)}
                    </pre>
                </CollapsibleContent>
            </Collapsible>
        </div>
    );
}
