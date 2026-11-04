// Extensions — 扩展能力注册页(GPT「技能」式管理面)。
// 五类扩展点(插件/正则/快捷回复/注入/卡内资源)按卡列出。
// plugins 类已接线(TASK-021):卡下挂真实服务端插件管理段
// (启停落 patch.yaml / reload 热重载);其余类别仍标接线中。
import { useCallback, useEffect, useMemo, useState } from 'react';
import { disablePlugin, enablePlugin, listPlugins, reloadPlugin, type PluginItem } from '../../api/plugins';
import { useI18n } from '../../i18n';
import { useShell } from '../../kernel/context';
import { Icon, type IconName } from '../Icon';
import { Button } from '../ui/button';
import { IconButton } from '../ui/icon-button';
import { Input } from '../ui/input';
import { Badge } from '../ui/badge';
import { ToggleGroup, ToggleGroupItem } from '../ui/toggle-group';

type ExtCat = 'plugins' | 'regex' | 'quickReplies' | 'injections' | 'cardAssets';
const CATS: { id: ExtCat; icon: IconName; wired: boolean }[] = [
    { id: 'plugins', icon: 'extensions', wired: true },
    { id: 'regex', icon: 'zap', wired: false },
    { id: 'quickReplies', icon: 'command', wired: false },
    { id: 'injections', icon: 'file', wired: false },
    { id: 'cardAssets', icon: 'grid', wired: false },
];

const STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'warning' | 'destructive'> = {
    active: 'default', disabled: 'secondary', degraded: 'warning', failed: 'destructive',
};

/** 服务端插件行:启停切换 + reload;patched 徽标示意用户手调过。 */
function PluginRow({ p, onAct }: { p: PluginItem; onAct: (id: string, verb: 'enable' | 'disable' | 'reload') => void }) {
    const { t } = useI18n();
    const [busy, setBusy] = useState(false);
    const go = async (verb: 'enable' | 'disable' | 'reload') => {
        if (busy) return;
        setBusy(true);
        try { await Promise.resolve(onAct(p.id, verb)); } finally { setBusy(false); }
    };
    const enabled = !p.disabled && p.status !== 'disabled';
    return (
        <div className="flex items-center gap-3 rounded-md border border-border bg-surface px-3 py-2">
            <span className="lib-tile-glyph"><Icon name="extensions" size={15} /></span>
            <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                    <span className="truncate text-[13px] font-medium">{p.id}</span>
                    <Badge variant={STATUS_VARIANT[p.status] ?? 'secondary'}>
                        {t(`ext.plugin.status.${p.status}`) === `ext.plugin.status.${p.status}` ? p.status : t(`ext.plugin.status.${p.status}`)}
                    </Badge>
                    {p.patch && <Badge variant="secondary">{t('ext.plugin.patched')}</Badge>}
                </span>
                <span className="block truncate text-xs text-muted-foreground">{p.module}</span>
            </span>
            <IconButton label={t('ext.plugin.reload')} icon={<Icon name="refresh" size={13} />}
                disabled={busy || !enabled} onClick={() => void go('reload')} />
            <Button variant={enabled ? 'ghost' : 'secondary'} size="sm" disabled={busy}
                onClick={() => void go(enabled ? 'disable' : 'enable')}>
                {enabled ? t('ext.plugin.disable') : t('ext.plugin.enable')}
            </Button>
        </div>
    );
}

/** 插件管理段:真实服务端清单,启停/reload 即调即刷新。 */
function PluginsSection() {
    const { t } = useI18n();
    const { hint } = useShell();
    const [items, setItems] = useState<PluginItem[] | null>(null);

    const refresh = useCallback(async () => {
        try {
            const r = await listPlugins();
            setItems(r.items);
        } catch {
            setItems([]);
        }
    }, []);

    useEffect(() => { void refresh(); }, [refresh]);

    const act = useCallback(async (id: string, verb: 'enable' | 'disable' | 'reload') => {
        try {
            const r = await (verb === 'enable' ? enablePlugin : verb === 'disable' ? disablePlugin : reloadPlugin)(id);
            if (!r.ok) hint(`${t('ext.plugin.actFailed')}: ${r.error ?? verb}`, true);
            await refresh();
        } catch (e) {
            hint(`${t('ext.plugin.actFailed')}: ${e instanceof Error ? e.message : e}`, true);
        }
    }, [refresh, hint, t]);

    return (
        <div className="mt-4">
            <div className="lib-sect">
                <h3>{t('ext.plugins')}</h3>
                <p className="mut text-xs">{t('ext.plugins.desc')}</p>
            </div>
            <div className="grid gap-2">
                {(items ?? []).map((p) => <PluginRow key={p.id} p={p} onAct={act} />)}
                {items != null && items.length === 0 && <div className="lib-empty">{t('ext.plugins.empty')}</div>}
            </div>
        </div>
    );
}

export function ExtensionsView() {
    const { t } = useI18n();
    const { hint } = useShell();
    const [cat, setCat] = useState<'all' | ExtCat>('all');
    const [query, setQuery] = useState('');

    const visible = useMemo(() => CATS.filter((c) => {
        if (cat !== 'all' && c.id !== cat) return false;
        const q = query.trim();
        return !q || t(`ext.cat.${c.id}`).includes(q) || t(`ext.desc.${c.id}`).includes(q);
    }), [cat, query, t]);

    return (
        <div className="page-scroll lib">
            <div className="lib-head">
                <div className="lib-head-text">
                    <h1>{t('ext.title')}</h1>
                    <p className="mut">{t('ext.desc')}</p>
                </div>
                <span className="grow" />
                <div className="relative">
                    <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">
                        <Icon name="search" size={12} />
                    </span>
                    <Input className="h-8 w-52 rounded-full border-transparent bg-bubble pl-8 text-[13px]"
                        placeholder={t('ext.search')} value={query} onChange={(e) => setQuery(e.target.value)} />
                </div>
                <Button variant="secondary" size="sm" onClick={() => hint(t('ext.newSoon'))}>
                    <Icon name="plus" size={14} />{t('ext.new')}
                </Button>
            </div>

            <div className="lib-sect">
                <h3>{t('ext.installed')}</h3>
                <Badge variant="warning">{t('ext.stubBadge')}</Badge>
            </div>

            <ToggleGroup type="single" size="sm" className="lib-chips"
                value={cat} onValueChange={(v) => v && setCat(v as typeof cat)}>
                <ToggleGroupItem value="all">{t('ext.filter.all')}</ToggleGroupItem>
                {CATS.map((c) => (
                    <ToggleGroupItem key={c.id} value={c.id}>{t(`ext.cat.${c.id}`)}</ToggleGroupItem>
                ))}
            </ToggleGroup>

            <div className="lib-tiles">
                {visible.map((c) => (
                    <div key={c.id} className="lib-tile" onClick={c.wired ? undefined : () => hint(t('ext.tileSoon'))}>
                        <span className="lib-tile-glyph"><Icon name={c.icon} size={16} /></span>
                        <span className="lib-tile-text">
                            <span className="lib-tile-name">{t(`ext.cat.${c.id}`)}</span>
                            <span className="lib-tile-sub mut">{t(`ext.desc.${c.id}`)}</span>
                        </span>
                        {/* 接线完成的类不贴 stub 徽标;未接线的统一中性 secondary。 */}
                        {!c.wired && <Badge variant="secondary">{t('ext.stubBadge')}</Badge>}
                    </div>
                ))}
                {visible.length === 0 && <div className="lib-empty">{t('ext.empty')}</div>}
            </div>

            {(cat === 'all' || cat === 'plugins') && <PluginsSection />}
        </div>
    );
}
