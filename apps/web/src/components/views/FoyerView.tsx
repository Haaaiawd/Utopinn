// FoyerView — 门厅(TASK-026):RP 原生 home。
// 时段问候 → 继续上次(最近会话大卡) → 故事精选(卡格前几) → 快动作。
// 数据全走 ctx(壳已拉的 chats/cards),本页零请求。
import { useMemo, useState } from 'react';
import { charImageUrl, type CardItem } from '../../api/characters';
import { useI18n } from '../../i18n';
import { useShell } from '../../kernel/context';
import type { ChatSummary } from '../../types';
import { CardTile } from '../CardTile';
import { Icon } from '../Icon';
import { Button } from '../ui/button';

/** updatedAt:number(ms)/ISO 串/mock 词;解析不了归 0 排尾(稳定序兜底)。 */
function tsOf(v: string | number | undefined): number {
    if (v == null) return 0;
    const n = typeof v === 'number' ? v : Date.parse(v);
    return Number.isFinite(n) ? n : 0;
}

/** 展示同款:能解析走 locale 日期,mock 词('today')原样显示。 */
function fmtUpdated(v: string | number | undefined, locale: string): string {
    if (v == null) return '';
    return tsOf(v)
        ? new Date(tsOf(v)).toLocaleDateString(locale === 'en' ? 'en' : 'zh-CN')
        : String(v);
}

/** 大卡脸:真图 404 → 首字(与 CharFace/lib-thumb 同一回落)。 */
function ContinueFace({ card, charDir }: { card?: CardItem; charDir: string }) {
    const [err, setErr] = useState(false);
    const face = card?.avatar ?? (/\.(png|webp)$/i.test(card?.fileName ?? '') ? card!.fileName : null);
    if (!face || err) {
        return <span className="foyer-cont-init">{(card?.name ?? charDir).slice(0, 1)}</span>;
    }
    return <img src={charImageUrl(face)} alt="" onError={() => setErr(true)} />;
}

function helloKey(hour: number): 'night' | 'morning' | 'afternoon' | 'evening' {
    if (hour < 6) return 'night';
    if (hour < 12) return 'morning';
    if (hour < 18) return 'afternoon';
    return 'evening';
}

export function FoyerView() {
    const { t, locale } = useI18n();
    const { chats, cards, selectChat, newChat, setView, openCharacter, hint } = useShell();

    /** 最近会话 = 「继续上次」唯一主角;零会话时整块让位给精选。 */
    const recent = useMemo<ChatSummary | undefined>(
        () => [...chats].sort((a, b) => tsOf(b.updatedAt) - tsOf(a.updatedAt))[0],
        [chats],
    );
    /** 精选 = 库前六张可读卡(发现位;损坏/JSON 占位卡不推)。 */
    const featured = useMemo(
        () => [...cards.values()].filter((c) => c.readable).slice(0, 6),
        [cards],
    );
    const chatCounts = useMemo(() => {
        const m = new Map<string, number>();
        for (const c of chats) m.set(c.charDir, (m.get(c.charDir) ?? 0) + 1);
        return m;
    }, [chats]);

    const recentCard = recent ? cards.get(recent.charDir) : undefined;
    const dateLine = new Date().toLocaleDateString(locale === 'en' ? 'en' : 'zh-CN', {
        month: 'long', day: 'numeric', weekday: 'long',
    });

    return (
        <div className="page-scroll foyer">
            <div className="foyer-head">
                <h1>{t(`foyer.hello.${helloKey(new Date().getHours())}`)}</h1>
                <p className="mut">{dateLine}</p>
            </div>

            {recent && (
                <>
                    <div className="lib-sect"><h3>{t('foyer.continue')}</h3></div>
                    <div className="foyer-cont" onClick={() => selectChat(recent.id)}>
                        <span className="foyer-cont-ava">
                            <ContinueFace card={recentCard} charDir={recent.charDir} />
                        </span>
                        <span className="foyer-cont-text">
                            <span className="foyer-cont-title">{recent.title}</span>
                            <span className="foyer-cont-sub mut">
                                {recentCard?.name ?? recent.group ?? recent.charDir}
                                {recent.updatedAt && ` · ${fmtUpdated(recent.updatedAt, locale)}`}
                            </span>
                        </span>
                        <Icon name="chevronRight" size={16} className="foyer-cont-arrow" />
                    </div>
                </>
            )}

            <div className="lib-sect">
                <h3>{t('foyer.stories')}</h3>
                <span className="grow" />
                <Button variant="ghost" size="sm" onClick={() => setView('stories')}>
                    {t('foyer.browse')}<Icon name="chevronRight" size={12} />
                </Button>
            </div>
            <div className="lib-grid">
                {featured.map((c) => (
                    <CardTile key={c.charDir} card={c}
                        chatCount={chatCounts.get(c.charDir) ?? 0}
                        onOpen={() => openCharacter(c.charDir)} />
                ))}
                {featured.length === 0 && <div className="lib-empty">{t('lib.empty')}</div>}
            </div>

            <div className="foyer-acts">
                <Button variant="secondary" size="sm" onClick={() => newChat()}>
                    <Icon name="plus" size={14} />{t('sidebar.newChat')}
                </Button>
                <Button variant="secondary" size="sm" onClick={() => hint(t('lib.importSoon'))}>
                    <Icon name="import" size={14} />{t('foyer.import')}
                </Button>
            </div>
        </div>
    );
}
