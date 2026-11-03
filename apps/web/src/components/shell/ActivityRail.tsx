// Activity rail — 46px icon strip switching the primary domains
// (IA v3: 聊天/故事/规则/扩展/诊断/设置). Tooltips are stroke-icon labels.
import { useI18n } from '../../i18n';
import { useTheme } from '../../theme';
import type { ViewId } from '../../types';
import { Icon } from '../Icon';
import type { IconName } from '../Icon';

const ITEMS: { id: ViewId; icon: IconName }[] = [
    { id: 'chat', icon: 'chat' },
    { id: 'stories', icon: 'stories' },
    { id: 'rules', icon: 'rules' },
    { id: 'extensions', icon: 'extensions' },
    { id: 'diagnostics', icon: 'diagnostics' },
    { id: 'settings', icon: 'settings' },
];

export function ActivityRail({ view, onSelect }: { view: ViewId; onSelect: (v: ViewId) => void }) {
    const { t } = useI18n();
    const { theme, toggle } = useTheme();
    return (
        <nav className="rail">
            {ITEMS.map((it) => (
                <button
                    key={it.id}
                    type="button"
                    className={view === it.id ? 'on' : ''}
                    onClick={() => onSelect(it.id)}
                >
                    <Icon name={it.icon} size={17} />
                    <span className="tip">{t(`nav.${it.id}`)}</span>
                </button>
            ))}
            <span className="sp" />
            <button type="button" onClick={toggle}>
                <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={16} />
                <span className="tip">{t('menu.view.toggleTheme')}</span>
            </button>
            <span className="avatar" title="default-user">U</span>
        </nav>
    );
}
