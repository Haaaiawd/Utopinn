// CardTile — 瀑布流卡格件:图片自然高(9:16/3:4/4:3 等原生比例不裁切)。
// 门厅画廊与卡选择弹窗共用同一件;CardMasonry 是配套 CSS columns 容器;
// GhostCardTile 是占位阴影卡 —— 卡少时撑节奏,点击直达导入(非死砖)。
import { useState, type ReactNode } from 'react';
import { charImageUrl, type CardItem } from '../api/characters';
import { builtinCoverSrc } from '../api/personas';
import { useI18n } from '../i18n';
import { Icon } from './Icon';
import { openImportModal } from './shell/overlayBus';
import { charImgFallback } from './stage/StageFrame';

/** 瀑布流容器 —— CSS columns;子件需自带 mb + break-inside-avoid。 */
export function CardMasonry({ children, className = '' }: { children: ReactNode; className?: string }) {
    return <div className={`columns-2 gap-3.5 sm:columns-3 lg:columns-4 ${className}`}>{children}</div>;
}

/** 无图卡的内置卡面高宽比(covers 系列原生 2:3,瀑布流里不塌)。 */
const FALLBACK_ASPECT = '2/3';

export function CardTile({ card, sub, onOpen, onEdit }: {
    card: CardItem;
    /** 自定义副标(缺省:会话数 → 文件名 → 解析失败)。 */
    sub?: string;
    chatCount?: number;
    onOpen: () => void;
    onEdit?: () => void;
}) {
    const { t } = useI18n();
    const [imgErr, setImgErr] = useState(false);
    return (
        <div
            className="group relative mb-3.5 break-inside-avoid overflow-hidden rounded-[14px] border text-left transition-all hover:border-[color:var(--border-strong)]"
            style={{ background: 'var(--bg-surface)', boxShadow: 'var(--shadow-card)', borderColor: 'var(--border-hairline)' }}
        >
            <button type="button" className="block w-full text-left" onClick={onOpen}>
                {card.avatar && !imgErr ? (
                    <img
                        src={charImageUrl(card.avatar)}
                        alt={card.name || card.charDir}
                        className="block h-auto w-full transition-transform duration-500 group-hover:scale-[1.02]"
                        onError={() => setImgErr(true)}
                        loading="lazy"
                    />
                ) : (
                    /* 无图/加载失败 → 内置卡面轮换(charDir 定面,同卡同面);卡面再挂 → 黑猫终降。 */
                    <img
                        src={builtinCoverSrc(card.charDir || card.name)}
                        alt=""
                        data-cover-key={card.charDir || card.name}
                        onError={charImgFallback}
                        className="block w-full object-cover"
                        style={{ aspectRatio: FALLBACK_ASPECT }}
                        loading="lazy"
                    />
                )}
                <span
                    className="absolute inset-0"
                    style={{ background: 'linear-gradient(180deg, rgba(8,9,10,0.02) 0%, rgba(8,9,10,0.14) 55%, rgba(8,9,10,0.92) 100%)' }}
                />
                {card.shared && (
                    <span
                        className="absolute left-2.5 top-2.5 rounded-md px-1.5 py-0.5 text-[10px] font-medium"
                        style={{ background: 'rgba(14,15,18,0.72)', color: '#fff', backdropFilter: 'blur(6px)' }}
                        title={t('studio.cards.shared.hint')}
                    >
                        {t('studio.cards.shared')}
                    </span>
                )}
                <span className="absolute bottom-3 left-3.5 right-3.5">
                    <span className="heading-tight block truncate text-[14.5px] font-semibold text-white">{card.name || card.charDir}</span>
                    <span className="mt-0.5 block truncate text-[11.5px] text-white/70">
                        {sub ?? (!card.readable ? t('studio.cards.unreadable') : card.fileName)}
                    </span>
                </span>
            </button>
            {onEdit && (
                <button
                    type="button"
                    title={t('studio.cards.detail')}
                    onClick={(e) => { e.stopPropagation(); onEdit(); }}
                    className="absolute right-2.5 top-2.5 flex h-7 w-7 items-center justify-center rounded-lg opacity-0 transition-opacity group-hover:opacity-100"
                    style={{ background: 'rgba(14,15,18,0.68)', color: '#fff', backdropFilter: 'blur(6px)' }}
                >
                    <Icon name="pencil" size={12} />
                </button>
            )}
        </div>
    );
}

/** 占位阴影卡 —— 空相框质感(渐变纸面+细边),点击直达导入;aspect 轮换撑瀑布流节奏。 */
export function GhostCardTile({ aspect, labeled, tone = 0 }: { aspect: string; labeled?: boolean; tone?: number }) {
    const { t } = useI18n();
    const tones = ['var(--bg-surface)', 'var(--bg-canvas)', 'var(--bg-active)'];
    return (
        <button
            type="button"
            onClick={openImportModal}
            className="mb-3.5 flex w-full break-inside-avoid flex-col items-center justify-center gap-2 rounded-[14px] border transition-colors hover:border-[color:var(--brand)] hover:text-[color:var(--fg-muted)]"
            style={{
                aspectRatio: aspect,
                borderColor: 'var(--border-hairline)',
                color: 'var(--fg-faint)',
                background: `linear-gradient(160deg, ${tones[tone % tones.length]} 0%, var(--bg-canvas) 100%)`,
            }}
        >
            <Icon name="import" size={labeled ? 18 : 14} />
            {labeled && <span className="px-3 text-[11.5px]">{t('lib.card.import')}</span>}
        </button>
    );
}

/** 占位节奏池 —— 不同高宽比轮换,瀑布流列高自然错开。 */
export const GHOST_ASPECTS = ['3/4', '4/3', '9/16', '1/1', '16/10', '4/5'] as const;
