// 板块本体 —— 经 panel.type 贡献点注册,宿主不 switch。
// 全部无 props:数据走 useShell(),板块只画自己的面。
import type { ComponentType } from 'react';
import { useI18n } from '../../i18n';
import { useShell } from '../../kernel/context';
import { PreviewDebug } from '../chat/PreviewDebug';
import { CardAppFrame } from '../../cardapp/CardAppFrame';

export function SessionBody() {
    const { t } = useI18n();
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
}

export function DiagBody() {
    const { preview } = useShell();
    return <PreviewDebug result={preview} />;
}

export function CardAppBody() {
    const { t } = useI18n();
    const { chat } = useShell();
    if (chat?.charDir) return <CardAppFrame charDir={chat.charDir} chatName={chat.chatName} />;
    return (
        <div className="sp-card">
            <h4>{t('panel.type.cardapp')}</h4>
            <p className="mut" style={{ lineHeight: 1.7 }}>{t('panel.panels.empty')}</p>
        </div>
    );
}

/** 未接线板块的诚实占位 —— 注册体用 stubBody('panel.type.x') 一行造成组件。 */
export function stubBody(titleKey: string): ComponentType {
    return function StubBody() {
        const { t } = useI18n();
        return (
            <div className="sp-card">
                <h4>{t(titleKey)}</h4>
                <p className="mut" style={{ lineHeight: 1.7 }}>{t('panel.stub')}</p>
            </div>
        );
    };
}
