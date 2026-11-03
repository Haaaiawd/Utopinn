// Diagnostics face for /api/uberge/preview — the request-inspector spirit
// (web-ia.md §11 diagnostics domain). Shows sources + assembly trace; the
// assembled messages themselves render in the main area via the renderer seam.
import { useI18n } from '../../i18n';
import type { PreviewResult } from '../../types';

export function PreviewDebug({ result }: { result: PreviewResult | null }) {
    const { t } = useI18n();

    if (!result || (!result.data && !result.error)) {
        return <p className="mut" style={{ lineHeight: 1.7 }}>{t('panel.diag.noData')}</p>;
    }
    if (result.error) {
        return <div className="warn">{t('chat.preview.failed')}: {result.error}</div>;
    }

    const { data, mock } = result;
    if (!data) return null;
    const { trace, sources } = data;

    return (
        <div>
            {mock && <div className="warn" style={{ marginBottom: 10 }}>{t('chat.preview.mock')}</div>}

            <details className="fold" open>
                <summary>{t('diag.sources')}</summary>
                <div className="fold-body">
                    <dl className="diag-kv">
                        <dt>{t('diag.preset')}</dt><dd>{sources?.presetName ?? '—'}</dd>
                        <dt>{t('diag.model')}</dt><dd>{sources?.model ?? '—'}</dd>
                        <dt>{t('diag.wi')}</dt><dd>{sources?.worldInfoActivated ?? 0}</dd>
                        <dt>{t('diag.chatCount')}</dt><dd>{sources?.chatCount ?? 0}</dd>
                    </dl>
                </div>
            </details>

            {trace && (
                <details className="fold" open>
                    <summary>{t('diag.trace')}</summary>
                    <div className="fold-body">
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
                    </div>
                </details>
            )}

            <details className="fold">
                <summary>{t('diag.messages')} ({data.messages.length})</summary>
                <div className="fold-body">
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
                </div>
            </details>

            <details className="fold">
                <summary>{t('diag.raw')}</summary>
                <div className="fold-body">
                    <pre style={{ fontSize: 12, overflowX: 'auto', color: 'var(--ink2)', fontFamily: 'var(--font-mono)', lineHeight: 1.7 }}>
                        {JSON.stringify(data, null, 2)}
                    </pre>
                </div>
            </details>
        </div>
    );
}
