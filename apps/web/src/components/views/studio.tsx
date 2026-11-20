// 规范稿 studio 六页(端稿 renderStudioMain)+ 移动端资产工坊(renderMobileHubPage)。
// 六类对齐端稿 studio nav:cards/global/worldbook/presets/persona/regex ——
// 旧实现 lore/chars/prompts/regex/files 词表作废(spec-v2-check D5 裁定稿侧为准)。
//
// 诚实面约定(wired 映射):
//   worldbook 列表/条目启停 = GET/PUT /worlds 全真;命中率徽标 = stats/inject
//     (api/stats.ts 在场则吃真数据,取不到/无会话 → 无徽标,不装数)。
//   global    全局栈读面真(settings.world_info_settings.world_info.globalSelect);
//     写面不在 PATCH 白名单 → 开关渲染但 disabled + 说明。
//   presets   列表/参数/调参写全真;「设为默认」写面(settings.preset_settings_openai)
//     不在白名单 → disabled 徽标。
//   persona   GET/PUT/DELETE 全真。
//   regex     服务端无 /regex 面(C7)—— 条目名从卡 extensions.regex_scripts 真读,
//     无启停控件,只读列表 + 排期徽标。
import { useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useShell } from '../../kernel/context';
import { useI18n } from '../../i18n';
import { Icon, type IconName } from '../Icon';
import { PanelEmpty, PanelError, chatKey, useRemote } from '../panels/panelShared';
import { cardData, getCharacter, charImageUrl, type CardDoc, type CardItem } from '../../api/characters';
import { listWorlds, getWorld, saveWorld, type WorldDoc, type WorldListItem, type WorldEntry } from '../../api/worlds';
import { getSettings } from '../../api/settings';
import { listPresets, getPreset, savePreset, type PresetDocument } from '../../api/presets';
import { listPersonas, savePersona, deletePersona, type PersonaItem } from '../../api/personas';
import { statsInject } from '../../api/stats';
import { openImportModal, openCharEditor } from '../shell/overlayBus';

/* ------------------------------------------------------------------ */
/* studio nav 词表(端稿 L958-966 六类)                                  */
/* ------------------------------------------------------------------ */

export const STUDIO_NAVS = ['cards', 'global', 'worldbook', 'presets', 'persona', 'regex'] as const;
export type StudioNav = (typeof STUDIO_NAVS)[number];
export const STUDIO_NAV_META: { id: StudioNav; icon: IconName }[] = [
    { id: 'cards', icon: 'home' },
    { id: 'global', icon: 'layers' },
    { id: 'worldbook', icon: 'bookOpen' },
    { id: 'presets', icon: 'sliders' },
    { id: 'persona', icon: 'persona' },
    { id: 'regex', icon: 'code' },
];
/** 旧词表(lore/chars/prompts/files)与非枚举值一律落 'cards'(App 缺省值兼容)。 */
export function normStudioNav(v: string): StudioNav {
    return (STUDIO_NAVS as readonly string[]).includes(v) ? (v as StudioNav) : 'cards';
}

/* ------------------------------------------------------------------ */
/* 共享小件                                                            */
/* ------------------------------------------------------------------ */

function Switch({ on, onToggle, disabled, title }: { on: boolean; onToggle?: () => void; disabled?: boolean; title?: string }) {
    return (
        <button
            className="sh-switch"
            data-checked={on || undefined}
            onClick={disabled ? undefined : onToggle}
            disabled={disabled}
            title={title}
            style={disabled ? { opacity: 0.45, cursor: 'not-allowed' } : undefined}
        >
            <span className="sh-switch-thumb" />
        </button>
    );
}

/** 诚实徽标(协议未备/只读/排期)—— 与 panel.badge.unwired 同款 mono 小章。 */
export function WiredBadge({ children, warn }: { children: ReactNode; warn?: boolean }) {
    return (
        <span
            className="shrink-0 rounded px-1.5 py-0.5 font-mono-ui text-[10px]"
            style={{
                background: 'var(--bg-active)',
                border: '1px solid var(--border-hairline)',
                color: warn ? 'var(--status-warn)' : 'var(--fg-muted)',
            }}
        >
            {children}
        </span>
    );
}

/* ------------------------------------------------------------------ */
/* 数据 hooks —— 模块级文档缓存(world/卡文档多消费者共用,避免重复 GET)    */
/* ------------------------------------------------------------------ */

const worldDocCache = new Map<string, Promise<WorldDoc>>();
function loadWorldDoc(name: string): Promise<WorldDoc> {
    let p = worldDocCache.get(name);
    if (!p) {
        p = getWorld(name).then((r) => r.doc);
        worldDocCache.set(name, p);
        p.catch(() => worldDocCache.delete(name));
    }
    return p;
}
/** 写后失效 —— saveWorld 成功后调用方应清缓存再 reload。 */
function invalidateWorldDoc(name: string): void {
    worldDocCache.delete(name);
}

const cardDocCache = new Map<string, Promise<CardDoc>>();
function loadCardDoc(charDir: string): Promise<CardDoc> {
    let p = cardDocCache.get(charDir);
    if (!p) {
        p = getCharacter(charDir);
        cardDocCache.set(charDir, p);
        p.catch(() => cardDocCache.delete(charDir));
    }
    return p;
}

const presetDocCache = new Map<string, Promise<PresetDocument>>();
function loadPresetDoc(name: string, apiId = 'openai'): Promise<PresetDocument> {
    const key = `${apiId}/${name}`;
    let p = presetDocCache.get(key);
    if (!p) {
        p = getPreset(name, apiId).then((r) => r.doc);
        presetDocCache.set(key, p);
        p.catch(() => presetDocCache.delete(key));
    }
    return p;
}

/** 全部书文件的条目数(map: name → count|null;null = 读不出)。 */
function useWorldCounts(items: WorldListItem[]) {
    const namesKey = items.map((i) => i.name).join('|');
    return useRemote(namesKey ? `world-counts:${items.length}:${namesKey.length}` : null, async () => {
        const out: Record<string, number | null> = {};
        await Promise.all(items.map(async (w) => {
            try {
                out[w.name] = Object.keys((await loadWorldDoc(w.name)).entries ?? {}).length;
            } catch {
                out[w.name] = null;
            }
        }));
        return out;
    });
}

/** 卡 → 书反查:extensions.world 主绑 + settings charLore 辅书两层。 */
function useWorldBindings(cards: CardItem[]) {
    const key = cards.map((c) => c.charDir).join('|');
    return useRemote(key ? `world-bind:${cards.length}:${key.length}` : null, async () => {
        const map: Record<string, string[]> = {};
        const push = (world: string, label: string) => {
            (map[world] ??= []).includes(label) || map[world]!.push(label);
        };
        await Promise.all(cards.map(async (c) => {
            try {
                const doc = await loadCardDoc(c.charDir);
                const world = cardData(doc).extensions?.world;
                if (typeof world === 'string' && world) push(world, c.name || c.charDir);
            } catch { /* 读不出的卡不进反查 */ }
        }));
        try {
            const { settings } = await getSettings();
            const cl = ((settings?.world_info_settings as Record<string, unknown> | undefined)?.world_info as
                { charLore?: { name?: unknown; extraBooks?: unknown }[] } | undefined)?.charLore;
            if (Array.isArray(cl)) {
                for (const l of cl) {
                    const dir = typeof l?.name === 'string' ? l.name : '';
                    const label = cards.find((c) => c.charDir === dir)?.name || dir;
                    if (Array.isArray(l?.extraBooks)) {
                        for (const b of l.extraBooks) if (typeof b === 'string' && b) push(b, label);
                    }
                }
            }
        } catch { /* settings 取不到 → 只用卡面绑定层 */ }
        return map;
    });
}

interface SettingsSlices {
    /** 全局勾选书目(settings.world_info_settings.world_info.globalSelect)。 */
    globalSelect: string[];
    /** 当前启用预设名(preset_settings_openai;oai_settings 内嵌形兼容)。 */
    activePreset: string | null;
    /** 上游源(oai_settings.chat_completion_source)。 */
    connSource: string | null;
    /** 上游 Base URL(oai_settings.reverse_proxy 优先,custom_url 兜底)。 */
    connBaseUrl: string | null;
    raw: Record<string, unknown> | null;
}

function sliceSettings(settings: Record<string, unknown> | null | undefined): SettingsSlices {
    const s = settings ?? {};
    const wi = (s.world_info_settings as Record<string, unknown> | undefined)?.world_info as
        Record<string, unknown> | undefined;
    const oai = s.oai_settings as Record<string, unknown> | undefined;
    const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : null);
    return {
        globalSelect: Array.isArray(wi?.globalSelect) ? wi!.globalSelect.filter((x): x is string => typeof x === 'string') : [],
        activePreset: str(s.preset_settings_openai) ?? str(oai?.preset_settings_openai),
        connSource: str(oai?.chat_completion_source),
        connBaseUrl: str(oai?.reverse_proxy) ?? str(oai?.custom_url),
        raw: settings ?? null,
    };
}

export function useSettingsSlices() {
    const r = useRemote('settings', () => getSettings());
    return { ...r, slices: useMemo(() => sliceSettings(r.data?.settings ?? null), [r.data]) };
}

/** WI 条目命中表 —— stats/inject(worldinfo 源 entries)。
 *  chat 有选中会话时按会话过滤,否则全域聚合;取数失败 → 组件层渲染无徽标。 */
function useWiHits(chatLabel: string | null) {
    return useRemote(`wi-hits:${chatLabel ?? 'all'}`, async () => {
        const r = await statsInject(chatLabel ?? undefined);
        const wi = r.sources.find((x) => x.source === 'worldinfo');
        return { events: wi?.events ?? 0, entries: wi?.entries ?? [], empty: r.empty };
    });
}

/** 侧栏计数(端稿 cats.count):cards=卡数;global=选中/总数;worldbook=条目总数;
 *  presets/persona=总数;regex 无管理面 → 'C7' 章。 */
export function useStudioCounts(): Record<StudioNav, string> {
    const s = useShell();
    const worlds = useRemote('studio-cnt:worlds', listWorlds);
    const presets = useRemote('studio-cnt:presets', () => listPresets('openai'));
    const personas = useRemote('studio-cnt:personas', listPersonas);
    const { slices } = useSettingsSlices();
    const items = worlds.data?.items ?? [];
    const counts = useWorldCounts(items);
    const entrySum = counts.data ? Object.values(counts.data).reduce((a: number, b) => a + (b ?? 0), 0) : null;
    return {
        cards: String(s.cards.size),
        global: `${slices.globalSelect.length}/${items.length}`,
        worldbook: entrySum !== null ? String(entrySum) : (worlds.data ? String(items.length) : '…'),
        presets: presets.data ? String(presets.data.total) : '…',
        persona: personas.data ? String(personas.data.total) : '…',
        regex: 'C7',
    };
}

/* ------------------------------------------------------------------ */
/* 页壳(端稿 renderStudioMain 外框:移动 header + 桌面标题行 + 导入钮)     */
/* ------------------------------------------------------------------ */

function StudioShell({ nav, children }: { nav: StudioNav; children: ReactNode }) {
    const { t } = useI18n();
    const s = useShell();
    const importBtn = (
        <button
            className={`shrink-0 rounded-lg font-medium ${s.isMobile ? 'h-7 px-2.5 text-[11.5px]' : 'h-8 px-3.5 text-[12px]'}`}
            style={{ background: 'var(--brand)', color: 'var(--brand-fg)' }}
            onClick={openImportModal}
        >
            + {t('ov.import.short')}
        </button>
    );
    return (
        <section className="flex h-full min-w-0 flex-1 flex-col" style={{ background: 'var(--bg-canvas)' }}>
            {s.isMobile && (
                <header className="flex h-12 shrink-0 items-center justify-between border-b border-[color:var(--border-hairline)] px-3">
                    <div className="flex min-w-0 items-center gap-1.5">
                        <button className="ghost-btn h-8 w-8 shrink-0" onClick={() => s.setView('hub')}>
                            <Icon name="arrowLeft" size={16} />
                        </button>
                        <span className="heading-tight truncate text-[14px] font-medium text-[color:var(--fg-primary)]">{t(`studio.${nav}.title`)}</span>
                    </div>
                    {importBtn}
                </header>
            )}
            <div className={`min-h-0 flex-1 overflow-y-auto ${s.isMobile ? 'p-4' : 'px-10 py-8'}`}>
                <div className="mx-auto max-w-4xl space-y-5">
                    {!s.isMobile && (
                        <div className="flex flex-wrap items-start justify-between gap-4">
                            <div>
                                <h1 className="heading-tight text-xl font-medium text-[color:var(--fg-primary)]">{t(`studio.${nav}.title`)}</h1>
                                <p className="mt-1 text-[12.5px] text-[color:var(--fg-muted)]">{t(`studio.${nav}.sub`)}</p>
                            </div>
                            {importBtn}
                        </div>
                    )}
                    {children}
                </div>
            </div>
        </section>
    );
}

/* ------------------------------------------------------------------ */
/* 1. cards —— 卡格 + 详情/编辑(端稿 L1862)                              */
/* ------------------------------------------------------------------ */

function CardsPage() {
    const { t } = useI18n();
    const s = useShell();
    const cards = [...s.cards.values()];
    const chatCount = (dir: string) => s.chats.filter((c) => c.charDir === dir).length;
    if (!cards.length) return <PanelEmpty icon="home">{t('studio.cards.empty')}</PanelEmpty>;
    return (
        <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
            {cards.map((c) => (
                <CardGridTile key={c.charDir} card={c} chatCount={chatCount(c.charDir)} />
            ))}
        </div>
    );
}

function CardGridTile({ card, chatCount }: { card: CardItem; chatCount: number }) {
    const { t } = useI18n();
    const s = useShell();
    const [imgErr, setImgErr] = useState(false);
    return (
        <div className="group relative aspect-[16/11] overflow-hidden rounded-[12px] text-left" style={{ border: '1px solid var(--border-hairline)' }}>
            {card.avatar && !imgErr ? (
                <img
                    src={charImageUrl(card.avatar)}
                    alt=""
                    className="absolute inset-0 h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.03]"
                    onError={() => setImgErr(true)}
                />
            ) : (
                <div className="absolute inset-0 flex items-center justify-center text-[34px]" style={{ background: 'var(--bg-active)', color: 'var(--brand)' }}>
                    {(card.name || card.charDir)[0]}
                </div>
            )}
            <div className="absolute inset-0" style={{ background: 'linear-gradient(180deg, transparent 35%, rgba(8,9,10,0.92) 100%)' }} />
            <button
                className="absolute right-2.5 top-2.5 h-7 rounded-lg px-2.5 text-[11px] font-medium backdrop-blur-md"
                style={{ background: 'rgba(15,16,17,0.72)', color: '#F7F8F8', border: '1px solid rgba(255,255,255,0.14)' }}
                onClick={() => openCharEditor(card.charDir)}
            >
                {t('studio.cards.detail')}
            </button>
            <button
                className="absolute bottom-3 left-3.5 right-3.5 text-left"
                onClick={() => {
                    const chat = s.chats.find((x) => x.charDir === card.charDir);
                    if (chat) s.selectChat(chat.id); else s.newChat(card.charDir);
                }}
            >
                <div className="truncate text-[13.5px] font-medium text-white">{card.name || card.charDir}</div>
                <div className="mt-0.5 truncate text-[11px] text-white/65">
                    {card.readable ? `${card.fileName} · ${chatCount} ${t('studio.cards.chats')}` : `${card.fileName} · ${t('studio.cards.unreadable')}`}
                </div>
            </button>
        </div>
    );
}

/* ------------------------------------------------------------------ */
/* 2. global —— 全局常驻 JSON 栈(端稿 L1863;读真/写 disabled)             */
/* ------------------------------------------------------------------ */

function GlobalPage() {
    const { t } = useI18n();
    const worlds = useRemote('worlds', listWorlds);
    const { slices, error: sErr, reload: sReload } = useSettingsSlices();
    const items = worlds.data?.items ?? [];
    const counts = useWorldCounts(items);
    const sel = new Set(slices.globalSelect);
    if (worlds.error) return <PanelError error={worlds.error} onRetry={worlds.reload} />;
    if (sErr) return <PanelError error={sErr} onRetry={sReload} />;
    if (worlds.data && !items.length) return <PanelEmpty icon="layers">{t('studio.global.empty')}</PanelEmpty>;
    return (
        <>
            <div className="inset-group">
                {items.map((w) => {
                    const on = sel.has(w.name) || sel.has(w.displayName);
                    const n = counts.data?.[w.name];
                    return (
                        <div key={w.name} className="inset-row">
                            <div className="min-w-0">
                                <div className="text-[13px] font-medium text-[color:var(--fg-primary)]">
                                    {w.displayName || w.name}
                                    <span className="ml-1.5 font-mono-ui text-[11px] text-[color:var(--fg-muted)]">
                                        {w.name}{n != null ? ` · ${n}${t('studio.world.entriesUnit')}` : ''}
                                    </span>
                                </div>
                                <div className="mt-0.5 text-[12px] text-[color:var(--fg-secondary)]">
                                    {on ? t('studio.global.inStack') : t('studio.global.notInStack')}
                                </div>
                            </div>
                            <Switch on={on} disabled title={t('studio.global.unwired')} />
                        </div>
                    );
                })}
            </div>
            <p className="px-1 text-[10.5px] leading-relaxed text-[color:var(--fg-faint)]">
                {t('studio.global.unwired')} · world_info_settings.world_info.globalSelect
            </p>
        </>
    );
}

/* ------------------------------------------------------------------ */
/* 3. worldbook —— 书文件选择器 + 反查绑定 + 命中徽标 + 条目启停(端稿 L1864) */
/* ------------------------------------------------------------------ */

function entryTitle(uid: string, e: WorldEntry): string {
    if (typeof e.comment === 'string' && e.comment.trim()) return e.comment;
    if (Array.isArray(e.key) && typeof e.key[0] === 'string' && e.key[0]) return e.key[0];
    return `#${uid}`;
}
const entryKind = (e: WorldEntry): string => (e.constant ? '常驻' : '关键词');

function WorldbookPage() {
    const { t } = useI18n();
    const s = useShell();
    const worlds = useRemote('worlds', listWorlds);
    const items = useMemo(() => worlds.data?.items ?? [], [worlds.data]);
    const cards = useMemo(() => [...s.cards.values()], [s.cards]);
    const bindings = useWorldBindings(cards);
    const counts = useWorldCounts(items);
    /* 默认书 = 当前会话卡的 extensions.world;取不到 → 列表首本。 */
    const bound = useRemote(s.chat?.charDir ?? null, async () => {
        const doc = await loadCardDoc(s.chat!.charDir);
        const w = cardData(doc).extensions?.world;
        return typeof w === 'string' && w ? w : null;
    });
    const [picked, setPicked] = useState<string | null>(null);
    const [ddOpen, setDdOpen] = useState(false);
    const curName = (picked && items.some((i) => i.name === picked) ? picked : null)
        ?? bound.data ?? items[0]?.name ?? null;
    const curMeta = items.find((i) => i.name === curName) ?? null;
    const docR = useRemote(curName ? `world:${curName}` : null, () => (curName ? loadWorldDoc(curName).then((doc) => ({ doc })) : Promise.reject(new Error('no world'))));
    const doc = docR.data?.doc ?? null;
    const entries = useMemo(() => Object.entries(doc?.entries ?? {}), [doc]);
    const [selUid, setSelUid] = useState<string | null>(null);
    const selId = selUid && doc?.entries?.[selUid] ? selUid : (entries[0]?.[0] ?? null);
    const selEntry = selId && doc ? doc.entries[selId]! : null;

    const hits = useWiHits(chatKey(s.chat));
    const hitMap = useMemo(() => {
        const m = new Map<string, number>();
        if (!hits.data || !curName) return m;
        const names = new Set([curName, curMeta?.displayName].filter(Boolean) as string[]);
        for (const e of hits.data.entries) {
            if (e.world && !names.has(String(e.world))) continue;
            const uid = e.uid == null ? null : String(e.uid);
            if (uid) m.set(uid, (m.get(uid) ?? 0) + e.hits);
        }
        return m;
    }, [hits.data, curName, curMeta]);
    const wiEvents = hits.data?.events ?? 0;

    const [toggling, setToggling] = useState<string | null>(null);
    const toggleEntry = (uid: string) => {
        if (!doc || !curName || toggling) return;
        const ent = doc.entries[uid];
        if (!ent) return;
        const next: WorldDoc = { ...doc, entries: { ...doc.entries, [uid]: { ...ent, disable: !ent.disable } } };
        setToggling(uid);
        saveWorld(curName, next)
            .then(() => { invalidateWorldDoc(curName); docR.reload(); })
            .catch((e) => s.hint(`${t('studio.world.toggleFailed')}: ${e instanceof Error ? e.message : String(e)}`, true))
            .finally(() => setToggling(null));
    };

    if (worlds.error) return <PanelError error={worlds.error} onRetry={worlds.reload} />;
    if (worlds.data && !items.length) return <PanelEmpty icon="bookOpen">{t('studio.world.empty')}</PanelEmpty>;

    const boundChips = curName ? (bindings.data?.[curName] ?? bindings.data?.[curMeta?.displayName ?? ''] ?? []) : [];
    const curCount = curName ? counts.data?.[curName] ?? entries.length : 0;

    return (
        <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
                {/* 书文件选择器(端稿 WORLDS_LIB 下拉 —— 选项带条目数+绑定注释) */}
                <div className="relative min-w-[260px] max-w-[420px] flex-1">
                    <button className="sh-select-trigger" onClick={() => setDdOpen(!ddOpen)}>
                        <span className="truncate font-medium">
                            {curMeta?.displayName || curName || '…'}
                            <span className="ml-1 font-mono-ui text-[11px] text-[color:var(--fg-muted)]">({curCount}{t('studio.world.entriesUnit')})</span>
                        </span>
                        <span className="shrink-0 text-[color:var(--fg-muted)]"><Icon name="chevronDown" size={13} /></span>
                    </button>
                    {ddOpen && (
                        <div className="sh-select-menu pop-in">
                            {items.map((w) => {
                                const n = counts.data?.[w.name];
                                const bound2 = bindings.data?.[w.name] ?? [];
                                return (
                                    <button
                                        key={w.name}
                                        className="inset-row-btn flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left"
                                        onClick={() => { setPicked(w.name); setSelUid(null); setDdOpen(false); }}
                                    >
                                        <div className="min-w-0">
                                            <div className="truncate text-[12.5px] font-medium text-[color:var(--fg-primary)]">{w.displayName || w.name}</div>
                                            <div className="truncate font-mono-ui text-[10.5px] text-[color:var(--fg-muted)]">
                                                {n == null ? '…' : `${n}${t('studio.world.entriesUnit')}`} · {bound2.length ? `${t('studio.world.boundPrefix')}${bound2.join(' / ')}` : t('studio.world.unbound')}
                                            </div>
                                        </div>
                                        {w.name === curName && <Icon name="check" size={14} className="shrink-0 text-[color:var(--brand)]" />}
                                    </button>
                                );
                            })}
                        </div>
                    )}
                </div>
                {/* 绑定反查 chips */}
                <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                    <span className="text-[color:var(--fg-muted)]">{t('studio.world.bound')}</span>
                    {boundChips.length ? boundChips.map((cn) => (
                        <span key={cn} className="rounded-md px-2 py-0.5 font-medium" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-hairline)', color: 'var(--fg-secondary)' }}>{cn}</span>
                    )) : (
                        <span className="text-[color:var(--fg-faint)]">{bindings.error ? '—' : t('studio.world.boundNone')}</span>
                    )}
                </div>
            </div>

            {docR.error && <PanelError error={docR.error} onRetry={docR.reload} />}
            {doc && (
                <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
                    {/* 左列:条目 + 命中徽标 + 启停 */}
                    <div className="inset-group h-fit lg:col-span-5">
                        {entries.map(([uid, e]) => {
                            const hitsN = hitMap.get(uid) ?? null;
                            const rate = hitsN && wiEvents ? Math.round((hitsN / wiEvents) * 100) : null;
                            const enabled = !e.disable;
                            return (
                                <div key={uid} className="inset-row" style={{ background: uid === selId ? 'var(--bg-active)' : 'transparent' }}>
                                    <button className="min-w-0 flex-1 text-left" onClick={() => setSelUid(uid)}>
                                        <div className="truncate text-[12.5px] font-medium text-[color:var(--fg-primary)]" style={{ opacity: enabled ? 1 : 0.45 }}>
                                            {entryTitle(uid, e)}
                                        </div>
                                        <div className="mt-0.5 flex items-center gap-2 font-mono-ui text-[10.5px]">
                                            <span className="text-[color:var(--fg-muted)]">{entryKind(e)} · P{e.order ?? 100}</span>
                                            {hitsN !== null && (
                                                <span style={{ color: hitsN === 0 ? 'var(--brand)' : 'var(--fg-secondary)' }}>
                                                    {hitsN === 0 ? t('studio.world.hitsZero') : `${hitsN}${t('studio.world.hitsUnit')}${rate !== null ? ` (${rate}%)` : ''}`}
                                                </span>
                                            )}
                                        </div>
                                    </button>
                                    <Switch on={enabled} onToggle={() => toggleEntry(uid)} disabled={toggling === uid} />
                                </div>
                            );
                        })}
                        {!entries.length && <PanelEmpty icon="bookOpen">{t('studio.world.emptyEntries')}</PanelEmpty>}
                    </div>
                    {/* 右列:条目 JSON 详情 */}
                    <div className="space-y-3 rounded-[12px] p-4 lg:col-span-7" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-hairline)' }}>
                        {selEntry ? (
                            <>
                                <div className="flex items-center justify-between gap-2">
                                    <div className="heading-tight truncate text-[13.5px] font-medium text-[color:var(--fg-primary)]">{entryTitle(selId!, selEntry)}</div>
                                    <span className="shrink-0 font-mono-ui text-[11px]" style={{ color: (hitMap.get(selId!) ?? 0) === 0 ? 'var(--brand)' : 'var(--fg-muted)' }}>
                                        {hitMap.has(selId!)
                                            ? `${t('studio.world.hitsPre')} ${hitMap.get(selId!)} ${t('studio.world.hitsUnit')}`
                                            : hits.data ? t('studio.world.hitsZero2') : '—'}
                                    </span>
                                </div>
                                <pre className="select-text overflow-x-auto rounded-lg p-3.5 font-mono-ui text-[12px] leading-relaxed" style={{ background: 'var(--bg-canvas)', color: 'var(--fg-secondary)' }}>
                                    {JSON.stringify(selEntry, null, 2)}
                                </pre>
                            </>
                        ) : (
                            <PanelEmpty icon="bookOpen">{t('studio.world.noSel')}</PanelEmpty>
                        )}
                    </div>
                </div>
            )}
            {hits.data?.empty && hitMap.size === 0 && (
                <p className="px-1 text-[10.5px] text-[color:var(--fg-faint)]">{t('studio.world.hitsEmpty')}</p>
            )}
        </div>
    );
}

/* ------------------------------------------------------------------ */
/* 4. presets —— 真列表 + 参数 + 调参写面(端稿 L1922)                      */
/* ------------------------------------------------------------------ */

const PRESET_API_ID = 'openai';
const pnum = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function presetModel(doc: PresetDocument | undefined): string | null {
    if (!doc) return null;
    const source = typeof doc.chat_completion_source === 'string' ? doc.chat_completion_source : null;
    if (source) {
        const m = doc[`${source}_model`];
        if (typeof m === 'string' && m) return m;
    }
    for (const [k, v] of Object.entries(doc)) {
        if (k.endsWith('_model') && typeof v === 'string' && v) return v;
    }
    return null;
}

interface PresetTune { temp: number | null; topP: number | null; ctxLen: number | null; maxReply: number | null }
const tuneOf = (doc: PresetDocument | undefined): PresetTune => ({
    temp: pnum(doc?.temperature),
    topP: pnum(doc?.top_p),
    ctxLen: pnum(doc?.openai_max_context),
    maxReply: pnum(doc?.openai_max_tokens),
});
const TUNE_KEY: Record<keyof PresetTune, string> = {
    temp: 'temperature', topP: 'top_p', ctxLen: 'openai_max_context', maxReply: 'openai_max_tokens',
};

function PresetsPage() {
    const { t } = useI18n();
    const s = useShell();
    const list = useRemote(PRESET_API_ID, () => listPresets(PRESET_API_ID));
    const { slices } = useSettingsSlices();
    const names = list.data?.items.map((x) => x.name) ?? [];
    /* 每预设档取真 doc(缓存)—— 列表只给 name,参数在 doc 里。 */
    const docs = useRemote(names.join('|') ? `preset-docs:${PRESET_API_ID}:${names.length}:${names.join('|').length}` : null, async () => {
        const out: Record<string, PresetDocument | null> = {};
        await Promise.all(names.map(async (n) => {
            try { out[n] = await loadPresetDoc(n, PRESET_API_ID); } catch { out[n] = null; }
        }));
        return out;
    });
    const [tuneOpen, setTuneOpen] = useState<string | null>(null);
    const [tuneDrafts, setTuneDrafts] = useState<Record<string, PresetTune>>({});
    const saveTimer = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
    const [saving, setSaving] = useState<Record<string, boolean>>({});

    const setTune = (name: string, k: keyof PresetTune, v: number) => {
        const base = tuneDrafts[name] ?? tuneOf(docs.data?.[name] ?? undefined);
        const draft = { ...base, [k]: v };
        setTuneDrafts((p) => ({ ...p, [name]: draft }));
        const doc = docs.data?.[name];
        if (!doc) return;
        clearTimeout(saveTimer.current[name]);
        saveTimer.current[name] = setTimeout(() => {
            const next = { ...doc, [TUNE_KEY[k]]: v } as PresetDocument;
            setSaving((p) => ({ ...p, [name]: true }));
            savePreset(name, next, PRESET_API_ID)
                .then(() => { presetDocCache.delete(`${PRESET_API_ID}/${name}`); docs.reload(); })
                .catch((e) => s.hint(`${t('studio.presets.saveFailed')}: ${e instanceof Error ? e.message : String(e)}`, true))
                .finally(() => setSaving((p) => ({ ...p, [name]: false })));
        }, 600);
    };

    if (list.error) return <PanelError error={list.error} onRetry={list.reload} />;
    if (list.data && !names.length) return <PanelEmpty icon="sliders">{t('studio.presets.empty')} · {PRESET_API_ID}</PanelEmpty>;

    return (
        <div className="inset-group">
            {names.map((n) => {
                const doc = docs.data?.[n] ?? undefined;
                const tune = tuneDrafts[n] ?? tuneOf(doc);
                const active = slices.activePreset === n || slices.activePreset === n.replace(/\.json$/i, '');
                const open = tuneOpen === n;
                return (
                    <div key={n} className="inset-row flex-col !items-stretch">
                        <div className="flex items-center justify-between gap-3">
                            <div className="min-w-0">
                                <div className="truncate font-mono-ui text-[13px] font-medium text-[color:var(--fg-primary)]">{n}</div>
                                <div className="mt-0.5 truncate font-mono-ui text-[11.5px] text-[color:var(--fg-muted)]">
                                    {doc === null && docs.data ? t('studio.presets.unreadable')
                                        : `T ${tune.temp ?? '—'} · TopP ${tune.topP ?? '—'} · ${tune.maxReply ?? '—'} tok${presetModel(doc) ? ` · ${presetModel(doc)}` : ''}`}
                                </div>
                            </div>
                            <div className="flex shrink-0 items-center gap-2">
                                {saving[n] && <span className="font-mono-ui text-[10px] text-[color:var(--fg-faint)]">{t('panel.notes.saving')}</span>}
                                <button
                                    className="ghost-btn h-7 rounded-md px-2 text-[11px]"
                                    disabled={!doc}
                                    onClick={() => setTuneOpen(open ? null : n)}
                                    title={t('studio.presets.tune')}
                                >
                                    <Icon name="sliders" size={12} />
                                </button>
                                {active ? (
                                    <span className="rounded-lg px-3 py-1 text-[12px] font-medium" style={{ background: 'var(--bg-active)', color: 'var(--fg-muted)' }}>{t('studio.presets.active')}</span>
                                ) : (
                                    <button
                                        className="rounded-lg px-3 py-1 text-[12px] font-medium"
                                        style={{ background: 'var(--primary-bg)', color: 'var(--primary-fg)', opacity: 0.5, cursor: 'not-allowed' }}
                                        disabled
                                        title={t('studio.presets.defaultUnwired')}
                                    >
                                        {t('studio.presets.setDefault')}
                                    </button>
                                )}
                            </div>
                        </div>
                        {open && doc && (
                            <div className="mt-2 space-y-2.5 border-t border-[color:var(--border-hairline)] pt-3">
                                {([
                                    ['temp', t('param.temp'), 0, 2, 0.05],
                                    ['topP', t('param.topP'), 0, 1, 0.01],
                                    ['ctxLen', t('param.ctxLen'), 1024, 200000, 1024],
                                    ['maxReply', t('param.maxReply'), 128, 8192, 64],
                                ] as [keyof PresetTune, string, number, number, number][]).map(([k, label, min, max, step]) => (
                                    <div key={k} className="flex items-center justify-between gap-3 text-[12.5px]">
                                        <span className="text-[color:var(--fg-secondary)]">{label}</span>
                                        <div className="flex items-center gap-2">
                                            <input
                                                type="range" min={min} max={max} step={step}
                                                value={tune[k] ?? min}
                                                disabled={tune[k] === null}
                                                className="w-[160px]"
                                                onChange={(e) => setTune(n, k, Number(e.target.value))}
                                            />
                                            <span className="w-14 text-right font-mono-ui text-[10.5px] text-[color:var(--fg-primary)]">{tune[k] ?? '—'}</span>
                                        </div>
                                    </div>
                                ))}
                                <p className="text-[10px] text-[color:var(--fg-faint)]">{t('studio.presets.tuneNote')}</p>
                            </div>
                        )}
                    </div>
                );
            })}
        </div>
    );
}

/* ------------------------------------------------------------------ */
/* 5. persona —— 全真 CRUD(端稿 L1923)                                  */
/* ------------------------------------------------------------------ */

const personaAvatarUrl = (avatar: string) => `/User%20Avatars/${encodeURIComponent(avatar)}`;

function PersonaPage() {
    const { t } = useI18n();
    const s = useShell();
    const list = useRemote('personas', listPersonas);
    const items = list.data?.items ?? [];
    const [editing, setEditing] = useState<string | null>(null);
    const [draft, setDraft] = useState<{ name: string; description: string }>({ name: '', description: '' });
    const [busy, setBusy] = useState(false);

    const act = (fn: () => Promise<unknown>) => {
        if (busy) return;
        setBusy(true);
        void fn()
            .then(() => list.reload())
            .catch((e) => s.hint(`${t('studio.persona.failed')}: ${e instanceof Error ? e.message : String(e)}`, true))
            .finally(() => setBusy(false));
    };

    if (list.error) return <PanelError error={list.error} onRetry={list.reload} />;
    return (
        <>
            <div className="inset-group">
                {items.map((p) => (
                    <PersonaRow
                        key={p.avatar} p={p} busy={busy}
                        editing={editing === p.avatar}
                        draft={draft}
                        onEdit={() => { setEditing(p.avatar); setDraft({ name: p.name, description: p.description }); }}
                        onCancel={() => setEditing(null)}
                        onChange={setDraft}
                        onSave={() => act(() => savePersona(p.avatar, { name: draft.name, description: draft.description }).then(() => setEditing(null)))}
                        onDefault={() => act(() => savePersona(p.avatar, { is_default: true }))}
                        onDelete={() => {
                            if (!window.confirm(`${t('studio.persona.delConfirm')}\n${p.name || p.avatar}`)) return;
                            act(() => deletePersona(p.avatar));
                        }}
                    />
                ))}
                {list.data && !items.length && <PanelEmpty icon="persona">{t('studio.persona.empty')}</PanelEmpty>}
            </div>
            <button
                className="inset-row-btn flex w-full items-center justify-center gap-2 rounded-[10px] py-2.5 text-[12.5px] font-medium"
                style={{ background: 'var(--bg-surface)', border: '1px dashed var(--border-strong)', color: 'var(--fg-secondary)' }}
                disabled={busy}
                onClick={() => {
                    const avatar = `user-${Date.now()}.png`;
                    act(() => savePersona(avatar, { name: t('studio.persona.newName'), description: '' }));
                }}
            >
                <Icon name="plus" size={13} /> {t('studio.persona.new')}
            </button>
        </>
    );
}

function PersonaRow({ p, busy, editing, draft, onEdit, onCancel, onChange, onSave, onDefault, onDelete }: {
    p: PersonaItem; busy: boolean; editing: boolean;
    draft: { name: string; description: string };
    onEdit: () => void; onCancel: () => void;
    onChange: (d: { name: string; description: string }) => void;
    onSave: () => void; onDefault: () => void; onDelete: () => void;
}) {
    const { t } = useI18n();
    const [imgErr, setImgErr] = useState(false);
    return (
        <div className="inset-row flex-col !items-stretch">
            <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-3.5">
                    {p.hasImage && !imgErr ? (
                        <img src={personaAvatarUrl(p.avatar)} alt="" className="h-10 w-10 rounded-full object-cover" style={{ border: '2px solid var(--border-bold)' }} onError={() => setImgErr(true)} />
                    ) : (
                        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-semibold" style={{ background: 'var(--bg-active)', color: 'var(--fg-primary)', border: '1px solid var(--border-strong)' }}>
                            {(p.name || p.avatar)[0]?.toUpperCase()}
                        </span>
                    )}
                    <div className="min-w-0">
                        <div className="text-[13.5px] font-semibold text-[color:var(--fg-primary)]">
                            {p.name || p.avatar}
                            {p.isDefault && <span className="ml-1 text-[11px] font-normal text-[color:var(--fg-muted)]">{t('studio.persona.default')}</span>}
                        </div>
                        <div className="mt-0.5 truncate text-[12px] text-[color:var(--fg-secondary)]">{p.description || <span className="text-[color:var(--fg-faint)]">{t('studio.persona.noDesc')}</span>}</div>
                    </div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                    {!p.isDefault && (
                        <button className="ghost-btn h-7 rounded-md px-2 text-[11px]" disabled={busy} onClick={onDefault}>{t('studio.persona.setDefault')}</button>
                    )}
                    <button className="ghost-btn h-7 w-7" disabled={busy} onClick={onEdit} title={t('studio.persona.edit')}><Icon name="pencil" size={13} /></button>
                    <button className="ghost-btn h-7 w-7" disabled={busy} onClick={onDelete} title={t('studio.persona.delete')} style={{ color: 'var(--status-danger)' }}><Icon name="trash" size={13} /></button>
                </div>
            </div>
            {editing && (
                <div className="mt-2.5 space-y-2 border-t border-[color:var(--border-hairline)] pt-3">
                    <input
                        value={draft.name}
                        onChange={(e) => onChange({ ...draft, name: e.target.value })}
                        placeholder={t('studio.persona.namePh')}
                        className="h-8 w-full rounded-lg px-2.5 text-xs outline-none"
                        style={{ background: 'var(--bg-canvas)', color: 'var(--fg-primary)', border: '1px solid var(--border-hairline)' }}
                    />
                    <textarea
                        value={draft.description}
                        onChange={(e) => onChange({ ...draft, description: e.target.value })}
                        placeholder={t('studio.persona.descPh')}
                        rows={3}
                        className="w-full resize-none rounded-lg p-2.5 text-xs leading-relaxed outline-none"
                        style={{ background: 'var(--bg-canvas)', color: 'var(--fg-primary)', border: '1px solid var(--border-hairline)' }}
                    />
                    <div className="flex justify-end gap-2">
                        <button className="ghost-btn h-7 rounded-md px-2.5 text-[11.5px]" onClick={onCancel}>{t('studio.persona.cancel')}</button>
                        <button className="h-7 rounded-lg px-3 text-[11.5px] font-medium" style={{ background: 'var(--primary-bg)', color: 'var(--primary-fg)' }} disabled={busy || !draft.name.trim()} onClick={onSave}>
                            {t('studio.persona.save')}
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}

/* ------------------------------------------------------------------ */
/* 6. regex —— C7 排期:卡内 regex_scripts 真读只列名,无启停面             */
/* ------------------------------------------------------------------ */

interface RegexRow { name: string; scope: string; disabled: boolean }

function RegexPage() {
    const { t } = useI18n();
    const s = useShell();
    const cards = useMemo(() => [...s.cards.values()], [s.cards]);
    /* 卡 extensions.regex_scripts 真读 —— 条目名是真的,启停写面 C7 未备。 */
    const rows = useRemote(cards.length ? `regex-rows:${cards.map((c) => c.charDir).join('|').length}:${cards.length}` : null, async () => {
        const out: RegexRow[] = [];
        await Promise.all(cards.map(async (c) => {
            try {
                const doc = await loadCardDoc(c.charDir);
                const scripts = (cardData(doc).extensions as { regex_scripts?: unknown } | undefined)?.regex_scripts;
                if (Array.isArray(scripts)) {
                    for (const sc of scripts) {
                        const o = sc as { scriptName?: unknown; disabled?: unknown };
                        out.push({
                            name: typeof o.scriptName === 'string' && o.scriptName ? o.scriptName : t('studio.regex.unnamed'),
                            scope: c.name || c.charDir,
                            disabled: o.disabled === true,
                        });
                    }
                }
            } catch { /* 读不出的卡跳过 */ }
        }));
        return out;
    });
    return (
        <>
            <div className="flex items-center gap-2 px-0.5">
                <WiredBadge warn>{t('studio.regex.badge')}</WiredBadge>
                <span className="text-[10.5px] text-[color:var(--fg-faint)]">{t('studio.regex.note')}</span>
            </div>
            <div className="inset-group">
                {(rows.data ?? []).map((r, i) => (
                    <div key={i} className="inset-row">
                        <div className="min-w-0">
                            <div className="truncate text-[13px] font-medium text-[color:var(--fg-primary)]">{r.name}</div>
                            <div className="mt-0.5 truncate text-[11.5px] text-[color:var(--fg-muted)]">{t('studio.regex.scope')} · {r.scope}</div>
                        </div>
                        <span className="shrink-0 font-mono-ui text-[11px]" style={{ color: r.disabled ? 'var(--fg-muted)' : 'var(--status-ok)' }}>
                            {r.disabled ? 'Off' : 'Active'}
                        </span>
                    </div>
                ))}
                {(rows.data ? !rows.data.length : !cards.length) && (
                    <PanelEmpty icon="code">{t('studio.regex.empty')}</PanelEmpty>
                )}
                {!rows.data && !rows.error && cards.length > 0 && <PanelEmpty icon="code">…</PanelEmpty>}
                {rows.error && (
                    <PanelEmpty icon="code">{t('studio.regex.loadFailed')} · {rows.error}</PanelEmpty>
                )}
            </div>
        </>
    );
}

/* ------------------------------------------------------------------ */
/* StudioView 派发 + MobileHubView(端稿 renderMobileHubPage)              */
/* ------------------------------------------------------------------ */

export function StudioView() {
    const s = useShell();
    const nav = normStudioNav(s.studioNav);
    const body =
        nav === 'cards' ? <CardsPage /> :
        nav === 'global' ? <GlobalPage /> :
        nav === 'worldbook' ? <WorldbookPage /> :
        nav === 'presets' ? <PresetsPage /> :
        nav === 'persona' ? <PersonaPage /> :
        <RegexPage />;
    return <StudioShell nav={nav}>{body}</StudioShell>;
}

/** 移动端资产工坊(端稿 renderMobileHubPage):
 *  hero 卡库钮 + 世界书/全局栈 bento 双格 + 预设/人设/正则 inset 列 + 导入条。 */
export function MobileHubView() {
    const { t } = useI18n();
    const s = useShell();
    const cards = useMemo(() => [...s.cards.values()], [s.cards]);
    const worlds = useRemote('worlds', listWorlds);
    const items = worlds.data?.items ?? [];
    const counts = useWorldCounts(items);
    const presets = useRemote(PRESET_API_ID, () => listPresets(PRESET_API_ID));
    const personas = useRemote('personas', listPersonas);
    const { slices } = useSettingsSlices();
    const goStudio = (nav: StudioNav) => { s.setStudioNav(nav); s.setView('studio'); };
    const glActive = slices.globalSelect.length;
    const glTotal = items.length;
    const entrySum = counts.data ? Object.values(counts.data).reduce((a: number, b) => a + (b ?? 0), 0) : null;
    const presetShort = (slices.activePreset ?? '').replace(/\.json$/i, '') || '—';
    const defaultPersona = personas.data?.items.find((p) => p.isDefault)?.name ?? personas.data?.defaultPersona ?? '—';
    const [imgErrs, setImgErrs] = useState<Record<string, boolean>>({});

    return (
        <section className="flex h-full min-w-0 flex-1 flex-col" style={{ background: 'var(--bg-canvas)' }}>
            <header className="flex h-12 shrink-0 items-center justify-between border-b border-[color:var(--border-hairline)] px-4">
                <div className="flex items-center gap-2.5">
                    <button className="ghost-btn h-8 w-8" onClick={() => s.setMobileDrawer(true)}><Icon name="menu" size={20} /></button>
                    <span className="heading-tight text-[14.5px] font-medium text-[color:var(--fg-primary)]">{t('mob.hub.assetHub')}</span>
                </div>
                <button
                    className="rounded-lg px-2.5 py-1 text-[12px] transition-colors"
                    style={{ background: 'var(--bg-surface)', color: 'var(--fg-secondary)', border: '1px solid var(--border-hairline)' }}
                    onClick={() => s.setView('chat')}
                >
                    {t('mob.hub.back')}
                </button>
            </header>

            <div className="min-h-0 flex-1 space-y-3.5 overflow-y-auto p-4">
                {/* 1. hero:角色卡库(2px bold + 叠卡头像) */}
                <button
                    className="flex w-full items-center justify-between gap-3 rounded-[12px] p-4 text-left transition-transform active:scale-[0.99]"
                    style={{ background: 'var(--bg-surface)', border: '2px solid var(--border-bold)', boxShadow: 'var(--shadow-card)' }}
                    onClick={() => goStudio('cards')}
                >
                    <div className="flex min-w-0 items-center gap-3">
                        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px]" style={{ background: 'var(--bg-active)', color: 'var(--fg-primary)' }}>
                            <Icon name="home" size={20} weight="duotone" />
                        </span>
                        <div className="min-w-0">
                            <div className="heading-tight text-[14.5px] font-medium text-[color:var(--fg-primary)]">{t('mob.hub.cards')}</div>
                            <div className="mt-0.5 font-mono-ui text-[11.5px] text-[color:var(--fg-muted)]">{cards.length} {t('mob.hub.cardsN')}</div>
                        </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                        <div className="-space-x-2 flex items-center">
                            {cards.slice(0, 3).map((c) => (
                                <div key={c.charDir} className="h-7 w-7 overflow-hidden rounded-full border-2" style={{ borderColor: 'var(--bg-surface)', background: 'var(--bg-active)' }}>
                                    {c.avatar && !imgErrs[c.charDir] ? (
                                        <img src={charImageUrl(c.avatar)} alt="" className="h-full w-full object-cover" onError={() => setImgErrs((m) => ({ ...m, [c.charDir]: true }))} />
                                    ) : (
                                        <span className="flex h-full w-full items-center justify-center text-[9px] text-[color:var(--fg-secondary)]">{(c.name || c.charDir)[0]}</span>
                                    )}
                                </div>
                            ))}
                        </div>
                        <span className="text-[color:var(--fg-muted)]"><Icon name="arrowRight" size={15} /></span>
                    </div>
                </button>

                {/* 2. bento:世界书条目 + 全局常驻栈 */}
                <div className="grid grid-cols-2 gap-2.5">
                    <button
                        className="flex flex-col justify-between gap-5 rounded-[12px] p-4 text-left transition-transform active:scale-[0.99]"
                        style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-hairline)', boxShadow: 'var(--shadow-card)' }}
                        onClick={() => goStudio('worldbook')}
                    >
                        <div className="flex items-center justify-between">
                            <span className="text-[color:var(--fg-primary)]"><Icon name="bookOpen" size={20} /></span>
                            <span className="text-[color:var(--fg-faint)]"><Icon name="arrowRight" size={14} /></span>
                        </div>
                        <div>
                            <div className="heading-tight font-mono-ui text-[22px] font-medium leading-none text-[color:var(--fg-primary)]">{entrySum ?? '…'}</div>
                            <div className="mt-1.5 text-[12.5px] text-[color:var(--fg-secondary)]">{t('mob.hub.worldbook')}{items.length ? ` · ${items.length}` : ''}</div>
                        </div>
                    </button>
                    <button
                        className="flex flex-col justify-between gap-5 rounded-[12px] p-4 text-left transition-transform active:scale-[0.99]"
                        style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-hairline)', boxShadow: 'var(--shadow-card)' }}
                        onClick={() => goStudio('global')}
                    >
                        <div className="flex items-center justify-between">
                            <span className="text-[color:var(--fg-primary)]"><Icon name="layers" size={20} /></span>
                            <span className="text-[color:var(--fg-faint)]"><Icon name="arrowRight" size={14} /></span>
                        </div>
                        <div>
                            <div className="heading-tight font-mono-ui text-[22px] font-medium leading-none">
                                <span style={{ color: 'var(--brand)' }}>{glActive}</span>
                                <span className="text-[14px] text-[color:var(--fg-muted)]"> / {glTotal}</span>
                            </div>
                            <div className="mt-1.5 text-[12.5px] text-[color:var(--fg-secondary)]">{t('mob.hub.global')}</div>
                        </div>
                    </button>
                </div>

                {/* 3. inset 列:预设 / 人设 / 正则 */}
                <div className="inset-group">
                    <button className="inset-row inset-row-btn py-3" onClick={() => goStudio('presets')}>
                        <div className="flex min-w-0 items-center gap-3">
                            <span className="text-[color:var(--fg-primary)]"><Icon name="sliders" size={18} /></span>
                            <span className="truncate text-[13.5px] font-medium text-[color:var(--fg-primary)]">{t('studio.nav.presets')}</span>
                        </div>
                        <div className="flex shrink-0 items-center gap-1.5">
                            <span className="font-mono-ui text-[11.5px] text-[color:var(--fg-muted)]">
                                {presetShort}{presets.data ? ` · ${presets.data.total}` : ''}
                            </span>
                            <span className="text-[color:var(--fg-faint)]"><Icon name="arrowRight" size={14} /></span>
                        </div>
                    </button>
                    <button className="inset-row inset-row-btn py-3" onClick={() => goStudio('persona')}>
                        <div className="flex min-w-0 items-center gap-3">
                            <span className="text-[color:var(--fg-primary)]"><Icon name="persona" size={18} /></span>
                            <span className="truncate text-[13.5px] font-medium text-[color:var(--fg-primary)]">{t('studio.nav.persona')}</span>
                        </div>
                        <div className="flex shrink-0 items-center gap-1.5">
                            <span className="font-mono-ui text-[11.5px] text-[color:var(--fg-muted)]">
                                {defaultPersona}{personas.data ? ` · ${personas.data.total}` : ''}
                            </span>
                            <span className="text-[color:var(--fg-faint)]"><Icon name="arrowRight" size={14} /></span>
                        </div>
                    </button>
                    <button className="inset-row inset-row-btn py-3" onClick={() => goStudio('regex')}>
                        <div className="flex min-w-0 items-center gap-3">
                            <span className="text-[color:var(--fg-primary)]"><Icon name="code" size={18} /></span>
                            <span className="truncate text-[13.5px] font-medium text-[color:var(--fg-primary)]">{t('studio.nav.regex')}</span>
                        </div>
                        <div className="flex shrink-0 items-center gap-1.5">
                            <WiredBadge warn>C7</WiredBadge>
                            <span className="text-[color:var(--fg-faint)]"><Icon name="arrowRight" size={14} /></span>
                        </div>
                    </button>
                </div>

                {/* 4. 导入条 */}
                <button
                    className="flex h-11 w-full items-center justify-center gap-2 rounded-[10px] px-4 text-[13px] font-medium transition-transform active:scale-[0.99]"
                    style={{ background: 'var(--bg-surface)', border: '1px dashed var(--border-strong)', color: 'var(--fg-secondary)' }}
                    onClick={openImportModal}
                >
                    <Icon name="import" size={17} />
                    <span>{t('mob.hub.import')}</span>
                </button>
            </div>
        </section>
    );
}
