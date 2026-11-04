// Extensions — 扩展能力注册页(GPT「技能」式管理面)。
// 五类扩展点(插件/正则/快捷回复/注入/卡内资源)按卡列出,带启用态与
// 接线状态徽标。当前全部 unwired —— 徽章诚实标「规划/接线中」,
// 等 TASK-021 插件 UI 与各能力端点落地后逐格点亮。
import { useMemo, useState } from 'react';
import { useI18n } from '../../i18n';
import { Icon, type IconName } from '../Icon';
import { IconButton } from '../ui/icon-button';
import { Input } from '../ui/input';
import { Badge } from '../ui/badge';
import { ToggleGroup, ToggleGroupItem } from '../ui/toggle-group';

type ExtCat = 'plugins' | 'regex' | 'quickReplies' | 'injections' | 'cardAssets';
const CATS: { id: ExtCat; icon: IconName; wired: boolean }[] = [
    { id: 'plugins', icon: 'extensions', wired: false },
    { id: 'regex', icon: 'zap', wired: false },
    { id: 'quickReplies', icon: 'command', wired: false },
    { id: 'injections', icon: 'file', wired: false },
    { id: 'cardAssets', icon: 'grid', wired: false },
];

export function ExtensionsView({ onHint }: { onHint: (msg: string) => void }) {
    const { t } = useI18n();
    const [cat, setCat] = useState<'all' | ExtCat>('all');
    const [query, setQuery] = useState('');

    const visible = useMemo(() => CATS.filter((c) => {
        if (cat !== 'all' && c.id !== cat) return false;
        const q = query.trim();
        return !q || t(`ext.cat.${c.id}`).includes(q) || t(`ext.desc.${c.id}`).includes(q);
    }), [cat, query, t]);

    return (
        <div className="page-scroll lib">
            <div className="lib-head">
                <div className="lib-head-text">
                    <h1>{t('ext.title')}</h1>
                    <p className="mut">{t('ext.desc')}</p>
                </div>
                <span className="grow" />
                <div className="relative">
                    <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">
                        <Icon name="search" size={12} />
                    </span>
                    <Input className="h-8 w-52 rounded-full border-transparent bg-bubble pl-8 text-[13px]"
                        placeholder={t('ext.search')} value={query} onChange={(e) => setQuery(e.target.value)} />
                </div>
                <IconButton label={t('ext.new')} icon={<Icon name="plus" size={16} />}
                    onClick={() => onHint(t('ext.newSoon'))} />
            </div>

            <div className="lib-sect">
                <h3>{t('ext.installed')}</h3>
                <Badge variant="warning">{t('ext.stubBadge')}</Badge>
            </div>

            <ToggleGroup type="single" size="sm" className="lib-chips"
                value={cat} onValueChange={(v) => v && setCat(v as typeof cat)}>
                <ToggleGroupItem value="all">{t('ext.filter.all')}</ToggleGroupItem>
                {CATS.map((c) => (
                    <ToggleGroupItem key={c.id} value={c.id}>{t(`ext.cat.${c.id}`)}</ToggleGroupItem>
                ))}
            </ToggleGroup>

            <div className="lib-tiles">
                {visible.map((c) => (
                    <div key={c.id} className="lib-tile" onClick={() => onHint(t('ext.tileSoon'))}>
                        <span className="lib-tile-glyph"><Icon name={c.icon} size={16} /></span>
                        <span className="lib-tile-text">
                            <span className="lib-tile-name">{t(`ext.cat.${c.id}`)}</span>
                            <span className="lib-tile-sub mut">{t(`ext.desc.${c.id}`)}</span>
                        </span>
                        <Badge variant="warning">{t('ext.stubBadge')}</Badge>
                    </div>
                ))}
                {visible.length === 0 && <div className="lib-empty">{t('ext.empty')}</div>}
            </div>
        </div>
    );
}
