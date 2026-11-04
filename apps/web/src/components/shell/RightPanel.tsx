// Right bar — multi-panel host. Panels are typed instances added via the "+"
// picker in the center topbar (本局/诊断/面板/分析), each living as a
// closable tab — the host owns the strip, panel bodies render per type.
// Zero panels → the whole track auto-collapses; "+" brings it back.
import { useState } from 'react';
import { useI18n } from '../../i18n';
import type { PreviewResult } from '../../types';
import { Icon, type IconName } from '../Icon';
import { ScrollArea } from '../ui/scroll-area';
import { PreviewDebug } from '../chat/PreviewDebug';
import { CardAppFrame } from '../../cardapp/CardAppFrame';

export type PanelType = 'session' | 'diag' | 'cardapp' | 'analysis';
export interface PanelInst { id: string; type: PanelType }

export const PANEL_TYPES: { type: PanelType; icon: IconName; wired: boolean }[] = [
    { type: 'session', icon: 'user', wired: true },
    { type: 'diag', icon: 'pulse', wired: true },
    { type: 'cardapp', icon: 'layout', wired: true },
    { type: 'analysis', icon: 'chartLine', wired: false },
];

const PANEL_ICON: Record<PanelType, IconName> =
    Object.fromEntries(PANEL_TYPES.map((p) => [p.type, p.icon])) as Record<PanelType, IconName>;

/* 右栏可拖(VS Code:一切 dock 皆可拖;Figma 固定右栏是实证反例)。
   300 = VS Code panel min;560 封顶防吃掉阅读列。 */
const PNL_MIN = 300, PNL_MAX = 560;

function PanelBody({ type, preview, charDir, chatName }: {
    type: PanelType; preview: PreviewResult | null; charDir?: string; chatName?: string;
}) {
    const { t } = useI18n();
    switch (type) {
        case 'session':
            return (
                <div className="sp-card">
                    <h4>{t('panel.type.session')}</h4>
                    {(['panel.session.authorNote', 'panel.session.cfg', 'panel.session.logprobs'] as const).map((k) => (
                        <div className="row" key={k}>
                            <span className="lab">{t(k)}</span>
                            <span className="mut">{t('panel.session.unwired')}</span>
                        </div>
                    ))}
                </div>
            );
        case 'diag':
            return <PreviewDebug result={preview} />;
        case 'cardapp':
            return charDir ? (
                <CardAppFrame charDir={charDir} chatName={chatName} />
            ) : (
                <div className="sp-card">
                    <h4>{t('panel.type.cardapp')}</h4>
                    <p className="mut" style={{ lineHeight: 1.7 }}>
                        <Icon name="layout" size={12} /> {t('panel.panels.empty')}
                    </p>
                </div>
            );
        default:
            /* browser/analysis — 选择器里诚实可选,板块本体未接线 */
            return (
                <div className="sp-card">
                    <h4>{t(`panel.type.${type}`)}</h4>
                    <p className="mut" style={{ lineHeight: 1.7 }}>{t('panel.stub')}</p>
                </div>
            );
    }
}

export function RightPanel({ panels, active, preview, hidden, charDir, chatName, onSelect, onClose }: {
    panels: PanelInst[];
    active: string | null;
    preview: PreviewResult | null;
    hidden: boolean;
    charDir?: string;
    chatName?: string;
    onSelect: (id: string) => void;
    onClose: (id: string) => void;
}) {
    const { t } = useI18n();
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

    // 无板块时整条自动收起 —— 不再需要显式 hide 钮;加板块走 ctbar 的 "+"。
    if (hidden || panels.length === 0) return null;
    const activePanel = panels.find((p) => p.id === active) ?? panels[0];
    if (!activePanel) return null;

    return (
        <aside className="upanel" style={{ width }}>
            <div className="pnl-resizer" onPointerDown={startResize} />
            <div className="pnl-tabs">
                <ScrollArea className="pnl-tabs-scroll">
                    <div className="pnl-tabs-row">
                        {panels.map((p) => (
                            <span key={p.id}
                                className={`pnl-tab${p.id === activePanel?.id ? ' on' : ''}`}
                                onClick={() => onSelect(p.id)}>
                                <Icon name={PANEL_ICON[p.type]} size={12} />
                                <span className="pnl-tab-name">{t(`panel.type.${p.type}`)}</span>
                                <button type="button" className="pnl-tab-x" aria-label={t('panel.close')}
                                    onClick={(e) => { e.stopPropagation(); onClose(p.id); }}>
                                    <Icon name="x" size={12} />
                                </button>
                            </span>
                        ))}
                    </div>
                </ScrollArea>
            </div>

            <ScrollArea className="sp-body">
                <PanelBody type={activePanel.type} preview={preview} charDir={charDir} chatName={chatName} />
            </ScrollArea>
        </aside>
    );
}
