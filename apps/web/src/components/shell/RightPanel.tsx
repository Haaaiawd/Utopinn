// Right panel — the session face for the chat domain (IA §14: 本局面板,
// tabs 本局/状态/库). The diagnostics tab hosts the live preview output —
// the request-inspector face of the diagnostics domain.
import { useState } from 'react';
import { useI18n } from '../../i18n';
import type { PreviewResult } from '../../types';
import { Icon } from '../Icon';
import { Tabs, TabsList, TabsTrigger } from '../ui/tabs';
import { ScrollArea } from '../ui/scroll-area';
import { PreviewDebug } from '../chat/PreviewDebug';
import { CardAppFrame } from '../../cardapp/CardAppFrame';

type PanelTab = 'session' | 'diag' | 'panels';

export function RightPanel({ preview, hidden, charDir, chatName }: { preview: PreviewResult | null; hidden: boolean; charDir?: string; chatName?: string }) {
    const { t } = useI18n();
    const [tab, setTab] = useState<PanelTab>('diag');
    if (hidden) return null;

    return (
        <aside className="upanel">
            <Tabs className="sp-tabs" value={tab} onValueChange={(v) => setTab(v as PanelTab)}>
                <TabsList className="w-full">
                    <TabsTrigger className="flex-1" value="session">{t('panel.session')}</TabsTrigger>
                    <TabsTrigger className="flex-1" value="diag">{t('panel.diag')}</TabsTrigger>
                    <TabsTrigger className="flex-1" value="panels">{t('panel.panels')}</TabsTrigger>
                </TabsList>
            </Tabs>
            <ScrollArea className="sp-body">
                {tab === 'session' && (
                    <div className="sp-card">
                        <h4>{t('panel.session')}</h4>
                        {(['panel.session.authorNote', 'panel.session.cfg', 'panel.session.logprobs'] as const).map((k) => (
                            <div className="row" key={k}>
                                <span className="lab">{t(k)}</span>
                                <span className="mut">{t('panel.session.unwired')}</span>
                            </div>
                        ))}
                    </div>
                )}
                {tab === 'diag' && <PreviewDebug result={preview} />}
                {tab === 'panels' && (
                    charDir ? (
                        <CardAppFrame charDir={charDir} chatName={chatName} />
                    ) : (
                        <div className="sp-card">
                            <h4>{t('panel.panels')}</h4>
                            <p className="mut" style={{ lineHeight: 1.7 }}>
                                <Icon name="layout" size={12} /> {t('panel.panels.empty')}
                            </p>
                        </div>
                    )
                )}
            </ScrollArea>
        </aside>
    );
}
