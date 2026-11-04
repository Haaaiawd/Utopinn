// feature:panels — 板块宿主配套贡献:cardapp/analysis 板块类型 +
// ctbar 的 "+" 添加器(唯一常驻入口,板块清空时右栏自动收起)。
import { useI18n } from '../i18n';
import type { Registry } from '../kernel/registry';
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

export function applyPanelsFeature(r: Registry) {
    r.add('panel.type', { type: 'cardapp', icon: 'layout', wired: true, Body: CardAppBody });
    r.add('panel.type', { type: 'analysis', icon: 'chartLine', wired: false, Body: stubBody('panel.type.analysis') });
    r.add('ctbar.chat', { id: 'panel-add', order: 80, Component: PanelAddAction });
}
