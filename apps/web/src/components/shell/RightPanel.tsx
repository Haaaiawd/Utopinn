// Right bar — multi-panel host. 板块类型经 panel.type 贡献点注册,
// 本体由注册表给出;宿主只画 tab 条与拖宽柄,不解释 type 字符串。
// 板块清空 → 整条自动收起;加板块走 ctbar 的 "+" 贡献位。
import { useState } from 'react';
import { useI18n } from '../../i18n';
import { useContribs, useShell } from '../../kernel/context';
import { Icon, type IconName } from '../Icon';
import { ScrollArea } from '../ui/scroll-area';

/* 右栏可拖(VS Code:一切 dock 皆可拖;Figma 固定右栏是实证反例)。
   300 = VS Code panel min;560 封顶防吃掉阅读列。 */
const PNL_MIN = 300, PNL_MAX = 560;

export function RightPanel() {
    const { t } = useI18n();
    const { panels, activePanel, panelHidden, selectPanel, closePanel } = useShell();
    const types = useContribs('panel.type');
    const [width, setWidth] = useState(380);

    const startResize = (e: React.PointerEvent) => {
        e.preventDefault();
        const startX = e.clientX;
        const startW = width;
        const move = (ev: PointerEvent) =>
            // 左缘柄:左拖变宽。
            setWidth(Math.min(PNL_MAX, Math.max(PNL_MIN, startW + startX - ev.clientX)));
        const up = () => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
    };

    // 无板块时整条自动收起 —— 不再需要显式 hide 钮。
    if (panelHidden || panels.length === 0) return null;
    const active = panels.find((p) => p.id === activePanel) ?? panels[0];
    if (!active) return null;

    const iconOf = (type: string): IconName =>
        types.find((c) => c.type === type)?.icon ?? 'layout';
    const Body = types.find((c) => c.type === active.type)?.Body;

    return (
        <aside className="upanel" style={{ width }}>
            <div className="pnl-resizer" onPointerDown={startResize} />
            <div className="pnl-tabs">
                <ScrollArea className="pnl-tabs-scroll">
                    <div className="pnl-tabs-row">
                        {panels.map((p) => (
                            <span key={p.id}
                                className={`pnl-tab${p.id === active.id ? ' on' : ''}`}
                                onClick={() => selectPanel(p.id)}>
                                <Icon name={iconOf(p.type)} size={12} />
                                <span className="pnl-tab-name">{t(`panel.type.${p.type}`)}</span>
                                <button type="button" className="pnl-tab-x" aria-label={t('panel.close')}
                                    onClick={(e) => { e.stopPropagation(); closePanel(p.id); }}>
                                    <Icon name="x" size={12} />
                                </button>
                            </span>
                        ))}
                    </div>
                </ScrollArea>
            </div>

            <ScrollArea className="sp-body">
                {Body ? <Body /> : null}
            </ScrollArea>
        </aside>
    );
}
