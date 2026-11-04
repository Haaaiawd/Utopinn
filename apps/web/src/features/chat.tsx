// feature:chat — 聊天域。注册 nav、视图、session/diag 板块、
// prose 渲染器、ctbar 沉浸动作。壳不认识它,只认贡献点。
import { useI18n } from '../i18n';
import type { Registry } from '../kernel/registry';
import { useShell } from '../kernel/context';
import { ChatView } from '../components/chat/ChatView';
import { ProseRenderer } from '../components/chat/renderers/ProseRenderer';
import { SessionBody, DiagBody } from '../components/panels/bodies';
import { Icon } from '../components/Icon';
import { IconButton } from '../components/ui/icon-button';

function ImmersiveAction() {
    const { t } = useI18n();
    const { immersive } = useShell();
    return <IconButton label={t('menu.view.immersive')} icon={<Icon name="focus" size={16} />} onClick={immersive} />;
}

export function applyChatFeature(r: Registry) {
    r.add('nav.rail', { view: 'chat', icon: 'chat', order: 10 });
    r.add('view', { view: 'chat', Component: ChatView });
    r.add('panel.type', { type: 'session', icon: 'user', wired: true, Body: SessionBody });
    r.add('panel.type', { type: 'diag', icon: 'pulse', wired: true, Body: DiagBody });
    r.add('renderer', { id: 'prose', order: 10, Component: ProseRenderer });
    r.add('ctbar.chat', { id: 'immersive', order: 90, Component: ImmersiveAction });
}
