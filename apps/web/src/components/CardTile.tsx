// CardTile — 瀑布流卡格件:图片自然高(9:16/3:4/4:3 等原生比例不裁切)。
// 门厅画廊与卡选择弹窗共用同一件;CardMasonry 是配套 CSS columns 容器;
// GhostCardTile 是占位阴影卡 —— 卡少时撑节奏,点击直达导入(非死砖)。
import { useState, type ReactNode } from 'react';
import { charImageUrl, type CardItem } from '../api/characters';
import { useI18n } from '../i18n';
import { Icon } from './Icon';
import { openImportModal } from './shell/overlayBus';

/** 瀑布流容器 —— CSS columns;子件需自带 mb + break-inside-avoid。 */
export function CardMasonry({ children, className = '' }: { children: ReactNode; className?: string }) {
    return <div className={`columns-2 gap-3.5 sm:columns-3 lg:columns-4 ${className}`}>{children}</div>;
}

/** 无图卡的占位高宽比(与常见卡面同比例,瀑布流里不塌)。 */
const FALLBACK_ASPECT = '3/4';

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
                        className="block h-auto w-full max-h-[420px] object-cover object-top transition-transform duration-500 group-hover:scale-[1.02]"
                        onError={() => setImgErr(true)}
                        loading="lazy"
                    />
                ) : (
                    <span
                        className="flex w-full items-center justify-center text-[34px]"
                        style={{ aspectRatio: FALLBACK_ASPECT, background: 'var(--bg-active)', color: 'var(--brand)' }}
                    >
                        {(card.name || card.charDir)[0]}
                    </span>
                )}
                <span
                    className="absolute inset-0"
                    style={{ background: 'linear-gradient(180deg, rgba(8,9,10,0.02) 0%, rgba(8,9,10,0.14) 55%, rgba(8,9,10,0.92) 100%)' }}
                />
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

/** 占位阴影卡 —— 虚线框 + 导入入口;aspect 轮换撑瀑布流节奏。 */
export function GhostCardTile({ aspect, labeled }: { aspect: string; labeled?: boolean }) {
    const { t } = useI18n();
    return (
        <button
            type="button"
            onClick={openImportModal}
            className="mb-3.5 flex w-full break-inside-avoid flex-col items-center justify-center gap-2 rounded-[14px] border-2 border-dashed transition-colors hover:border-[color:var(--brand)] hover:text-[color:var(--fg-muted)]"
            style={{ aspectRatio: aspect, borderColor: 'var(--border-strong)', color: 'var(--fg-faint)' }}
        >
            <Icon name="import" size={18} />
            {labeled && <span className="px-3 text-[11.5px]">{t('lib.card.import')}</span>}
        </button>
    );
}

/** 占位节奏池 —— 不同高宽比轮换,瀑布流列高自然错开。 */
export const GHOST_ASPECTS = ['3/4', '4/3', '9/16', '4/3'] as const;
