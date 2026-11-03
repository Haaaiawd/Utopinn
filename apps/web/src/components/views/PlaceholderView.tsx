// Placeholder for domains whose surfaces are later slices — an empty state
// that teaches (IA §9: every empty list says how it gets filled).
import { useI18n } from '../../i18n';
import { Icon } from '../Icon';
import type { IconName } from '../Icon';
import { Badge } from '../ui/badge';

export function PlaceholderView({ icon, titleKey, descKey }: {
    icon: IconName;
    titleKey: string;
    descKey: string;
}) {
    const { t } = useI18n();
    return (
        <div className="page-scroll">
            <div className="empty-hint">
                <div className="glyph"><Icon name={icon} size={24} /></div>
                <h2 style={{ fontSize: 15, color: 'var(--ink)', marginBottom: 8 }}>{t(titleKey)}</h2>
                <p style={{ marginBottom: 14 }}>{t(descKey)}</p>
                <Badge><Icon name="import" size={11} /> {t('view.placeholder.import')}</Badge>
            </div>
        </div>
    );
}
