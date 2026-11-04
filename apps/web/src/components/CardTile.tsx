// CardTile — 故事库卡格的单元(16/10 卡,缩略 + 名 + 会话数)。
// 门厅精选格与 LibraryView 共用同一件,视觉零分叉。
import { useState } from 'react';
import { charImageUrl, type CardItem } from '../api/characters';
import { useI18n } from '../i18n';
import { Icon } from './Icon';
import { IconButton } from './ui/icon-button';
import { Badge } from './ui/badge';

export function CardTile({ card, chatCount, onOpen }: {
    card: CardItem;
    chatCount: number;
    onOpen: () => void;
}) {
    const { t } = useI18n();
    const [imgErr, setImgErr] = useState(false);
    return (
        <div className={`lib-card ${card.readable ? '' : 'broken'}`} onClick={onOpen}>
            <div className="lib-thumb">
                {/* 卡面 404/未挂路由 → 回落首字占位,不留破图图标。 */}
                {card.avatar && !imgErr
                    ? <img src={charImageUrl(card.avatar)} alt="" loading="lazy"
                        onError={() => setImgErr(true)} />
                    : <span className="lib-thumb-init">{card.name.slice(0, 1)}</span>}
            </div>
            <div className="lib-meta">
                <div className="lib-title">
                    <span className="lib-name">{card.name}</span>
                    {!card.readable && <Badge variant="destructive">JSON</Badge>}
                </div>
                <div className="lib-sub">
                    {chatCount > 0 ? `${chatCount} ${t('lib.chatCount')}` : card.fileName}
                </div>
            </div>
            <span className="lib-acts" onClick={(e) => e.stopPropagation()}>
                <IconButton size="icon-sm" label={t('lib.card.more')} icon={<Icon name="more" size={12} />} />
            </span>
        </div>
    );
}
