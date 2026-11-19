// RulesView — 世界书管理页(GPT「技能」式):
// 列表态:页头(标题+描述+搜索/新建) → 来源 chips → 卡格。
// 详情态:点卡进条目编辑器(启禁/注释/关键词/正文就地改,整档 PUT 回存)。
// 真实数据走 /api/utopinn/worlds(全局书);绑定书在卡上,列表
// 端点尚未覆盖 → chips 诚实显示空态。离线回退 mock + 徽标,写操作短路。
import { useCallback, useEffect, useMemo, useState } from 'react';
import { deleteWorld, getWorld, listWorlds, saveWorld } from '../../api/worlds';
import type { WorldDoc, WorldEntry, WorldListItem } from '../../api/worlds';
import { useI18n } from '../../i18n';
import { useShell } from '../../kernel/context';
import { Icon } from '../Icon';
import { Button } from '../ui/button';
import { IconButton } from '../ui/icon-button';
import { Input } from '../ui/input';
import { Textarea } from '../ui/textarea';
import { Badge } from '../ui/badge';
import { ToggleGroup, ToggleGroupItem } from '../ui/toggle-group';

const MOCK_WORLDS: WorldListItem[] = [
    { name: 'lighthouse-keepers', displayName: '灯塔守望者', extensions: { position: 0 } },
    { name: 'tide-and-salt', displayName: '潮与盐', extensions: {} },
];

const NEW_ENTRY = (uid: number): WorldEntry => ({
    uid, key: [], comment: '', content: '', order: uid, position: 0,
});

/** 列表态。 */
function WorldList({ worlds, mock, onOpen, onCreated, refresh }: {
    worlds: WorldListItem[]; mock: boolean;
    onOpen: (name: string) => void;
    onCreated: (name: string) => void;
    refresh: () => void;
}) {
    const { t } = useI18n();
    const { hint, setView } = useShell();
    const [filter, setFilter] = useState<'all' | 'global' | 'bound'>('all');
    const [query, setQuery] = useState('');
    const [creating, setCreating] = useState(false);
    const [newName, setNewName] = useState('');
    const [busy, setBusy] = useState(false);

    const visible = useMemo(() => {
        if (filter === 'bound') return []; // 绑定书端点未覆盖 —— 诚实空态
        const q = query.trim();
        return worlds.filter((w) => !q || w.displayName.includes(q) || w.name.includes(q));
    }, [worlds, filter, query]);

    const create = async () => {
        const name = newName.trim();
        if (!name || busy) return;
        if (mock) { hint(t('common.mockData'), true); return; }
        setBusy(true);
        try {
            await saveWorld(name, { entries: {} });
            setCreating(false);
            setNewName('');
            await Promise.resolve(refresh());
            onCreated(name);
        } catch (e) {
            hint(`${t('rules.saveFailed')}: ${e instanceof Error ? e.message : e}`, true);
        } finally {
            setBusy(false);
        }
    };

    return (
        <>
            <div className="lib-head">
                <div className="lib-head-text">
                    <h1>{t('rules.title')}</h1>
                    <p className="mut">{t('rules.desc')}</p>
                </div>
                <span className="grow" />
                <div className="relative">
                    <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">
                        <Icon name="search" size={12} />
                    </span>
                    <Input className="h-8 w-52 rounded-full border-transparent bg-bubble pl-8 text-[13px]"
                        placeholder={t('rules.search')} value={query} onChange={(e) => setQuery(e.target.value)} />
                </div>
                <Button variant="secondary" size="sm" onClick={() => { setCreating((v) => !v); setNewName(''); }}>
                    <Icon name="plus" size={14} />{t('rules.new')}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setView('import')}>
                    <Icon name="import" size={14} />{t('rules.import')}
                </Button>
            </div>

            {creating && (
                <div className="card mb-3 flex items-center gap-2 p-3">
                    <Input autoFocus value={newName} placeholder={t('rules.createName')}
                        onChange={(e) => setNewName(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') void create(); if (e.key === 'Escape') setCreating(false); }} />
                    <Button size="sm" disabled={busy || !newName.trim()} onClick={() => void create()}>{t('rules.create')}</Button>
                    <Button variant="ghost" size="sm" onClick={() => setCreating(false)}>{t('rules.cancel')}</Button>
                </div>
            )}

            <div className="lib-sect">
                <h3>{t('rules.installed')}</h3>
                {mock && <Badge variant="warning">{t('common.mockData')}</Badge>}
            </div>

            <ToggleGroup type="single" size="sm" className="lib-chips"
                value={filter} onValueChange={(v) => v && setFilter(v as typeof filter)}>
                {(['all', 'global', 'bound'] as const).map((f) => (
                    <ToggleGroupItem key={f} value={f}>{t(`rules.filter.${f}`)}</ToggleGroupItem>
                ))}
            </ToggleGroup>

            <div className="lib-tiles">
                {visible.map((w) => (
                    <div key={w.name} className="lib-tile" onClick={() => onOpen(w.name)}>
                        <span className="lib-tile-glyph"><Icon name="book" size={16} /></span>
                        <span className="lib-tile-text">
                            <span className="lib-tile-name">{w.displayName}</span>
                            <span className="lib-tile-sub mut">{w.name}</span>
                        </span>
                        <span className="lib-tile-check"><Icon name="check" size={12} /></span>
                    </div>
                ))}
                {visible.length === 0 && <div className="lib-empty">{t('rules.empty')}</div>}
            </div>
        </>
    );
}

/** 单条目的编辑卡 —— 就地改 draft,保存时随整档 PUT。 */
function EntryCard({ entry, onChange, onRemove }: {
    entry: WorldEntry;
    onChange: (patch: Partial<WorldEntry>) => void;
    onRemove: () => void;
}) {
    const { t } = useI18n();
    const [open, setOpen] = useState(false);
    const keys = (entry.key ?? []).join(', ');
    const title = entry.comment || keys || `#${entry.uid}`;

    return (
        <div className="rounded-md border border-border bg-surface">
            <div className="flex items-center gap-2 px-3 py-2">
                <button type="button" onClick={() => onChange({ disable: !entry.disable })}
                    className={`grid size-4 flex-none place-items-center rounded border transition-colors
                        ${entry.disable ? 'border-border text-transparent' : 'border-primary bg-primary text-primary-foreground'}`}
                    aria-label={t('rules.entry.enabled')}>
                    <Icon name="check" size={10} />
                </button>
                <button type="button" className="min-w-0 flex-1 truncate text-left text-[13px]" onClick={() => setOpen((v) => !v)}>
                    <span className="font-medium">{title}</span>
                    {entry.comment && keys && <span className="mut2 ml-2 text-xs">{keys}</span>}
                </button>
                <IconButton label={t('rules.entry.delete')} icon={<Icon name="x" size={13} />}
                    className="hover:text-destructive" onClick={onRemove} />
                <Icon name={open ? 'chevronDown' : 'chevronRight'} size={13} />
            </div>
            {open && (
                <div className="grid gap-2 border-t border-border p-3">
                    <Input value={entry.comment} placeholder={t('rules.entry.comment')}
                        onChange={(e) => onChange({ comment: e.target.value })} />
                    <Input value={keys} placeholder={t('rules.entry.keys')}
                        onChange={(e) => onChange({ key: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} />
                    <Textarea rows={4} value={entry.content} placeholder={t('rules.entry.content')}
                        onChange={(e) => onChange({ content: e.target.value })} />
                </div>
            )}
        </div>
    );
}

/** 详情态:整档载入 → 就地编辑 → 显式保存。 */
function WorldEditor({ name, mock, onBack }: { name: string; mock: boolean; onBack: () => void }) {
    const { t } = useI18n();
    const { hint } = useShell();
    const [doc, setDoc] = useState<WorldDoc | null>(null);
    const [dirty, setDirty] = useState(false);
    const [busy, setBusy] = useState(false);
    const [failed, setFailed] = useState(false);

    useEffect(() => {
        let dead = false;
        setDoc(null); setDirty(false); setFailed(false);
        getWorld(name)
            .then((r) => { if (!dead) setDoc(r.doc); })
            .catch(() => { if (!dead) setFailed(true); });
        return () => { dead = true; };
    }, [name]);

    const entries = useMemo(() => {
        if (!doc) return [];
        return Object.values(doc.entries).sort((a, b) => (a.order ?? a.uid) - (b.order ?? b.uid));
    }, [doc]);

    /** entries 键是 uid 字符串;按 uid 找键(noUncheckedIndexedAccess 下经 find 取值)。 */
    const keyOf = (d: WorldDoc, uid: number): string | null =>
        Object.keys(d.entries).find((k) => d.entries[k]?.uid === uid) ?? null;

    const patchEntry = (uid: number, patch: Partial<WorldEntry>) => {
        setDoc((d) => {
            if (!d) return d;
            const key = keyOf(d, uid);
            const cur = key != null ? d.entries[key] : undefined;
            if (key == null || !cur) return d;
            return { ...d, entries: { ...d.entries, [key]: { ...cur, ...patch } } };
        });
        setDirty(true);
    };

    const removeEntry = (uid: number) => {
        setDoc((d) => {
            if (!d) return d;
            const key = keyOf(d, uid);
            if (key == null) return d;
            const next = { ...d.entries };
            delete next[key];
            return { ...d, entries: next };
        });
        setDirty(true);
    };

    const addEntry = () => {
        setDoc((d) => {
            if (!d) return d;
            const uid = Math.max(0, ...Object.values(d.entries).map((e) => e.uid)) + 1;
            return { ...d, entries: { ...d.entries, [String(uid)]: NEW_ENTRY(uid) } };
        });
        setDirty(true);
    };

    const save = async () => {
        if (!doc || busy) return;
        if (mock) { hint(t('common.mockData'), true); return; }
        setBusy(true);
        try {
            await saveWorld(name, doc);
            setDirty(false);
            hint(t('rules.saved'));
        } catch (e) {
            hint(`${t('rules.saveFailed')}: ${e instanceof Error ? e.message : e}`, true);
        } finally {
            setBusy(false);
        }
    };

    const remove = async () => {
        if (busy) return;
        if (mock) { hint(t('common.mockData'), true); return; }
        if (!window.confirm(`${t('rules.deleteConfirm')}\n${name}`)) return;
        setBusy(true);
        try {
            await deleteWorld(name);
            onBack();
        } catch (e) {
            hint(`${t('rules.deleteFailed')}: ${e instanceof Error ? e.message : e}`, true);
            setBusy(false);
        }
    };

    return (
        <>
            <div className="lib-head">
                <IconButton label={t('rules.back')} icon={<Icon name="chevronLeft" size={15} />} onClick={onBack} />
                <div className="lib-head-text">
                    <h1>{name}</h1>
                    <p className="mut">{entries.length} {t('rules.entries')}{dirty ? ` · ${t('rules.unsaved')}` : ''}</p>
                </div>
                <span className="grow" />
                <Button variant="secondary" size="sm" onClick={addEntry} disabled={!doc}>
                    <Icon name="plus" size={14} />{t('rules.newEntry')}
                </Button>
                <Button variant="ghost" size="sm" className="text-destructive" onClick={() => void remove()}>
                    <Icon name="x" size={14} />{t('rules.delete')}
                </Button>
                <Button size="sm" disabled={!dirty || busy} onClick={() => void save()}>{t('rules.save')}</Button>
            </div>

            {failed && <div className="lib-empty">{t('rules.loadFailed')}</div>}
            <div className="grid gap-2">
                {entries.map((e) => (
                    <EntryCard key={e.uid} entry={e}
                        onChange={(patch) => patchEntry(e.uid, patch)}
                        onRemove={() => removeEntry(e.uid)} />
                ))}
                {doc && entries.length === 0 && <div className="lib-empty">{t('rules.noEntries')}</div>}
            </div>
        </>
    );
}

export function RulesView() {
    const [worlds, setWorlds] = useState<WorldListItem[]>([]);
    const [mock, setMock] = useState(false);
    const [editing, setEditing] = useState<string | null>(null);

    const refresh = useCallback(async () => {
        try {
            const r = await listWorlds();
            setWorlds(r.items);
            setMock(false);
        } catch {
            setWorlds(MOCK_WORLDS);
            setMock(true);
        }
    }, []);

    useEffect(() => { void refresh(); }, [refresh]);

    return (
        <div className="page-scroll lib">
            {editing == null ? (
                <WorldList worlds={worlds} mock={mock} refresh={refresh}
                    onOpen={setEditing} onCreated={setEditing} />
            ) : (
                <WorldEditor name={editing} mock={mock} onBack={() => { setEditing(null); void refresh(); }} />
            )}
        </div>
    );
}
