// sidebar.tree 贡献体 —— 各域左树内容归 feature。
// chat 域:置顶区 + 「我的项目」会话组(规范稿 PROJECTS 树形)。
// studio 域:板块目录;plugins 域:installed/market 两段。
import { useShell } from '../../kernel/context';
import { useI18n } from '../../i18n';
import { Icon } from '../Icon';
import type { ChatSummary } from '../../types';
import { STUDIO_NAV_META, normStudioNav, useStudioCounts } from '../views/studio';

const head = 'mb-1 mt-3 flex items-center justify-between px-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-[color:var(--fg-faint)]';
const rowCls = 'ghost-btn w-full justify-start gap-2 rounded-md px-2 py-[6px] text-left text-[12px]';

function SessionRow({ s }: { s: ChatSummary }) {
    const shell = useShell();
    const active = shell.activeChat === s.id;
    return (
        <button
            className={rowCls}
            style={active ? { background: 'var(--bg-active)', color: 'var(--fg-primary)' } : { color: 'var(--fg-secondary)' }}
            onClick={() => shell.selectChat(s.id)}
        >
            <Icon
                name={s.stage === 'novel' ? 'feather' : s.stage === 'messenger' ? 'messages' : s.stage === 'galgame' ? 'sparkles' : 'chat'}
                size={12}
                className="shrink-0 text-[color:var(--fg-faint)]"
            />
            <span className="min-w-0 flex-1 truncate">{s.title}</span>
            {s.unread && <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: 'var(--brand)' }} />}
            {s.updatedAt && <span className="shrink-0 font-mono-ui text-[9px] text-[color:var(--fg-faint)]">{s.updatedAt}</span>}
        </button>
    );
}

/** chat 域树(规范稿:「+ 选择卡面」按钮 + 置顶 + 角色卡与会话分组)。 */
export function ChatTree() {
    const { t } = useI18n();
    const shell = useShell();
    const pinned = shell.chats.filter((c) => c.pinned);
    const rest = shell.chats.filter((c) => !c.pinned);
    /** 角色卡与会话:按 charDir 分组,组头=卡名。 */
    const groups = new Map<string, ChatSummary[]>();
    for (const c of rest) {
        const g = groups.get(c.charDir) ?? [];
        g.push(c);
        groups.set(c.charDir, g);
    }
    return (
        <div>
            <button
                className="inset-group inset-row-btn mb-2 flex w-full items-center justify-center gap-1.5 py-2 text-[12px] font-medium text-[color:var(--fg-primary)]"
                onClick={() => shell.newChat()}
            >
                <Icon name="plus" size={12} /> {t('tree.pickCard')}
            </button>
            <div className={head}>
                <span>{t('tree.pinned')}</span>
            </div>
            {pinned.map((s) => <SessionRow key={s.id} s={s} />)}
            <div className={head}>
                <span>{t('tree.cardSessions')}</span>
                <span className="font-mono-ui text-[9px] normal-case tracking-normal">{t('tree.manage')}</span>
            </div>
            {[...groups.entries()].map(([dir, list]) => (
                <div key={dir} className="mb-1">
                    <div className="flex items-center gap-2 px-2 py-1">
                        <span className="flex h-4 w-4 items-center justify-center rounded-full text-[8px]" style={{ background: 'var(--bg-active)', color: 'var(--fg-secondary)' }}>{dir[0]}</span>
                        <span className="truncate text-[11px] font-medium text-[color:var(--fg-secondary)]">{dir}</span>
                    </div>
                    <div className="ml-3 border-l border-[color:var(--border-hairline)] pl-1">
                        {list.map((s) => <SessionRow key={s.id} s={s} />)}
                    </div>
                </div>
            ))}
        </div>
    );
}

/** studio 域树:六类目录(端稿 studio nav —— cards/global/worldbook/presets/
 *  persona/regex;行尾带真实计数)。 */
export function StudioTree() {
    const { t } = useI18n();
    const shell = useShell();
    const counts = useStudioCounts();
    const nav = normStudioNav(shell.studioNav);
    return (
        <div>
            {STUDIO_NAV_META.map(({ id, icon }) => (
                <button
                    key={id}
                    className={rowCls}
                    style={nav === id ? { background: 'var(--bg-active)', color: 'var(--fg-primary)' } : { color: 'var(--fg-secondary)' }}
                    onClick={() => shell.setStudioNav(id)}
                >
                    <Icon name={icon} size={12} className="shrink-0 text-[color:var(--fg-faint)]" />
                    <span className="truncate">{t(`studio.nav.${id}`)}</span>
                    <span className="ml-auto shrink-0 font-mono-ui text-[9.5px] text-[color:var(--fg-faint)]">{counts[id]}</span>
                </button>
            ))}
        </div>
    );
}

/** plugins 域树:installed / market 两段切换。 */
export function PluginsTree() {
    const { t } = useI18n();
    const shell = useShell();
    return (
        <div>
            {(['installed', 'market'] as const).map((id) => (
                <button
                    key={id}
                    className={rowCls}
                    style={shell.pluginsNav === id ? { background: 'var(--bg-active)', color: 'var(--fg-primary)' } : { color: 'var(--fg-secondary)' }}
                    onClick={() => shell.setPluginsNav(id)}
                >
                    <Icon name={id === 'installed' ? 'puzzle' : 'store'} size={12} className="shrink-0 text-[color:var(--fg-faint)]" />
                    <span className="truncate">{t(`plugins.nav.${id}`)}</span>
                    {id === 'installed' && (
                        <span className="ml-auto font-mono-ui text-[9.5px] text-[color:var(--fg-faint)]">{shell.builtinPlugins.length + shell.marketPlugins.filter((p) => p.installed).length}</span>
                    )}
                </button>
            ))}
        </div>
    );
}
