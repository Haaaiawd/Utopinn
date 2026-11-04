// LibraryView — 故事/角色卡(TASK-026 双态,同 RulesView 先例):
// 列表态 = 页头(标题+chips+网格/列表切换+搜索+新建) → 卡格;
// 详情态 = 角色页(大封面 + greeting 预览 + 该卡会话列表 + 编辑/绑定占位)。
// 点卡不再直跳会话 —— 卡从「文件」变「故事」,卡→角色页→会话是三级路径。
// 卡面数据走 ctx.cards(App 统一拉取);详情字段(getCharacter)与会话行
// (listChatsForChar)按需取,离线回落 mock + 徽标。
import { useEffect, useMemo, useState } from 'react';
import { cardData, charImageUrl, getCharacter, type CardDoc, type CardItem } from '../../api/characters';
import { listChatsForChar, type CharChatItem } from '../../api/chats';
import { useI18n } from '../../i18n';
import { useShell } from '../../kernel/context';
import { CardTile } from '../CardTile';
import { Icon } from '../Icon';
import { Button } from '../ui/button';
import { IconButton } from '../ui/icon-button';
import { Input } from '../ui/input';
import { Badge } from '../ui/badge';
import { ToggleGroup, ToggleGroupItem } from '../ui/toggle-group';

type FilterId = 'all' | 'image' | 'json' | 'broken';
const FILTERS: FilterId[] = ['all', 'image', 'json', 'broken'];

/** updatedAt 兼容 number(ms)与 ISO 串;解析不了就原样显示。 */
function fmtDate(v: string | number | undefined, locale: string): string {
    if (v == null) return '';
    const n = typeof v === 'number' ? v : Date.parse(v);
    return Number.isFinite(n) ? new Date(n).toLocaleDateString(locale === 'en' ? 'en' : 'zh-CN') : String(v);
}

/** 排序用同款解析:number 直用,字符串 Date.parse,失败归 0(排尾)。 */
function tsOf(v: string | number | undefined): number {
    if (v == null) return 0;
    const n = typeof v === 'number' ? v : Date.parse(v);
    return Number.isFinite(n) ? n : 0;
}

/** 角色页:封面 → greeting → 会话列表(点行进会话)。 */
function CharacterPage({ card, mock, onBack }: { card: CardItem; mock: boolean; onBack: () => void }) {
    const { t, locale } = useI18n();
    const { chats, selectChat, newChat, hint } = useShell();
    const [doc, setDoc] = useState<CardDoc | null>(null);
    const [rows, setRows] = useState<CharChatItem[] | null>(null);
    const [imgErr, setImgErr] = useState(false);

    useEffect(() => {
        let dead = false;
        setDoc(null);
        setRows(null);
        if (!mock) {
            getCharacter(card.charDir)
                .then((d) => { if (!dead) setDoc(d); })
                .catch(() => { /* 卡详情拿不到 → 只画头区+会话列表,不藏失败 */ });
            listChatsForChar(card.charDir)
                .then((r) => { if (!dead) setRows(r.items); })
                .catch(() => { /* 回落 ctx.chats 汇总(下方) */ });
        }
        return () => { dead = true; };
    }, [card.charDir, mock]);

    const data = cardData(doc);
    const greeting = typeof data.first_mes === 'string' ? data.first_mes.trim() : '';
    /** 卡声明的绑定书(v1/v2 同在 extensions.world);内嵌书 = character_book。 */
    const boundWorld = typeof data.extensions?.world === 'string' ? data.extensions.world : '';
    const embeddedBook = data.character_book != null && typeof data.character_book === 'object';
    const img = card.avatar ?? (/\.(png|webp)$/i.test(card.fileName) ? card.fileName : null);

    /** 真端点行优先;离线/mock 回落 ctx.chats 汇总行。 */
    const chatRows = useMemo<(CharChatItem & { key: string })[]>(() => {
        const src: CharChatItem[] = rows ?? chats
            .filter((c) => c.charDir === card.charDir)
            .map((c) => ({ name: c.chatName, messageCount: 0, updatedAt: c.updatedAt }));
        return src
            .map((r) => ({ ...r, key: r.name }))
            .sort((a, b) => tsOf(b.updatedAt) - tsOf(a.updatedAt));
    }, [rows, chats, card.charDir]);

    return (
        <>
            <div className="lib-head">
                <IconButton label={t('cp.back')} icon={<Icon name="chevronLeft" size={15} />} onClick={onBack} />
                <div className="lib-head-text">
                    <h1>{card.name}</h1>
                </div>
                <span className="grow" />
                <Button variant="secondary" size="sm" onClick={() => hint(t('cp.stub'))}>
                    <Icon name="edit" size={14} />{t('cp.edit')}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => hint(t('cp.stub'))}>
                    <Icon name="layers" size={14} />{t('cp.assets')}
                </Button>
            </div>

            <div className="cp-hero">
                <div className="cp-cover">
                    {img && !imgErr
                        ? <img src={charImageUrl(img)} alt="" onError={() => setImgErr(true)} />
                        : <span className="lib-thumb-init">{card.name.slice(0, 1)}</span>}
                </div>
                <div className="cp-meta">
                    <h2>{card.name}</h2>
                    <span className="cp-file mut">{card.fileName}</span>
                    {(boundWorld || embeddedBook) && (
                        <span className="cp-bound">
                            {boundWorld && (
                                <Badge variant="secondary" className="cp-chip">
                                    <Icon name="book" size={12} />{boundWorld}
                                </Badge>
                            )}
                            {embeddedBook && (
                                <Badge variant="secondary" className="cp-chip">
                                    <Icon name="book" size={12} />{t('cp.embeddedBook')}
                                </Badge>
                            )}
                        </span>
                    )}
                    {(card.tags?.length ?? 0) > 0 && (
                        <span className="cp-tags mut">{card.tags.join(' · ')}</span>
                    )}
                </div>
            </div>

            {greeting && (
                <>
                    <div className="lib-sect"><h3>{t('cp.greeting')}</h3></div>
                    <div className="cp-greeting">{greeting}</div>
                </>
            )}

            <div className="lib-sect">
                <h3>{t('cp.chats')}</h3>
                <span className="grow" />
                <Button variant="secondary" size="sm" onClick={() => newChat(card.charDir)}>
                    <Icon name="plus" size={14} />{t('cp.newChat')}
                </Button>
            </div>

            <div className="cp-chats">
                {chatRows.map((r) => (
                    <div key={r.key} className="cp-chat" onClick={() => selectChat(`${card.charDir}/${r.name}`)}>
                        <span className="cp-chat-text">
                            <span className="cp-chat-title">{r.name}</span>
                            {r.lastMessage?.mes && <span className="cp-chat-prev">{r.lastMessage.mes}</span>}
                        </span>
                        <span className="cp-chat-meta mut">
                            {r.messageCount > 0 && <>{r.messageCount} {t('cp.msgs')} · </>}
                            {fmtDate(r.updatedAt, locale)}
                        </span>
                        <Icon name="chevronRight" size={12} className="cp-chat-arrow" />
                    </div>
                ))}
                {chatRows.length === 0 && <div className="lib-empty">{t('cp.noChats')}</div>}
            </div>
        </>
    );
}

export function LibraryView() {
    const { t } = useI18n();
    const { chats, cards, cardsMock, storiesFocus, clearStoriesFocus, setView } = useShell();
    /** 详情态:打开的 charDir;门厅经 storiesFocus 中转进来。 */
    const [opened, setOpened] = useState<string | null>(null);
    const [filter, setFilter] = useState<FilterId>('all');
    const [query, setQuery] = useState('');
    const [grid, setGrid] = useState(true);

    useEffect(() => {
        if (!storiesFocus) return;
        setOpened(storiesFocus);
        clearStoriesFocus();
    }, [storiesFocus, clearStoriesFocus]);

    const cardsList = useMemo(() => [...cards.values()], [cards]);

    const chatCounts = useMemo(() => {
        const m = new Map<string, number>();
        for (const c of chats) m.set(c.charDir, (m.get(c.charDir) ?? 0) + 1);
        return m;
    }, [chats]);

    const visible = useMemo(() => cardsList.filter((c) => {
        if (filter === 'image' && !c.avatar) return false;
        if (filter === 'json' && c.avatar) return false;
        if (filter === 'broken' && c.readable) return false;
        if (query.trim() && !c.name.includes(query.trim()) && !c.charDir.includes(query.trim())) return false;
        return true;
    }), [cardsList, filter, query]);

    const openedCard = opened != null ? cardsList.find((c) => c.charDir === opened) ?? null : null;

    return (
        <div className="page-scroll lib">
            {openedCard ? (
                <CharacterPage card={openedCard} mock={cardsMock} onBack={() => setOpened(null)} />
            ) : (
                <>
                    <div className="lib-head">
                        <h1>{t('lib.title')}</h1>
                        {cardsMock && <Badge variant="warning">{t('common.mockData')}</Badge>}
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
                        <Button variant="secondary" size="sm" onClick={() => setView('import')}>
                            <Icon name="import" size={14} />{t('lib.new')}
                        </Button>
                    </div>

                    <ToggleGroup type="single" size="sm" className="lib-chips"
                        value={filter} onValueChange={(v) => v && setFilter(v as FilterId)}>
                        {FILTERS.map((f) => (
                            <ToggleGroupItem key={f} value={f}>{t(`lib.filter.${f}`)}</ToggleGroupItem>
                        ))}
                    </ToggleGroup>

                    <div className={grid ? 'lib-grid' : 'lib-rows'}>
                        {visible.map((c) => (
                            <CardTile key={c.charDir} card={c}
                                chatCount={chatCounts.get(c.charDir) ?? 0}
                                onOpen={() => setOpened(c.charDir)} />
                        ))}
                        {visible.length === 0 && (
                            <div className="lib-empty">{t('lib.empty')}</div>
                        )}
                    </div>
                </>
            )}
        </div>
    );
}
