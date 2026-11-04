// Right bar — multi-panel host. Panels are typed instances added via the "+"
// picker (本局/诊断/面板/浏览器/分析…), each living as a closable tab —
// the host owns the strip, panel bodies render per type. Contextual data
// (preview, charDir) flows down from App.
import { useI18n } from '../../i18n';
import type { PreviewResult } from '../../types';
import { Icon, type IconName } from '../Icon';
import { IconButton } from '../ui/icon-button';
import { ScrollArea } from '../ui/scroll-area';
import {
    DropdownMenu, DropdownMenuContent, DropdownMenuItem,
    DropdownMenuLabel, DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { PreviewDebug } from '../chat/PreviewDebug';
import { CardAppFrame } from '../../cardapp/CardAppFrame';

export type PanelType = 'session' | 'diag' | 'cardapp' | 'browser' | 'analysis';
export interface PanelInst { id: string; type: PanelType }

const PANEL_TYPES: { type: PanelType; icon: IconName; wired: boolean }[] = [
    { type: 'session', icon: 'user', wired: true },
    { type: 'diag', icon: 'pulse', wired: true },
    { type: 'cardapp', icon: 'layout', wired: true },
    { type: 'browser', icon: 'globe', wired: false },
    { type: 'analysis', icon: 'chartLine', wired: false },
];

const PANEL_ICON: Record<PanelType, IconName> =
    Object.fromEntries(PANEL_TYPES.map((p) => [p.type, p.icon])) as Record<PanelType, IconName>;

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

export function RightPanel({ panels, active, preview, hidden, wide, charDir, chatName, onSelect, onClose, onAdd, onToggleWide, onHide }: {
    panels: PanelInst[];
    active: string | null;
    preview: PreviewResult | null;
    hidden: boolean;
    wide: boolean;
    charDir?: string;
    chatName?: string;
    onSelect: (id: string) => void;
    onClose: (id: string) => void;
    onAdd: (type: PanelType) => void;
    onToggleWide: () => void;
    onHide: () => void;
}) {
    const { t } = useI18n();
    if (hidden) return null;
    const activePanel = panels.find((p) => p.id === active) ?? panels[0] ?? null;

    return (
        <aside className={`upanel${wide ? ' wide' : ''}`}>
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
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <span><IconButton size="icon-sm" label={t('panel.add')} icon={<Icon name="plus" size={16} />} /></span>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent side="bottom" align="end">
                        <DropdownMenuLabel>{t('panel.add')}</DropdownMenuLabel>
                        {PANEL_TYPES.map((pt) => (
                            <DropdownMenuItem key={pt.type} onClick={() => onAdd(pt.type)}>
                                <Icon name={pt.icon} size={12} />
                                {t(`panel.type.${pt.type}`)}
                                {!pt.wired && <span className="mut" style={{ marginLeft: 'auto' }}>{t('panel.soon')}</span>}
                            </DropdownMenuItem>
                        ))}
                    </DropdownMenuContent>
                </DropdownMenu>
                <IconButton size="icon-sm" label={t('panel.wide')} icon={<Icon name="focus" size={12} />} onClick={onToggleWide} />
                <IconButton size="icon-sm" label={t('menu.view.togglePanel')} icon={<Icon name="panelRight" size={12} mirrored />} onClick={onHide} />
            </div>

            <ScrollArea className="sp-body">
                {activePanel ? (
                    <PanelBody type={activePanel.type} preview={preview} charDir={charDir} chatName={chatName} />
                ) : (
                    <div className="sp-card">
                        <p className="mut" style={{ lineHeight: 1.7 }}>{t('panel.empty')}</p>
                    </div>
                )}
            </ScrollArea>
        </aside>
    );
}
