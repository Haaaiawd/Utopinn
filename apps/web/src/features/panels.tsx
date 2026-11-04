// feature:panels — 板块宿主配套贡献:cardapp/analysis 板块类型 +
// ctbar 的 "+" 添加器(唯一常驻入口,板块清空时右栏自动收起)+ 本域词条。
import { useI18n } from '../i18n';
import type { Feature, FeatureCtx } from '../kernel/kernel';
import { useContribs, useShell } from '../kernel/context';
import { CardAppBody, stubBody } from '../components/panels/bodies';
import { Icon } from '../components/Icon';
import { IconButton } from '../components/ui/icon-button';
import {
    DropdownMenu, DropdownMenuContent, DropdownMenuItem,
    DropdownMenuLabel, DropdownMenuTrigger,
} from '../components/ui/dropdown-menu';

function PanelAddAction() {
    const { t } = useI18n();
    const { addPanel } = useShell();
    const types = useContribs('panel.type');
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <span><IconButton label={t('panel.add')} icon={<Icon name="plus" size={16} />} /></span>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="bottom" align="end">
                <DropdownMenuLabel>{t('panel.add')}</DropdownMenuLabel>
                {types.map((pt) => (
                    <DropdownMenuItem key={pt.type} onClick={() => addPanel(pt.type)}>
                        <Icon name={pt.icon} size={12} />
                        {t(`panel.type.${pt.type}`)}
                        {!pt.wired && <span className="mut" style={{ marginLeft: 'auto' }}>{t('panel.soon')}</span>}
                    </DropdownMenuItem>
                ))}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

export const panelsFeature: Feature = {
    name: 'panels',
    apply(ctx: FeatureCtx) {
        ctx.add('panel.type', { type: 'cardapp', icon: 'layout', wired: true, Body: CardAppBody });
        ctx.add('panel.type', { type: 'analysis', icon: 'chartLine', wired: false, Body: stubBody('panel.type.analysis') });
        ctx.add('ctbar.chat', { id: 'panel-add', order: 80, Component: PanelAddAction });
        ctx.locale('panels', {
            'zh-CN': {
                'panel.type.cardapp': '面板',
                'panel.type.analysis': '分析',
                'panel.add': '添加板块',
                'panel.close': '关闭板块',
                'panel.stub': '该板块类型已在注册表,本体接线中。',
                'panel.soon': '接线中',
                'panel.panels.empty': '卡内面板(CardApp)入口。当前卡未声明面板。',
                'panel.cardapp.mountFailed': '面板装载失败',
                'panel.cardapp.retry': '重试',
                'panel.cardapp.ctxDegraded': 'ctx 面接线中',
            },
            en: {
                'panel.type.cardapp': 'Panels',
                'panel.type.analysis': 'Analysis',
                'panel.add': 'Add panel',
                'panel.close': 'Close panel',
                'panel.stub': 'Panel type registered; body still being wired.',
                'panel.soon': 'Wiring',
                'panel.panels.empty': 'Card-app panel entries. This card declares no panels.',
                'panel.cardapp.mountFailed': 'Panel mount failed',
                'panel.cardapp.retry': 'Retry',
                'panel.cardapp.ctxDegraded': 'ctx face pending',
            },
        });
    },
};
