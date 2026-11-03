// Status bar (24px): server reachability left; transient hint center;
// tokens / renderer / locale right.
import { useI18n } from '../../i18n';
import type { ChatSummary, ServerStatus } from '../../types';

const STATUS_CLASS: Record<ServerStatus, string> = {
    online: 'ok',
    mock: 'warn',
    offline: 'warn',
    checking: '',
};
const STATUS_KEY: Record<ServerStatus, string> = {
    online: 'status.server.online',
    mock: 'status.server.mock',
    offline: 'status.server.offline',
    checking: 'status.server.checking',
};

export function StatusBar({ server, chat, tokens, rendererId, hint }: {
    server: ServerStatus;
    chat: ChatSummary | null;
    tokens?: { used: number; budget: number } | null;
    rendererId: string;
    hint: string | null;
}) {
    const { t } = useI18n();
    return (
        <div className="statusbar">
            <span className={STATUS_CLASS[server]}>● {t('status.server')}: {t(STATUS_KEY[server])}</span>
            {chat && <span>{chat.charDir} · {chat.chatName}.jsonl</span>}
            {hint && <span className="warn">{hint}</span>}
            <span className="grow" />
            {tokens && <span>{t('status.tokens')} {tokens.used}/{tokens.budget}</span>}
            <span>{t('status.renderer')}: {rendererId}</span>
        </div>
    );
}
