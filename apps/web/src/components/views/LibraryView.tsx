// LibraryView — 故事/角色卡的卡格存放面(GPT 资料库式):
// 页头(标题+chips+网格/列表切换+搜索+新建) → 卡片网格
// (缩略区 + 标题行 + ···)。真实数据走 /api/uberge/characters,
// 离线回退 MOCK_CARDS 并打 mock 徽标。
import { useEffect, useMemo, useState } from 'react';
import { apiGet } from '../../api/client';
import { MOCK_CARDS, type CardItem } from '../../api/mock';
import { useI18n } from '../../i18n';
import { Icon } from '../Icon';
import { IconButton } from '../ui/icon-button';
import { Input } from '../ui/input';
import { Badge } from '../ui/badge';

type FilterId = 'all' | 'image' | 'json' | 'broken';
const FILTERS: FilterId[] = ['all', 'image', 'json', 'broken'];

function CardTile({ card, chatCount, onOpen }: { card: CardItem; chatCount: number; onOpen: () => void }) {
    return (
        <div className={`lib-card ${card.readable ? '' : 'broken'}`} onClick={onOpen}>
            <div className="lib-thumb">
                {card.avatar
                    ? <img src={`/characters/${encodeURIComponent(card.avatar)}`} alt="" loading="lazy" />
                    : <span className="lib-thumb-init">{card.name.slice(0, 1)}</span>}
            </div>
            <div className="lib-meta">
                <div className="lib-title">
                    <span className="lib-name">{card.name}</span>
                    {!card.readable && <Badge variant="destructive">JSON</Badge>}
                </div>
                <div className="lib-sub">
                    {chatCount > 0 ? `${chatCount} 会话` : card.fileName}
                </div>
            </div>
            <span className="lib-acts" onClick={(e) => e.stopPropagation()}>
                <IconButton size="icon-sm" label="…" icon={<Icon name="more" size={12} />} />
            </span>
        </div>
    );
}

export function LibraryView({ chats, onOpenCard, onHint }: {
    chats: { charDir: string }[];
    /** 点卡 → 跳到该角色第一个会话(无会话则 hint)。 */
    onOpenCard: (charDir: string) => void;
    onHint: (msg: string) => void;
}) {
    const { t } = useI18n();
    const [cards, setCards] = useState<CardItem[]>([]);
    const [mock, setMock] = useState(false);
    const [filter, setFilter] = useState<FilterId>('all');
    const [query, setQuery] = useState('');
    const [grid, setGrid] = useState(true);

    useEffect(() => {
        let dead = false;
        apiGet<{ items: CardItem[] }>('/api/uberge/characters')
            .then((r) => { if (!dead) { setCards(r.items); setMock(false); } })
            .catch(() => { if (!dead) { setCards(MOCK_CARDS); setMock(true); } });
        return () => { dead = true; };
    }, []);

    const chatCounts = useMemo(() => {
        const m = new Map<string, number>();
        for (const c of chats) m.set(c.charDir, (m.get(c.charDir) ?? 0) + 1);
        return m;
    }, [chats]);

    const visible = useMemo(() => cards.filter((c) => {
        if (filter === 'image' && !c.avatar) return false;
        if (filter === 'json' && c.avatar) return false;
        if (filter === 'broken' && c.readable) return false;
        if (query.trim() && !c.name.includes(query.trim()) && !c.charDir.includes(query.trim())) return false;
        return true;
    }), [cards, filter, query]);

    return (
        <div className="page-scroll lib">
            <div className="lib-head">
                <h1>{t('lib.title')}</h1>
                {mock && <Badge variant="warning">{t('common.mockData')}</Badge>}
                <span className="grow" />
                <IconButton label={t('lib.viewToggle')} icon={<Icon name={grid ? 'list' : 'grid'} size={16} />}
                    onClick={() => setGrid((v) => !v)} />
                <div className="relative">
                    <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">
                        <Icon name="search" size={12} />
                    </span>
                    <Input className="h-8 w-52 rounded-full border-transparent bg-bubble pl-8 text-[13px]"
                        placeholder={t('lib.search')} value={query} onChange={(e) => setQuery(e.target.value)} />
                </div>
                <IconButton label={t('lib.new')} icon={<Icon name="plus" size={16} />}
                    onClick={() => onHint(t('lib.importSoon'))} />
            </div>

            <div className="lib-chips">
                {FILTERS.map((f) => (
                    <button key={f} type="button"
                        className={`lib-chip ${filter === f ? 'on' : ''}`}
                        onClick={() => setFilter(f)}>
                        {t(`lib.filter.${f}`)}
                    </button>
                ))}
            </div>

            <div className={grid ? 'lib-grid' : 'lib-rows'}>
                {visible.map((c) => (
                    <CardTile key={c.charDir} card={c}
                        chatCount={chatCounts.get(c.charDir) ?? 0}
                        onOpen={() => onOpenCard(c.charDir)} />
                ))}
                {visible.length === 0 && (
                    <div className="lib-empty">{t('lib.empty')}</div>
                )}
            </div>
        </div>
    );
}
