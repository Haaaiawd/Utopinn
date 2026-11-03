// RulesView — 世界书管理页(GPT「技能」式):
// 页头(标题+描述+搜索/刷新/添加) → 「已收录」段 → 两行卡格
// (书标 + 名称 + 说明 + 启用✓) + 来源 chips(全部/全局/绑定)。
// 真实数据走 /api/uberge/worlds(全局书);绑定书在卡上,列表
// 端点尚未覆盖 → chips 诚实显示空态。离线回退 mock + 徽标。
import { useEffect, useMemo, useState } from 'react';
import { apiGet } from '../../api/client';
import { useI18n } from '../../i18n';
import { Icon } from '../Icon';
import { IconButton } from '../ui/icon-button';
import { Input } from '../ui/input';
import { Badge } from '../ui/badge';

interface WorldItem {
    name: string;
    displayName: string;
    extensions: Record<string, unknown>;
}

const MOCK_WORLDS: WorldItem[] = [
    { name: 'lighthouse-keepers', displayName: '灯塔守望者', extensions: { position: 0 } },
    { name: 'tide-and-salt', displayName: '潮与盐', extensions: {} },
];

export function RulesView({ onHint }: { onHint: (msg: string) => void }) {
    const { t } = useI18n();
    const [worlds, setWorlds] = useState<WorldItem[]>([]);
    const [mock, setMock] = useState(false);
    const [filter, setFilter] = useState<'all' | 'global' | 'bound'>('all');
    const [query, setQuery] = useState('');

    useEffect(() => {
        let dead = false;
        apiGet<{ items: WorldItem[] }>('/api/uberge/worlds')
            .then((r) => { if (!dead) { setWorlds(r.items); setMock(false); } })
            .catch(() => { if (!dead) { setWorlds(MOCK_WORLDS); setMock(true); } });
        return () => { dead = true; };
    }, []);

    const visible = useMemo(() => {
        if (filter === 'bound') return []; // 绑定书端点未覆盖 —— 诚实空态
        const q = query.trim();
        return worlds.filter((w) => !q || w.displayName.includes(q) || w.name.includes(q));
    }, [worlds, filter, query]);

    return (
        <div className="page-scroll lib">
            <div className="lib-head">
                <div className="lib-head-text">
                    <h1>{t('rules.title')}</h1>
                    <p className="mut">{t('rules.desc')}</p>
                </div>
                <span className="grow" />
                <div className="relative">
                    <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">
                        <Icon name="search" size={13} />
                    </span>
                    <Input className="h-8 w-52 rounded-full border-transparent bg-bubble pl-8 text-[13px]"
                        placeholder={t('rules.search')} value={query} onChange={(e) => setQuery(e.target.value)} />
                </div>
                <IconButton label={t('rules.new')} icon={<Icon name="plus" size={15} />}
                    onClick={() => onHint(t('lib.importSoon'))} />
            </div>

            <div className="lib-sect">
                <h3>{t('rules.installed')}</h3>
                {mock && <Badge variant="warning">{t('common.mockData')}</Badge>}
            </div>

            <div className="lib-chips">
                {(['all', 'global', 'bound'] as const).map((f) => (
                    <button key={f} type="button"
                        className={`lib-chip ${filter === f ? 'on' : ''}`}
                        onClick={() => setFilter(f)}>
                        {t(`rules.filter.${f}`)}
                    </button>
                ))}
            </div>

            <div className="lib-tiles">
                {visible.map((w) => (
                    <div key={w.name} className="lib-tile" onClick={() => onHint(w.name)}>
                        <span className="lib-tile-glyph"><Icon name="book" size={17} /></span>
                        <span className="lib-tile-text">
                            <span className="lib-tile-name">{w.displayName}</span>
                            <span className="lib-tile-sub mut">{w.name}</span>
                        </span>
                        <span className="lib-tile-check"><Icon name="check" size={15} /></span>
                    </div>
                ))}
                {visible.length === 0 && <div className="lib-empty">{t('rules.empty')}</div>}
            </div>
        </div>
    );
}
