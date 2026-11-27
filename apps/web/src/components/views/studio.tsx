// 规范稿 studio 六页(端稿 renderStudioMain)+ 移动端资产工坊(renderMobileHubPage)。
// 六类对齐端稿 studio nav:cards/global/worldbook/presets/persona/regex ——
// 旧实现 lore/chars/prompts/regex/files 词表作废(spec-v2-check D5 裁定稿侧为准);
// TASK-063 增补第七类 quickreplies(ST QR 管理面,稿外资产域补位)。
//
// 诚实面约定(wired 映射):
//   worldbook 书目/书新建删/条目全字段编辑+增删复制 = GET/PUT/DELETE /worlds 全真;
//   会话绑定书 = th.getChatLorebook/setChatLorebook(chat_metadata.world_info);命中率徽标 = stats/inject。
//   global    全局栈读写全真(PATCH /settings → world_info_settings.world_info.globalSelect,保留 charLore)。
//   presets   列表/参数/调参写 + 「设为默认」(preset_settings_openai)全真。
//   persona   GET/PUT/DELETE 全真 + Utopinn 内置动物头像库(user-redpanda/fox/owl)。
//   regex     GET/PUT/PATCH/DELETE /api/utopinn/regex 全真;本页只列 global/char
//             两域 —— preset 脚本本体在预设档内,归宿预设编辑器(PresetRegexSection)。
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, ReactNode } from 'react';
import { useShell } from '../../kernel/context';
import { useI18n } from '../../i18n';
import { Icon, type IconName } from '../Icon';
import { PanelEmpty, PanelError, chatKey, thCallTarget, useRemote } from '../panels/panelShared';
import { cardData, loadCharDoc, charImageUrl, type CardItem } from '../../api/characters';
import { listWorlds, getWorld, saveWorld, deleteWorld, wbStudioFocus, type WorldDoc, type WorldListItem, type WorldEntry } from '../../api/worlds';
import { thCall } from '../../api/th';
import {
    applyDraft, draftDirty, draftOf, newEntry, nextUid,
    LOGIC_OPTIONS, POSITION_OPTIONS, ROLE_OPTIONS,
    type EntryDraft,
} from './worldbookDraft';
import { getSettings, patchSettings } from '../../api/settings';
import { listPresets, savePreset, deletePreset, type PresetDocument } from '../../api/presets';
import {
    flushQrChatCfg, flushQrSettings, mutateQrChatCfg, mutateQrSettings,
    presetDocs, presetKey, usePresetDoc, useQrChatCfg, useQrSettings,
} from '../../kernel/docStores';
import { PresetDocEditor } from '../panels/presetEditor';
import {
    BUILTIN_COVERS, BUILTIN_PERSONA_AVATARS, builtinPickSrc, coverPersonaKey,
    deletePersona, listPersonas, mintPersonaAvatarKey,
    personaAvatarSrc, resolveBuiltinPersonaPick, savePersona,
    type PersonaAvatarPick, type PersonaItem,
} from '../../api/personas';
import {
    deleteRegexScript, getRegexFullView, mutateRegexScope, patchRegexScript,
    type RegexScopeTarget, type RegexScriptData,
} from '../../api/regex';
import { statsInject } from '../../api/stats';
import { openImportModal } from '../shell/overlayBus';
import { downloadExport, exportPresetUrl, exportWorldUrl } from '../../api/export';
import { uploadPersonaImage } from '../../api/personas';
import {
    deleteQrSet, getQrSet, listQrSets,
    newQrSetDoc, qrBound, qrCharScopeKey,
    qrConfigWithLink, qrStudioFocus, saveQrSet,
    type QrConfig, type QrEntry, type QrSetDoc, type QrSetLink, type QrSettings,
} from '../../api/quickreplies';

/* ------------------------------------------------------------------ */
/* studio nav 词表(端稿 L958-966 六类)                                  */
/* ------------------------------------------------------------------ */

/* 角色卡库栏目已撤 —— 卡面管理归门厅/卡选择弹窗,工坊只留资产域。 */
export const STUDIO_NAVS = ['global', 'worldbook', 'presets', 'persona', 'regex', 'quickreplies'] as const;
export type StudioNav = (typeof STUDIO_NAVS)[number];
export const STUDIO_NAV_META: { id: StudioNav; icon: IconName }[] = [
    { id: 'global', icon: 'layers' },
    { id: 'worldbook', icon: 'bookOpen' },
    { id: 'presets', icon: 'sliders' },
    { id: 'persona', icon: 'persona' },
    { id: 'regex', icon: 'code' },
    { id: 'quickreplies', icon: 'zap' },
];
/** 旧词表(lore/chars/prompts/files/cards)与非枚举值一律落 'global'。 */
export function normStudioNav(v: string): StudioNav {
    return (STUDIO_NAVS as readonly string[]).includes(v) ? (v as StudioNav) : 'global';
}

/* ------------------------------------------------------------------ */
/* 离开守卫注册位                                                        */
/* ------------------------------------------------------------------ */

/** studio 页级离开守卫:持草稿的页挂载时挂 check(返回 true=放行,
 *  false=拦下);壳层导航(移动返回键等)先问再走。未挂时行为与旧一致。
 *  通用注册位 —— 任何 studio 页有未存草稿都可挂,不只服务世界书。 */
const studioLeaveGuard: { check: (() => boolean) | null } = { check: null };

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

/** 诚实徽标(协议未备/只读/排期)—— mono 小章,只标真实状态,不遮假数据。 */
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

/* 卡文档缓存已收编进 api/characters.ts(loadCharDoc)—— 舞台头资产 chip /
   角色页共享同一真值源,patchCharacter 自动失效,本文件不再私持。 */

/* Preset docs are owned by the shared presetDocs store (kernel/docStores)
   — no per-page cache: every edit surface reads/writes the same entry and
   the store's fresh-base flush replaces the old ovRef/saveTimer lane. */

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

/** 卡 → 书反查:extensions.world 主绑 + settings charLore 辅书两层。
 *  bound    —— 任何绑定(主绑+辅书)都记;
 *  embedded —— 书是该卡内嵌 character_book 的物化(有内嵌条目且绑定指向),
 *              列表面把它标成「内嵌自 <卡>」,免得书名长得像卡混进了书库。 */
function useWorldBindings(cards: CardItem[]) {
    const key = cards.map((c) => c.charDir).join('|');
    return useRemote(key ? `world-bind:${cards.length}:${key.length}` : null, async () => {
        const bound: Record<string, string[]> = {};
        const embedded: Record<string, string[]> = {};
        const push = (map: Record<string, string[]>, world: string, label: string) => {
            (map[world] ??= []).includes(label) || map[world]!.push(label);
        };
        await Promise.all(cards.map(async (c) => {
            try {
                const doc = await loadCharDoc(c.charDir);
                const data = cardData(doc);
                const world = data.extensions?.world;
                if (typeof world === 'string' && world) {
                    const label = c.name || c.charDir;
                    push(bound, world, label);
                    const book = data.character_book as { entries?: unknown } | null | undefined;
                    const entries = book?.entries;
                    const n = Array.isArray(entries) ? entries.length : (entries && typeof entries === 'object' ? Object.keys(entries).length : 0);
                    if (n > 0) push(embedded, world, label);
                }
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
                        for (const b of l.extraBooks) if (typeof b === 'string' && b) push(bound, b, label);
                    }
                }
            }
        } catch { /* settings 取不到 → 只用卡面绑定层 */ }
        return { bound, embedded };
    });
}

interface SettingsSlices {
    /** 全局勾选书目(settings.world_info_settings.world_info.globalSelect)。 */
    globalSelect: string[];
    /** 当前启用预设名(preset_settings_openai;oai_settings 内嵌形兼容)。 */
    activePreset: string | null;
    /** 生效连接名 —— 档案制:命中 profile 名;未迁移库 → 旧 source 值。 */
    connSource: string | null;
    /** 生效端点 —— 命中 profile.baseUrl;未迁移库 → legacy 槽。 */
    connBaseUrl: string | null;
    raw: Record<string, unknown> | null;
}

function sliceSettings(settings: Record<string, unknown> | null | undefined): SettingsSlices {
    const s = settings ?? {};
    const wi = (s.world_info_settings as Record<string, unknown> | undefined)?.world_info as
        Record<string, unknown> | undefined;
    const oai = s.oai_settings as Record<string, unknown> | undefined;
    const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : null);
    /* 档案制读面:activeModel.profileId → profile;未迁移 → legacy 单槽兜底。 */
    const profs = (Array.isArray(oai?.connection_profiles) ? oai!.connection_profiles : [])
        .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object' && !Array.isArray(p));
    const am = ((oai?.connection as Record<string, unknown> | undefined)?.activeModel ?? null) as Record<string, unknown> | null;
    const activeProf = (am && profs.find((p) => str(p.id) === str(am.profileId) && !p.disabled))
        ?? profs.find((p) => !p.disabled) ?? null;
    return {
        globalSelect: Array.isArray(wi?.globalSelect) ? wi!.globalSelect.filter((x): x is string => typeof x === 'string') : [],
        activePreset: str(s.preset_settings_openai) ?? str(oai?.preset_settings_openai),
        connSource: activeProf ? str(activeProf.name) : str(oai?.chat_completion_source),
        connBaseUrl: activeProf ? str(activeProf.baseUrl) : (str(oai?.reverse_proxy) ?? str(oai?.custom_url)),
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
 *  presets/persona=总数;regex=两域脚本总数(global+char,与页口径一致)。 */
export function useStudioCounts(): Record<StudioNav, string> {
    const worlds = useRemote('studio-cnt:worlds', listWorlds);
    const presets = useRemote('studio-cnt:presets', () => listPresets('openai'));
    const personas = useRemote('studio-cnt:personas', listPersonas);
    const regex = useRemote('studio-cnt:regex', getRegexFullView);
    const qr = useRemote('studio-cnt:qr', listQrSets);
    const { slices } = useSettingsSlices();
    const items = worlds.data?.items ?? [];
    const counts = useWorldCounts(items);
    const entrySum = counts.data ? Object.values(counts.data).reduce((a: number, b) => a + (b ?? 0), 0) : null;
    const regexTotal = regex.data
        ? regex.data.global.length
            + regex.data.chars.reduce((acc, c) => acc + c.scripts.length, 0)
        : null;
    return {
        global: `${slices.globalSelect.length}/${items.length}`,
        worldbook: entrySum !== null ? String(entrySum) : (worlds.data ? String(items.length) : '…'),
        presets: presets.data ? String(presets.data.total) : '…',
        persona: personas.data ? String(personas.data.total) : '…',
        regex: regexTotal !== null ? String(regexTotal) : '…',
        quickreplies: qr.data ? String(qr.data.length) : '…',
    };
}

/* ------------------------------------------------------------------ */
/* 页壳(端稿 renderStudioMain 外框:移动 header + 桌面标题行 + 导入钮)     */
/* ------------------------------------------------------------------ */

/** fill:页面要求「满高内滚」时用(世界书编辑器双栏)——内层转 flex 列、
 *  页头定高、children 界高(flex-1+min-h-0),lg 起整页不再滚,滚动归
 *  栏内;非 fill 页保持整页滚原样。移动端一律整页滚。 */
function StudioShell({ nav, fill, children }: { nav: StudioNav; fill?: boolean; children: ReactNode }) {
    const { t } = useI18n();
    const s = useShell();
    const importBtn = (
        <button
            className="shrink-0 rounded-lg font-medium h-8 px-3.5 text-[12px] mob:h-7 mob:px-2.5 mob:text-[11.5px]"
            style={{ background: 'var(--brand)', color: 'var(--brand-fg)' }}
            onClick={openImportModal}
        >
            + {t('ov.import.short')}
        </button>
    );
    return (
        <section className="flex h-full min-w-0 flex-1 flex-col" style={{ background: 'var(--bg-canvas)' }}>
            {/* 移动端域头(返回 hub + 标题 + 导入):桌面 header 在页内(:323) */}
            <header className="flex h-12 shrink-0 items-center justify-between border-b border-[color:var(--border-hairline)] px-3 mob-only">
                <div className="flex min-w-0 items-center gap-1.5">
                    <button className="ghost-btn h-8 w-8 shrink-0" onClick={() => { if (studioLeaveGuard.check?.() ?? true) s.setView('hub'); }}>
                        <Icon name="arrowLeft" size={16} />
                    </button>
                    <span className="heading-tight truncate text-[14px] font-medium text-[color:var(--fg-primary)]">{t(`studio.${nav}.title`)}</span>
                </div>
                {importBtn}
            </header>
            <div className={`min-h-0 flex-1 overflow-y-auto ${fill ? 'lg:overflow-hidden' : ''} px-10 py-8 mob:p-4`}>
                <div className={`mx-auto max-w-4xl space-y-5 ${fill ? 'lg:flex lg:h-full lg:flex-col' : ''}`}>
                    <div className="flex shrink-0 flex-wrap items-start justify-between gap-4 desk-only">
                        <div>
                            <h1 className="heading-tight text-title-lg font-medium text-[color:var(--fg-primary)]">{t(`studio.${nav}.title`)}</h1>
                            <p className="mt-1 text-[12.5px] text-[color:var(--fg-muted)]">{t(`studio.${nav}.sub`)}</p>
                        </div>
                        {importBtn}
                    </div>
                    {fill ? <div className="min-h-0 lg:flex-1">{children}</div> : children}
                </div>
            </div>
        </section>
    );
}

/* ------------------------------------------------------------------ */
/* 2. global —— 全局常驻 JSON 栈(端稿 L1863;读真/写 disabled)             */
/* ------------------------------------------------------------------ */

function GlobalPage() {
    const { t } = useI18n();
    const s = useShell();
    const worlds = useRemote('worlds', listWorlds);
    const { slices, error: sErr, reload: sReload } = useSettingsSlices();
    const [busy, setBusy] = useState<string | null>(null);
    const items = worlds.data?.items ?? [];
    const counts = useWorldCounts(items);
    const cards = useMemo(() => [...s.cards.values()], [s.cards]);
    const bindings = useWorldBindings(cards);
    const sel = new Set(slices.globalSelect);

    const toggleBook = (w: WorldListItem) => {
        if (busy) return;
        const currentlyOn = sel.has(w.name) || sel.has(w.displayName);
        const nextList = currentlyOn
            ? slices.globalSelect.filter((x) => x !== w.name && x !== w.displayName)
            : [...slices.globalSelect, w.name];
        const wiOuter = (slices.raw?.world_info_settings && typeof slices.raw.world_info_settings === 'object' && !Array.isArray(slices.raw.world_info_settings))
            ? (slices.raw.world_info_settings as Record<string, unknown>)
            : {};
        const prevWi = (wiOuter.world_info && typeof wiOuter.world_info === 'object' && !Array.isArray(wiOuter.world_info))
            ? (wiOuter.world_info as Record<string, unknown>)
            : {};
        setBusy(w.name);
        void patchSettings({ world_info_settings: { world_info: { ...prevWi, globalSelect: nextList } } })
            .then(() => Promise.all([sReload(), s.refreshConnection()]))
            .catch((e) => s.hint(`${t('stage.patch.failed')}: ${e instanceof Error ? e.message : String(e)}`, true))
            .finally(() => setBusy(null));
    };

    if (worlds.error) return <PanelError error={worlds.error} onRetry={worlds.reload} />;
    if (sErr) return <PanelError error={sErr} onRetry={sReload} />;
    if (worlds.data && !items.length) return <PanelEmpty icon="layers">{t('studio.global.empty')}</PanelEmpty>;
    return (
        <div className="inset-group">
            {items.map((w) => {
                const on = sel.has(w.name) || sel.has(w.displayName);
                const n = counts.data?.[w.name];
                return (
                    <div key={w.name} className="inset-row">
                        <div className="min-w-0">
                            <div className="text-[13px] font-medium text-[color:var(--fg-primary)]">
                                {w.displayName || w.name}
                                {(bindings.data?.embedded?.[w.name]?.length ?? 0) > 0 && (
                                    <span className="ml-1.5 rounded px-1 py-px font-mono-ui text-[9.5px]" style={{ background: 'var(--bg-active)', color: 'var(--fg-muted)' }}>{t('studio.world.embeddedTag')}</span>
                                )}
                                <span className="ml-1.5 font-mono-ui text-[11px] text-[color:var(--fg-muted)]">
                                    {w.name}{n != null ? ` · ${n}${t('studio.world.entriesUnit')}` : ''}
                                </span>
                            </div>
                            <div className="mt-0.5 text-[12px] text-[color:var(--fg-secondary)]">
                                {(bindings.data?.embedded?.[w.name]?.length ?? 0) > 0
                                    ? `${t('studio.world.embeddedPrefix')}${bindings.data!.embedded[w.name]!.join(' / ')} · `
                                    : ''}
                                {on ? t('studio.global.inStack') : t('studio.global.notInStack')}
                            </div>
                        </div>
                        <Switch on={on} disabled={busy === w.name} onToggle={() => toggleBook(w)} />
                    </div>
                );
            })}
        </div>
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

/* —— 条目编辑面小件(本页专用;样式与 preset/persona 输入同 token 族) —— */
const wbInput = 'h-8 w-full rounded-lg border border-[color:var(--border-hairline)] bg-[color:var(--bg-canvas)] px-2.5 text-[12.5px] text-[color:var(--fg-primary)] outline-none transition-colors focus:border-[color:var(--border-strong)] disabled:opacity-50';

function WbField({ label, className, children }: { label: ReactNode; className?: string; children: ReactNode }) {
    return (
        <div className={className}>
            <div className="mb-1 text-[11px] text-[color:var(--fg-muted)]">{label}</div>
            {children}
        </div>
    );
}

function WbFlag({ label, on, onToggle, disabled }: { label: ReactNode; on: boolean; onToggle: () => void; disabled?: boolean }) {
    return (
        <span className="flex items-center gap-1.5 text-[12px] text-[color:var(--fg-secondary)]">
            <Switch on={on} onToggle={onToggle} disabled={disabled} />
            {label}
        </span>
    );
}

const LOGIC_NAMES = ['AND_ANY', 'NOT_ALL', 'NOT_ANY', 'AND_ALL'] as const;

/**
 * 条目编辑表单 —— 受控面:patch 改草稿,父级显式「保存」才 PUT 整档。
 * 覆盖字段 = worldbookDraft.applyDraft 写入面;其余键原样透传不丢。
 */
function WbEntryForm({ draft, patch, disabled }: {
    draft: EntryDraft;
    patch: (p: Partial<EntryDraft>) => void;
    disabled?: boolean;
}) {
    const { t } = useI18n();
    const num = (v: string, on: (s: string) => void) => ({
        type: 'number' as const, className: wbInput, value: v, disabled,
        onChange: (e: ChangeEvent<HTMLInputElement>) => on(e.target.value),
    });
    return (
        <div className="space-y-3">
            <WbField label={t('studio.world.f.comment')}>
                <input className={wbInput} value={draft.comment} disabled={disabled}
                    onChange={(e) => patch({ comment: e.target.value })} />
            </WbField>
            <WbField label={t('studio.world.f.content')}>
                <textarea
                    className="min-h-[130px] w-full select-text resize-y rounded-lg border border-[color:var(--border-hairline)] bg-[color:var(--bg-canvas)] p-2.5 font-mono-ui text-[12px] leading-relaxed text-[color:var(--fg-primary)] outline-none transition-colors focus:border-[color:var(--border-strong)] disabled:opacity-50"
                    value={draft.content} disabled={disabled}
                    onChange={(e) => patch({ content: e.target.value })}
                />
            </WbField>
            <WbField label={t('studio.world.f.key')}>
                <input className={`${wbInput} font-mono-ui`} value={draft.key} disabled={disabled}
                    placeholder="foo, bar" onChange={(e) => patch({ key: e.target.value })} />
            </WbField>
            {/* 触发面:常驻免关键词;停用整条目;次级匹配开二段门槛 */}
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
                <WbFlag label={t('studio.world.f.constant')} on={draft.constant} disabled={disabled}
                    onToggle={() => patch({ constant: !draft.constant })} />
                <WbFlag label={t('studio.world.f.disable')} on={draft.disable} disabled={disabled}
                    onToggle={() => patch({ disable: !draft.disable })} />
                <WbFlag label={t('studio.world.f.selective')} on={draft.selective} disabled={disabled}
                    onToggle={() => patch({ selective: !draft.selective })} />
            </div>
            {draft.selective && (
                <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-[1fr_140px]">
                    <WbField label={t('studio.world.f.keysecondary')}>
                        <input className={`${wbInput} font-mono-ui`} value={draft.keysecondary} disabled={disabled}
                            onChange={(e) => patch({ keysecondary: e.target.value })} />
                    </WbField>
                    <WbField label={t('studio.world.f.selectiveLogic')}>
                        <select className={`${wbInput} cursor-pointer`} value={draft.selectiveLogic} disabled={disabled}
                            onChange={(e) => patch({ selectiveLogic: e.target.value })}>
                            {LOGIC_OPTIONS.map((v) => <option key={v} value={v}>{LOGIC_NAMES[v]}</option>)}
                        </select>
                    </WbField>
                </div>
            )}
            {/* 注入面:position 枚举 = core world_info_position 全域 0-7 */}
            <div className="grid grid-cols-2 gap-2.5">
                <WbField label={t('studio.world.f.position')} className="col-span-2">
                    <select className={`${wbInput} cursor-pointer`} value={draft.position} disabled={disabled}
                        onChange={(e) => patch({ position: e.target.value })}>
                        {POSITION_OPTIONS.map((v) => <option key={v} value={v}>{t(`studio.world.pos.${v}`)}</option>)}
                    </select>
                </WbField>
                {draft.position === '4' && (
                    <>
                        <WbField label={t('studio.world.f.depth')}>
                            <input {...num(draft.depth, (v) => patch({ depth: v }))} />
                        </WbField>
                        <WbField label={t('studio.world.f.role')}>
                            <select className={`${wbInput} cursor-pointer`} value={draft.role} disabled={disabled}
                                onChange={(e) => patch({ role: e.target.value })}>
                                {ROLE_OPTIONS.map((v) => <option key={v} value={v}>{t(`studio.world.role.${v}`)}</option>)}
                            </select>
                        </WbField>
                    </>
                )}
                {draft.position === '7' && (
                    <WbField label={t('studio.world.f.outletName')} className="col-span-2">
                        <input className={wbInput} value={draft.outletName} disabled={disabled}
                            onChange={(e) => patch({ outletName: e.target.value })} />
                    </WbField>
                )}
                <WbField label={t('studio.world.f.order')}>
                    <input {...num(draft.order, (v) => patch({ order: v }))} />
                </WbField>
                <WbField label={t('studio.world.f.probability')}>
                    <div className="flex items-center gap-2">
                        <input {...num(draft.probability, (v) => patch({ probability: v }))} min={0} max={100} />
                        <WbFlag label={t('studio.world.f.useProb')} on={draft.useProbability} disabled={disabled}
                            onToggle={() => patch({ useProbability: !draft.useProbability })} />
                    </div>
                </WbField>
                <WbField label={t('studio.world.f.group')}>
                    <input className={wbInput} value={draft.group} disabled={disabled}
                        onChange={(e) => patch({ group: e.target.value })} />
                </WbField>
                <WbField label={t('studio.world.f.groupWeight')}>
                    <input {...num(draft.groupWeight, (v) => patch({ groupWeight: v }))} />
                </WbField>
            </div>
            {/* 定时效果三键 —— 留空写 null = 关(引擎 timedWorldInfo 语义) */}
            <div className="grid grid-cols-3 gap-2.5">
                <WbField label={t('studio.world.f.sticky')}>
                    <input {...num(draft.sticky, (v) => patch({ sticky: v }))} min={0} />
                </WbField>
                <WbField label={t('studio.world.f.cooldown')}>
                    <input {...num(draft.cooldown, (v) => patch({ cooldown: v }))} min={0} />
                </WbField>
                <WbField label={t('studio.world.f.delay')}>
                    <input {...num(draft.delay, (v) => patch({ delay: v }))} min={0} />
                </WbField>
            </div>
        </div>
    );
}

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
        const doc = await loadCharDoc(s.chat!.charDir);
        const w = cardData(doc).extensions?.world;
        return typeof w === 'string' && w ? w : null;
    });
    const [picked, setPicked] = useState<string | null>(null);
    /* 深链落点:会话信息层/外部跳某本书时 wbStudioFocus.set 置名 ——
       书目一到位即消费一次(qrStudioFocus 同款,不进 studioNav 词表)。 */
    useEffect(() => {
        const f = wbStudioFocus.set;
        if (f && items.some((i) => i.name === f)) { wbStudioFocus.set = null; setPicked(f); }
    }, [items]);
    const [ddOpen, setDdOpen] = useState(false);
    const [creatingBook, setCreatingBook] = useState(false);
    const [newBookName, setNewBookName] = useState('');
    const curName = (picked && items.some((i) => i.name === picked) ? picked : null)
        ?? bound.data ?? items[0]?.name ?? null;
    const curMeta = items.find((i) => i.name === curName) ?? null;
    /* 乐观档:写回成功后立刻以写出的整档展示(reload 期间不等转场/不闪首条);
     * 远端 GET 一落即交还(loadWorldDoc 成功回调自清),真值源仍是远端。 */
    const [docOpt, setDocOpt] = useState<{ name: string; doc: WorldDoc } | null>(null);
    const docR = useRemote(curName ? `world:${curName}` : null, () => (curName
        ? loadWorldDoc(curName).then((d) => { setDocOpt(null); return { doc: d }; })
        : Promise.reject(new Error('no world'))));
    const doc = (docOpt && docOpt.name === curName ? docOpt.doc : docR.data?.doc) ?? null;
    const entries = useMemo(() => Object.entries(doc?.entries ?? {}), [doc]);
    const [selUid, setSelUid] = useState<string | null>(null);
    const selId = selUid && doc?.entries?.[selUid] ? selUid : (entries[0]?.[0] ?? null);
    const selEntry = selId && doc ? doc.entries[selId]! : null;

    /* 编辑草稿:挂在选中 uid 上;脏基线 = draftOf(盘上条目)。
     * 显式「保存」才 PUT 整档;结构操作(新建/复制/删除/启停)直写。 */
    const [draftBox, setDraftBox] = useState<{ uid: string; d: EntryDraft } | null>(null);
    const [busyWrite, setBusyWrite] = useState(false);
    const curDraft: EntryDraft | null = selEntry
        ? (draftBox && draftBox.uid === selId ? draftBox.d : draftOf(selEntry))
        : null;
    const dirty = !!(selEntry && curDraft && draftDirty(selEntry, curDraft));
    const patchDraft = (p: Partial<EntryDraft>) => {
        if (!selId || !curDraft) return;
        setDraftBox({ uid: selId, d: { ...curDraft, ...p } });
    };
    const guardDirty = (): boolean => !dirty || window.confirm(t('studio.world.discardConfirm'));
    /* 挂上离开守卫:移动壳返回键先经 studioLeaveGuard 问一句 —— guardDirty
       闭包随 dirty 变,latest-ref 防陈旧;卸载清位,不挡后来的页另挂。 */
    const guardRef = useRef(guardDirty);
    guardRef.current = guardDirty;
    useEffect(() => {
        studioLeaveGuard.check = () => guardRef.current();
        return () => { studioLeaveGuard.check = null; };
    }, []);
    const pickEntry = (uid: string) => {
        if (!guardDirty()) return;
        setSelUid(uid);
        /* 确认丢弃后清草稿盒 —— 否则按 uid 匹配回跳会把「已放弃」的草稿复活。 */
        setDraftBox(null);
    };
    const pickBook = (name: string) => {
        if (!guardDirty()) return;
        setPicked(name); setSelUid(null); setDraftBox(null); setDdOpen(false);
    };

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

    const hintFail = (e: unknown, key = 'studio.world.saveFailed') =>
        s.hint(`${t(key)}: ${e instanceof Error ? e.message : String(e)}`, true);

    /** 写回公共路:整档 PUT → 乐观档先显 → 失效缓存 → 刷远端与计数。 */
    const writeDoc = (next: WorldDoc, after?: () => void, failKey = 'studio.world.saveFailed') => {
        if (!curName || busyWrite) return;
        setBusyWrite(true);
        saveWorld(curName, next)
            .then(() => { setDocOpt({ name: curName, doc: next }); invalidateWorldDoc(curName); docR.reload(); counts.reload(); after?.(); })
            .catch((e) => hintFail(e, failKey))
            .finally(() => setBusyWrite(false));
    };

    const [toggling, setToggling] = useState<string | null>(null);
    const toggleEntry = (uid: string) => {
        if (!doc || !curName || toggling || busyWrite) return;
        const ent = doc.entries[uid];
        if (!ent) return;
        setToggling(uid);
        writeDoc(
            { ...doc, entries: { ...doc.entries, [uid]: { ...ent, disable: !ent.disable } } },
            () => setToggling(null),
            'studio.world.toggleFailed',
        );
    };

    /* —— 条目编辑面:暂存草稿显式保存;未覆盖字段 applyDraft 展开透传 —— */
    const saveEntry = () => {
        if (!doc || !selId || !selEntry || !curDraft) return;
        const merged = applyDraft(selEntry, curDraft) as WorldEntry;
        /* 保存后草稿换 normalized 形(draftOf(已写条目)):表单值不回闪;
         * reload 落盘数据回来后基线对齐,dirty 自然归零。 */
        writeDoc({ ...doc, entries: { ...doc.entries, [selId]: merged } },
            () => setDraftBox({ uid: selId, d: draftOf(merged) }));
    };

    /* 条目结构操作:uid = max uid + 1(ST 惯例);新建 disable 起步安全。 */
    const addEntry = () => {
        if (!doc || !guardDirty()) return;
        const uid = nextUid(doc.entries);
        const next: WorldDoc = { ...doc, entries: { ...doc.entries, [String(uid)]: newEntry(uid) as WorldEntry } };
        writeDoc(next, () => { setSelUid(String(uid)); setDraftBox(null); });
    };
    const dupEntry = () => {
        if (!doc || !selId || !selEntry || !guardDirty()) return;
        const uid = nextUid(doc.entries);
        const next: WorldDoc = { ...doc, entries: { ...doc.entries, [String(uid)]: { ...selEntry, uid } } };
        writeDoc(next, () => { setSelUid(String(uid)); setDraftBox(null); });
    };
    const delEntry = () => {
        if (!doc || !selId || !selEntry) return;
        if (!window.confirm(`${t('studio.world.delEntryConfirm')}\n${entryTitle(selId, selEntry)}`)) return;
        const rest = { ...doc.entries };
        delete rest[selId];
        writeDoc({ ...doc, entries: rest }, () => { setSelUid(null); setDraftBox(null); });
    };

    /* —— 书级操作:PUT 建空档(引擎 resolveName 归一);DELETE 两步确认 —— */
    const addBook = () => {
        const name = newBookName.trim();
        if (!name || busyWrite) return;
        if (items.some((i) => i.name === name || i.displayName === name)) {
            s.hint(t('studio.world.bookExists'), true);
            return;
        }
        setBusyWrite(true);
        saveWorld(name, { entries: {} })
            .then((r) => {
                setCreatingBook(false); setNewBookName('');
                /* 用响应里的 canonical 名(resolveName 归一后可能 ≠ 输入)。 */
                setPicked(r.name || name); setSelUid(null); setDraftBox(null);
                worlds.reload();
            })
            .catch((e) => hintFail(e))
            .finally(() => setBusyWrite(false));
    };
    const delBook = () => {
        if (!curName || !guardDirty()) return;
        if (!window.confirm(`${t('studio.world.delBookConfirm')}\n${curMeta?.displayName || curName}`)) return;
        setBusyWrite(true);
        deleteWorld(curName)
            .then(() => {
                invalidateWorldDoc(curName);
                setPicked(null); setSelUid(null); setDraftBox(null);
                worlds.reload();
            })
            .catch((e) => hintFail(e))
            .finally(() => setBusyWrite(false));
    };

    /* —— 会话绑定书:chat_metadata.world_info(TH setChatLorebook 同键) —— */
    const chatTarget = thCallTarget(s.chat);
    const chatLb = useRemote(chatTarget ? `chatlb:${chatTarget.charDir}/${chatTarget.chatName}` : null, async () => {
        const r = await thCall('getChatLorebook', {}, chatTarget!);
        if (!r.ok) throw new Error('error' in r ? String(r.error) : `unsupported:${r.method}`);
        return typeof r.result === 'string' && r.result ? r.result : null;
    });
    const chatLbBusy = useRef(false);
    const setChatLb = (name: string | null) => {
        if (!chatTarget || chatLbBusy.current) return;
        chatLbBusy.current = true;
        void thCall('setChatLorebook', { lorebook: name }, chatTarget)
            .then((r) => {
                if (!r.ok) throw new Error('error' in r ? String(r.error) : `unsupported:${r.method}`);
                chatLb.reload();
            })
            .catch((e) => hintFail(e, 'studio.world.chatLbFailed'))
            .finally(() => { chatLbBusy.current = false; });
    };

    if (worlds.error) return <PanelError error={worlds.error} onRetry={worlds.reload} />;
    const noBooks = !!(worlds.data && !items.length);

    const boundChips = curName ? (bindings.data?.bound?.[curName] ?? bindings.data?.bound?.[curMeta?.displayName ?? ''] ?? []) : [];
    const curCount = curName ? counts.data?.[curName] ?? entries.length : 0;

    return (
        /* lg 起:h-full 链接 StudioShell 定高滚动口 → 编辑器双栏各自
           overflow-y-auto(条目长/表单长互不拖累);移动端仍整页滚。 */
        <div className="flex flex-col gap-4 lg:h-full lg:min-h-0">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex min-w-[260px] max-w-[520px] flex-1 items-center gap-1.5">
                    {/* 书文件选择器(端稿 WORLDS_LIB 下拉 —— 选项带条目数+绑定注释);空库只剩 +/trash */}
                    {!noBooks && (
                    <div className="relative flex-1">
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
                                    const bound2 = bindings.data?.bound?.[w.name] ?? [];
                                    const emb = bindings.data?.embedded?.[w.name] ?? [];
                                    const sub = emb.length
                                        ? `${t('studio.world.embeddedPrefix')}${emb.join(' / ')}`
                                        : bound2.length
                                            ? `${t('studio.world.boundPrefix')}${bound2.join(' / ')}`
                                            : t('studio.world.unbound');
                                    return (
                                        <button
                                            key={w.name}
                                            className="inset-row-btn flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left"
                                            onClick={() => pickBook(w.name)}
                                        >
                                            <div className="min-w-0">
                                                <div className="truncate text-[12.5px] font-medium text-[color:var(--fg-primary)]">
                                                    {w.displayName || w.name}
                                                    {emb.length > 0 && (
                                                        <span className="ml-1.5 rounded px-1 py-px font-mono-ui text-[9.5px]" style={{ background: 'var(--bg-active)', color: 'var(--fg-muted)' }}>{t('studio.world.embeddedTag')}</span>
                                                    )}
                                                </div>
                                                <div className="truncate font-mono-ui text-[10.5px] text-[color:var(--fg-muted)]">
                                                    {n == null ? '…' : `${n}${t('studio.world.entriesUnit')}`} · {sub}
                                                </div>
                                            </div>
                                            {w.name === curName && <Icon name="check" size={14} className="shrink-0 text-[color:var(--brand)]" />}
                                        </button>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                    )}
                    {/* 书级操作:新建空档 / 导出 JSON(TASK-067)/ 删当前书(confirm 两步) */}
                    <button className="ghost-btn h-8 w-8 shrink-0" title={t('studio.world.addBook')} disabled={busyWrite}
                        onClick={() => { setCreatingBook((v) => !v); setNewBookName(''); }}>
                        <Icon name="plus" size={14} />
                    </button>
                    <button className="ghost-btn h-8 w-8 shrink-0" title={t('ov.export.world')} disabled={!curName}
                        onClick={() => { if (curName) downloadExport(exportWorldUrl(curName)); }}>
                        <Icon name="upload" size={14} />
                    </button>
                    <button className="ghost-btn h-8 w-8 shrink-0" title={t('studio.world.delBook')} disabled={busyWrite || !curName}
                        onClick={delBook}>
                        <Icon name="trash" size={14} />
                    </button>
                </div>
                {/* 绑定反查 chips + 会话书绑定(TH getChatLorebook/setChatLorebook) */}
                <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                    <span className="text-[color:var(--fg-muted)]">{t('studio.world.bound')}</span>
                    {boundChips.length ? boundChips.map((cn) => (
                        <span key={cn} className="rounded-md px-2 py-0.5 font-medium" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-hairline)', color: 'var(--fg-secondary)' }}>{cn}</span>
                    )) : (
                        <span className="text-[color:var(--fg-faint)]">{bindings.error ? '—' : t('studio.world.boundNone')}</span>
                    )}
                    {chatTarget && (
                        <span className="ml-1.5 flex items-center gap-1 border-l border-[color:var(--border-hairline)] pl-2.5">
                            <span className="text-[color:var(--fg-muted)]">{t('studio.world.chatLb')}</span>
                            <span className="max-w-[140px] truncate font-mono-ui text-[10.5px] text-[color:var(--fg-secondary)]">
                                {chatLb.data ?? (chatLb.loading ? '…' : t('studio.world.chatLbNone'))}
                            </span>
                            {curName && (chatLb.data === curName ? (
                                <button className="ghost-btn h-6 rounded-md px-1.5 text-[10.5px]" onClick={() => setChatLb(null)}>
                                    {t('studio.world.chatUnbind')}
                                </button>
                            ) : (
                                <button className="ghost-btn h-6 rounded-md px-1.5 text-[10.5px] font-medium" style={{ color: 'var(--brand)' }}
                                    onClick={() => setChatLb(curName)}>
                                    {t('studio.world.chatBind')}
                                </button>
                            ))}
                        </span>
                    )}
                </div>
            </div>

            {/* 新建书内联行:文件名 → PUT 空 entries 档 */}
            {creatingBook && (
                <div className="flex max-w-[420px] items-center gap-1.5">
                    <input
                        className={wbInput} autoFocus value={newBookName}
                        placeholder={t('studio.world.bookNamePh')} disabled={busyWrite}
                        onChange={(e) => setNewBookName(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') addBook();
                            if (e.key === 'Escape') setCreatingBook(false);
                        }}
                    />
                    <button className="ghost-btn h-8 w-8 shrink-0" title={t('studio.world.addBook')} disabled={busyWrite || !newBookName.trim()} onClick={addBook}>
                        <Icon name="check" size={14} />
                    </button>
                    <button className="ghost-btn h-8 w-8 shrink-0" disabled={busyWrite} onClick={() => setCreatingBook(false)}>
                        <Icon name="x" size={14} />
                    </button>
                </div>
            )}

            {noBooks && <PanelEmpty icon="bookOpen">{t('studio.world.empty')}</PanelEmpty>}
            {docR.error && <PanelError error={docR.error} onRetry={docR.reload} />}
            {doc && (
                <div className="grid grid-cols-1 gap-4 lg:min-h-0 lg:flex-1 lg:grid-cols-12">
                    {/* 左列:新建 + 条目 + 命中徽标 + 启停直写 */}
                    <div className="inset-group h-fit lg:col-span-5 lg:h-full lg:min-h-0 lg:overflow-y-auto">
                        <button className="inset-row inset-row-btn w-full !justify-start gap-2" onClick={addEntry} disabled={busyWrite}>
                            <Icon name="plus" size={13} className="shrink-0 text-[color:var(--fg-muted)]" />
                            <span className="text-[12px] font-medium text-[color:var(--fg-secondary)]">{t('studio.world.addEntry')}</span>
                        </button>
                        {entries.map(([uid, e]) => {
                            const hitsN = hitMap.get(uid) ?? null;
                            const rate = hitsN && wiEvents ? Math.round((hitsN / wiEvents) * 100) : null;
                            const enabled = !e.disable;
                            return (
                                <div key={uid} className="inset-row" style={{ background: uid === selId ? 'var(--bg-active)' : 'transparent' }}>
                                    <button className="min-w-0 flex-1 text-left" onClick={() => pickEntry(uid)}>
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
                    {/* 右列:结构化条目编辑表单(JSON pre 已收编进字段面) */}
                    <div className="space-y-3 rounded-[12px] p-4 lg:col-span-7 lg:h-full lg:min-h-0 lg:overflow-y-auto" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-hairline)' }}>
                        {selEntry && curDraft ? (
                            <>
                                <div className="flex items-center justify-between gap-2">
                                    <div className="flex min-w-0 items-center gap-2">
                                        <span className="shrink-0 font-mono-ui text-[11px] text-[color:var(--fg-faint)]">#{selId}</span>
                                        <span className="shrink-0 font-mono-ui text-[11px]" style={{ color: (hitMap.get(selId!) ?? 0) === 0 ? 'var(--brand)' : 'var(--fg-muted)' }}>
                                            {hitMap.has(selId!)
                                                ? `${t('studio.world.hitsPre')} ${hitMap.get(selId!)} ${t('studio.world.hitsUnit')}`
                                                : hits.data ? t('studio.world.hitsZero2') : '—'}
                                        </span>
                                    </div>
                                    <div className="flex shrink-0 items-center gap-1">
                                        <button className="ghost-btn h-7 w-7" title={t('studio.world.dupEntry')} disabled={busyWrite} onClick={dupEntry}>
                                            <Icon name="copy" size={13} />
                                        </button>
                                        <button className="ghost-btn h-7 w-7" title={t('studio.world.delEntry')} disabled={busyWrite} onClick={delEntry}>
                                            <Icon name="trash" size={13} />
                                        </button>
                                        <button
                                            className="ml-1 h-7 rounded-lg px-3 text-[12px] font-medium transition-opacity"
                                            style={dirty
                                                ? { background: 'var(--primary-bg)', color: 'var(--primary-fg)' }
                                                : { background: 'var(--bg-active)', color: 'var(--fg-muted)' }}
                                            disabled={!dirty || busyWrite}
                                            onClick={saveEntry}
                                        >
                                            {busyWrite ? '…' : dirty ? `${t('studio.world.save')} · ${t('studio.world.dirty')}` : t('studio.world.save')}
                                        </button>
                                    </div>
                                </div>
                                <WbEntryForm draft={curDraft} patch={patchDraft} disabled={busyWrite} />
                            </>
                        ) : (
                            <PanelEmpty icon="bookOpen">{t('studio.world.noSelEntry')}</PanelEmpty>
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

/** 行摘要用四元组(读档直显,不写面 —— 写面全归 PresetDocEditor)。 */
const tuneOf = (doc: PresetDocument | undefined) => ({
    temp: pnum(doc?.temperature),
    topP: pnum(doc?.top_p),
    ctxLen: pnum(doc?.openai_max_context),
    maxReply: pnum(doc?.openai_max_tokens),
});

/* Per-row doc cell — the row subscribes to the shared presetDocs store,
   so the displayed doc is the SAME optimistic doc every other surface
   edits (rail PresetDocEditor, automation panel, sliders): a write from
   anywhere lands here via store notify, never a stale page snapshot. */
function PresetRowDoc({ name, fallback }: { name: string; fallback: (doc: PresetDocument | undefined, saving: boolean, unreadable: boolean) => ReactNode }) {
    const snap = usePresetDoc(PRESET_API_ID, name);
    return <>{fallback(snap.doc ?? undefined, snap.saving, snap.status === 'error')}</>;
}

function PresetsPage() {
    const { t } = useI18n();
    const s = useShell();
    const list = useRemote(PRESET_API_ID, () => listPresets(PRESET_API_ID));
    const { slices, reload: sReload } = useSettingsSlices();
    const names = list.data?.items.map((x) => x.name) ?? [];
    const [switching, setSwitching] = useState<string | null>(null);
    const [editOpen, setEditOpen] = useState<string | null>(null);
    const [creating, setCreating] = useState(false);
    const [newName, setNewName] = useState('');
    const [busyRow, setBusyRow] = useState<string | null>(null);

    /* Single write lane: mutate the shared store doc — optimistic apply
       is synchronous (typing never reverts), the debounced flush does
       GET → rebase pending → PUT so external writes are merged, and a
       failed PUT rolls back to server truth (store-owned semantics). */
    const mutateFor = (n: string) => (fn: (d: PresetDocument) => PresetDocument) => {
        presetDocs.mutate(presetKey(PRESET_API_ID, n), fn);
    };

    const refreshAll = () => Promise.all([list.reload(), s.refreshConnection(), sReload()]);

    const activatePreset = (name: string) => {
        if (switching) return;
        const clean = name.replace(/\.json$/i, '');
        setSwitching(name);
        void patchSettings({ preset_settings_openai: clean })
            .then(() => { s.pickPreset(clean); return sReload(); })
            .catch((e) => s.hint(`${t('studio.presets.saveFailed')}: ${e instanceof Error ? e.message : String(e)}`, true))
            .finally(() => setSwitching(null));
    };

    /* 新建 = PUT 空档(字段随编辑写入);复制 = 整档深拷自动取名;
       删除 = confirm 两步 + 激活档降级(余档切默认/空档清指针)。 */
    const addPreset = () => {
        const name = newName.trim();
        if (!name || busyRow) return;
        if (names.includes(name)) { s.hint(t('studio.presets.exists'), true); return; }
        setBusyRow('new');
        void savePreset(name, {}, PRESET_API_ID)
            .then(() => {
                presetDocs.prime(presetKey(PRESET_API_ID, name), {});
                setCreating(false); setNewName(''); setEditOpen(name);
                return refreshAll();
            })
            .catch((e) => s.hint(`${t('studio.presets.saveFailed')}: ${e instanceof Error ? e.message : String(e)}`, true))
            .finally(() => setBusyRow(null));
    };
    const copyPreset = (n: string) => {
        const key = presetKey(PRESET_API_ID, n);
        const src = presetDocs.getDoc(key);
        if (!src || busyRow) return;
        let cand = `${n}-copy`; let i = 2;
        while (names.includes(cand)) cand = `${n}-copy-${i++}`;
        const target = cand;
        setBusyRow(n);
        /* Flush pending edits first so the copy carries the latest doc,
           not just what has already hit the server. */
        void presetDocs.flush(key)
            .then(() => savePreset(target, JSON.parse(JSON.stringify(presetDocs.getDoc(key) ?? src)) as PresetDocument, PRESET_API_ID))
            .then(() => { setEditOpen(target); return refreshAll(); })
            .catch((e) => s.hint(`${t('studio.presets.saveFailed')}: ${e instanceof Error ? e.message : String(e)}`, true))
            .finally(() => setBusyRow(null));
    };
    const delPreset = (n: string) => {
        if (busyRow) return;
        if (!window.confirm(`${t('studio.presets.delConfirm')}\n${n}`)) return;
        const wasActive = slices.activePreset === n || slices.activePreset === n.replace(/\.json$/i, '');
        const remaining = names.filter((x) => x !== n);
        setBusyRow(n);
        void deletePreset(n, PRESET_API_ID)
            .then(() => {
                presetDocs.drop(presetKey(PRESET_API_ID, n));
                if (editOpen === n) setEditOpen(null);
                /* 激活档被删 → 降级:有余档切首档(走 pickPreset 完整水合),
                   空库清指针 null(merge-patch 删键)。 */
                if (wasActive) {
                    if (remaining[0]) s.pickPreset(remaining[0]);
                    else void patchSettings({ preset_settings_openai: null }).catch(() => undefined);
                }
                return refreshAll();
            })
            .catch((e) => s.hint(`${t('studio.presets.saveFailed')}: ${e instanceof Error ? e.message : String(e)}`, true))
            .finally(() => setBusyRow(null));
    };

    if (list.error) return <PanelError error={list.error} onRetry={list.reload} />;

    return (
        <div className="space-y-3">
            {/* 页级操作:新建空档 / 行内复制 / 行内删除(两步确认)。
                副标题只由 StudioShell 页头渲,此容器只留操作钮。 */}
            <div className="flex items-center justify-end gap-2">
                <button
                    className="ghost-btn h-7 shrink-0 gap-1 px-2.5 text-[11.5px]"
                    disabled={busyRow !== null}
                    onClick={() => { setCreating((v) => !v); setNewName(''); }}
                >
                    <Icon name="plus" size={12} /> {t('studio.presets.new')}
                </button>
            </div>
            {creating && (
                <div className="flex max-w-[420px] items-center gap-1.5">
                    <input
                        className={wbInput} autoFocus value={newName}
                        placeholder={t('studio.presets.newNamePh')} disabled={busyRow === 'new'}
                        onChange={(e) => setNewName(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') addPreset();
                            if (e.key === 'Escape') setCreating(false);
                        }}
                    />
                    <button className="ghost-btn h-8 w-8 shrink-0" title={t('studio.presets.new')} disabled={busyRow === 'new' || !newName.trim()} onClick={addPreset}>
                        <Icon name="check" size={14} />
                    </button>
                    <button className="ghost-btn h-8 w-8 shrink-0" disabled={busyRow === 'new'} onClick={() => setCreating(false)}>
                        <Icon name="x" size={14} />
                    </button>
                </div>
            )}
            {list.data && !names.length && <PanelEmpty icon="sliders">{t('studio.presets.empty')} · {PRESET_API_ID}</PanelEmpty>}
            <div className="inset-group">
                {names.map((n) => (
                    <PresetRowDoc key={n} name={n} fallback={(doc, saving, unreadable) => {
                    const tune = tuneOf(doc);
                    const active = slices.activePreset === n || slices.activePreset === n.replace(/\.json$/i, '');
                    const open = editOpen === n;
                    return (
                        <div key={n} className="inset-row flex-col !items-stretch">
                            <div className="flex items-center justify-between gap-3">
                                <div className="min-w-0">
                                    <div className="truncate font-mono-ui text-[13px] font-medium text-[color:var(--fg-primary)]">{n}</div>
                                    <div className="mt-0.5 truncate font-mono-ui text-[11.5px] text-[color:var(--fg-muted)]">
                                        {unreadable ? t('studio.presets.unreadable')
                                            : `T ${tune.temp ?? '—'} · TopP ${tune.topP ?? '—'} · ${tune.maxReply ?? '—'} tok${presetModel(doc) ? ` · ${presetModel(doc)}` : ''}`}
                                    </div>
                                </div>
                                <div className="flex shrink-0 items-center gap-1.5">
                                    {saving && <span className="font-mono-ui text-[10px] text-[color:var(--fg-faint)]">{t('panel.notes.saving')}</span>}
                                    {/* 导出整档 JSON(TASK-067):回出即 import 'preset' 嗅探形。 */}
                                    <button
                                        className="ghost-btn h-7 w-7" disabled={!doc}
                                        onClick={() => downloadExport(exportPresetUrl(n, PRESET_API_ID))} title={t('ov.export.preset')}
                                    >
                                        <Icon name="upload" size={12} />
                                    </button>
                                    <button
                                        className="ghost-btn h-7 w-7" disabled={!doc || busyRow === n}
                                        onClick={() => copyPreset(n)} title={t('studio.presets.copy')}
                                    >
                                        <Icon name="copy" size={12} />
                                    </button>
                                    <button
                                        className="ghost-btn h-7 w-7" disabled={busyRow === n}
                                        onClick={() => delPreset(n)} title={t('studio.presets.delete')}
                                    >
                                        <Icon name="trash" size={12} />
                                    </button>
                                    <button
                                        className="ghost-btn h-7 rounded-md px-2 text-[11px]"
                                        disabled={!doc}
                                        onClick={() => setEditOpen(open ? null : n)}
                                        title={t('studio.presets.tune')}
                                    >
                                        <Icon name={open ? 'chevronDown' : 'sliders'} size={12} />
                                    </button>
                                    {active ? (
                                        <span className="rounded-lg px-3 py-1 text-[12px] font-medium" style={{ background: 'var(--bg-active)', color: 'var(--fg-muted)' }}>{t('studio.presets.active')}</span>
                                    ) : (
                                        <button
                                            className="rounded-lg px-3 py-1 text-[12px] font-medium transition-opacity"
                                            style={{ background: 'var(--primary-bg)', color: 'var(--primary-fg)', opacity: switching === n ? 0.5 : 1 }}
                                            disabled={switching !== null}
                                            onClick={() => activatePreset(n)}
                                        >
                                            {t('studio.presets.setDefault')}
                                        </button>
                                    )}
                                </div>
                            </div>
                            {open && doc && (
                                <div className="mt-2 border-t border-[color:var(--border-hairline)] pt-3">
                                    <PresetDocEditor doc={doc} onMutate={mutateFor(n)} apiId={PRESET_API_ID} presetName={n} />
                                </div>
                            )}
                        </div>
                    );
                    }} />
                ))}
            </div>
        </div>
    );
}

/* ------------------------------------------------------------------ */
/* 5. persona —— 全真 CRUD + Utopinn 内置动物头像库(redpanda/fox/owl)       */
/* ------------------------------------------------------------------ */

interface PersonaDraft {
    name: string;
    description: string;
    /** 选中的内置键:动物头像 id('user-*.png')或故事卡面 id('red-panda' 等)。 */
    builtinAvatar: PersonaAvatarPick;
}

function PersonaPage() {
    const { t } = useI18n();
    const s = useShell();
    const list = useRemote('personas', listPersonas);
    const items = list.data?.items ?? [];
    const [editing, setEditing] = useState<string | null>(null);
    const [draft, setDraft] = useState<PersonaDraft>({
        name: '',
        description: '',
        builtinAvatar: BUILTIN_PERSONA_AVATARS[0].id,
    });
    const [busy, setBusy] = useState(false);
    /* 头像版本戳:同键重传后 URL 不变,?v= 戳破浏览器静态缓存。 */
    const [avVer, setAvVer] = useState(0);

    const act = (fn: () => Promise<unknown>) => {
        if (busy) return;
        setBusy(true);
        void fn()
            .then(() => Promise.all([list.reload(), s.refreshPersonas()]))
            .catch((e) => s.hint(`${t('studio.persona.failed')}: ${e instanceof Error ? e.message : String(e)}`, true))
            .finally(() => setBusy(false));
    };

    const onSaveRow = (p: PersonaItem) => {
        const curBuiltin = resolveBuiltinPersonaPick(p.avatar);
        const avatarChanged = !p.hasImage && draft.builtinAvatar !== curBuiltin;
        act(async () => {
            if (avatarChanged) {
                /* 卡面选择铸 'cover-<id>.png' 键,动物头像直用 id —— 同一条换键保存路。 */
                const cover = BUILTIN_COVERS.find((c) => c.id === draft.builtinAvatar);
                const nextKey = mintPersonaAvatarKey(cover ? coverPersonaKey(cover.id) : draft.builtinAvatar, items.map((x) => x.avatar));
                await savePersona(nextKey, {
                    name: draft.name.trim(),
                    description: draft.description,
                    position: p.position,
                    title: p.title,
                    ...(p.isDefault ? { is_default: true } : {}),
                });
                await deletePersona(p.avatar);
                if (s.persona?.avatar === p.avatar) {
                    s.setPersona({ avatar: nextKey, name: draft.name.trim(), description: draft.description });
                }
            } else {
                await savePersona(p.avatar, { name: draft.name.trim(), description: draft.description });
                if (s.persona?.avatar === p.avatar) {
                    s.setPersona({ avatar: p.avatar, name: draft.name.trim(), description: draft.description });
                }
            }
            setEditing(null);
        });
    };

    const onCreateNew = () => {
        const used = new Set(items.map((x) => x.avatar));
        const freeBase = BUILTIN_PERSONA_AVATARS.find((b) => !used.has(b.id))?.id
            ?? BUILTIN_PERSONA_AVATARS[items.length % BUILTIN_PERSONA_AVATARS.length]!.id;
        const avatar = mintPersonaAvatarKey(freeBase, used);
        act(async () => {
            await savePersona(avatar, {
                name: t('studio.persona.newName'),
                description: '',
                ...(items.length === 0 ? { is_default: true } : {}),
            });
            setEditing(avatar);
            setDraft({ name: t('studio.persona.newName'), description: '', builtinAvatar: freeBase });
        });
    };

    if (list.error) return <PanelError error={list.error} onRetry={list.reload} />;
    return (
        <>
            <div className="inset-group">
                {items.map((p) => (
                    <PersonaRow
                        key={p.avatar}
                        p={p}
                        busy={busy}
                        inSession={s.persona?.avatar === p.avatar}
                        editing={editing === p.avatar}
                        draft={draft}
                        onUse={() => s.setPersona({ avatar: p.avatar, name: p.name, description: p.description })}
                        onEdit={() => {
                            setEditing(p.avatar);
                            setDraft({
                                name: p.name,
                                description: p.description,
                                builtinAvatar: resolveBuiltinPersonaPick(p.avatar),
                            });
                        }}
                        onCancel={() => setEditing(null)}
                        onChange={setDraft}
                        onSave={() => onSaveRow(p)}
                        onDefault={() => act(async () => {
                            await savePersona(p.avatar, { is_default: true });
                            s.setPersona({ avatar: p.avatar, name: p.name, description: p.description });
                        })}
                        onDelete={() => {
                            if (!window.confirm(`${t('studio.persona.delConfirm')}\n${p.name || p.avatar}`)) return;
                            act(() => deletePersona(p.avatar));
                        }}
                        ver={avVer}
                        onUpload={(f) => act(async () => {
                            /* overwrite=avatar 键:文件落 User Avatars/<key>,hasImage 翻真,
                               主键不变 —— name/desc/isDefault 全部原位保留,无需迁档。 */
                            await uploadPersonaImage(f, p.avatar);
                            setAvVer((v) => v + 1);
                        })}
                    />
                ))}
                {list.data && !items.length && <PanelEmpty icon="persona">{t('studio.persona.empty')}</PanelEmpty>}
            </div>
            <button
                className="inset-row-btn flex w-full items-center justify-center gap-2 rounded-[10px] py-2.5 text-[12.5px] font-medium"
                style={{ background: 'var(--bg-surface)', border: '1px dashed var(--border-strong)', color: 'var(--fg-secondary)' }}
                disabled={busy}
                onClick={onCreateNew}
            >
                <Icon name="plus" size={13} /> {t('studio.persona.new')}
            </button>
        </>
    );
}

function PersonaRow({ p, busy, inSession, editing, draft, onUse, onEdit, onCancel, onChange, onSave, onDefault, onDelete, onUpload, ver }: {
    p: PersonaItem; busy: boolean; inSession: boolean; editing: boolean;
    draft: PersonaDraft;
    onUse: () => void;
    onEdit: () => void; onCancel: () => void;
    onChange: (d: PersonaDraft) => void;
    onSave: () => void; onDefault: () => void; onDelete: () => void;
    /** 自定义头像上传(TASK-067):选文件 → POST /personas/avatar(overwrite=p.avatar)。 */
    onUpload: (f: File) => void;
    /** 头像版本戳(同键重传 ?v= 破缓存)。 */
    ver: number;
}) {
    const { t } = useI18n();
    const fallbackSrc = personaAvatarSrc(p.avatar, false);
    const [imgSrc, setImgSrc] = useState(() => personaAvatarSrc(p.avatar, p.hasImage));
    const fileRef = useRef<HTMLInputElement>(null);
    /* 上传后 hasImage 翻真/同键换图 → 同步真 URL(带版本戳);hasImage 变化才走。 */
    useEffect(() => {
        setImgSrc(personaAvatarSrc(p.avatar, p.hasImage) + (p.hasImage ? `?v=${ver}` : ''));
    }, [p.avatar, p.hasImage, ver]);
    return (
        <div className="inset-row flex-col !items-stretch">
            <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-3.5">
                    <img
                        src={editing && !p.hasImage
                            ? (builtinPickSrc(draft.builtinAvatar) ?? fallbackSrc)
                            : imgSrc}
                        alt=""
                        className="h-10 w-10 shrink-0 rounded-full object-cover"
                        style={{ border: inSession ? '2px solid var(--brand)' : '2px solid var(--border-bold)' }}
                        onError={() => { if (imgSrc !== fallbackSrc) setImgSrc(fallbackSrc); }}
                    />
                    <div className="min-w-0">
                        <div className="flex items-center gap-1.5 text-[13.5px] font-semibold text-[color:var(--fg-primary)]">
                            <span className="truncate">{p.name || p.avatar}</span>
                            {p.isDefault && <span className="shrink-0 text-[11px] font-normal text-[color:var(--fg-muted)]">{t('studio.persona.default')}</span>}
                            {inSession && (
                                <span className="shrink-0 rounded px-1.5 py-0.5 font-mono-ui text-[10px] font-normal" style={{ background: 'var(--bg-active)', color: 'var(--brand)' }}>
                                    {t('studio.persona.inUse')}
                                </span>
                            )}
                        </div>
                        <div className="mt-0.5 truncate text-[12px] text-[color:var(--fg-secondary)]">{p.description || <span className="text-[color:var(--fg-faint)]">{t('studio.persona.noDesc')}</span>}</div>
                    </div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                    {!inSession && (
                        <button className="ghost-btn h-7 rounded-md px-2 text-[11px]" disabled={busy} onClick={onUse}>{t('studio.persona.useNow')}</button>
                    )}
                    {!p.isDefault && (
                        <button className="ghost-btn h-7 rounded-md px-2 text-[11px]" disabled={busy} onClick={onDefault}>{t('studio.persona.setDefault')}</button>
                    )}
                    <button className="ghost-btn h-7 w-7" disabled={busy} onClick={onEdit} title={t('studio.persona.edit')}><Icon name="pencil" size={13} /></button>
                    <button className="ghost-btn h-7 w-7" disabled={busy} onClick={onDelete} title={t('studio.persona.delete')} style={{ color: 'var(--status-danger)' }}><Icon name="trash" size={13} /></button>
                </div>
            </div>
            {editing && (
                <div className="mt-2.5 space-y-2.5 border-t border-[color:var(--border-hairline)] pt-3">
                    {!p.hasImage && (
                        <div className="space-y-1.5">
                            <div className="flex items-center justify-between gap-2">
                                <span className="text-[11px] text-[color:var(--fg-muted)]">{t('studio.persona.av.groupAvatar')}</span>
                                <div className="flex items-center gap-2">
                                    {BUILTIN_PERSONA_AVATARS.map((av) => {
                                        const picked = draft.builtinAvatar === av.id;
                                        return (
                                            <button
                                                key={av.id}
                                                type="button"
                                                title={t(av.labelKey)}
                                                onClick={() => onChange({ ...draft, builtinAvatar: av.id })}
                                                className="flex items-center gap-1.5 rounded-full py-0.5 pl-0.5 pr-2 text-[11px] transition-colors"
                                                style={{
                                                    background: picked ? 'var(--bg-active)' : 'var(--bg-surface)',
                                                    border: picked ? '1.5px solid var(--brand)' : '1px solid var(--border-hairline)',
                                                    color: picked ? 'var(--fg-primary)' : 'var(--fg-muted)',
                                                }}
                                            >
                                                <img src={av.src} alt="" className="h-6 w-6 rounded-full object-cover" />
                                                <span>{t(av.labelKey)}</span>
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>
                            {/* 故事卡面第二选区:竖版 2:3 缩略方格裁中,选中铸 'cover-<id>.png' 键走同一保存路。 */}
                            <div className="flex items-center justify-between gap-2">
                                <span className="text-[11px] text-[color:var(--fg-muted)]">{t('studio.persona.av.groupCover')}</span>
                                <div className="flex items-center gap-1.5">
                                    {BUILTIN_COVERS.map((cv) => {
                                        const picked = draft.builtinAvatar === cv.id;
                                        return (
                                            <button
                                                key={cv.id}
                                                type="button"
                                                title={t(cv.labelKey)}
                                                onClick={() => onChange({ ...draft, builtinAvatar: cv.id })}
                                                className="h-9 w-6 shrink-0 overflow-hidden rounded-[5px] transition-opacity"
                                                style={{
                                                    border: picked ? '1.5px solid var(--brand)' : '1px solid var(--border-hairline)',
                                                    opacity: picked ? 1 : 0.7,
                                                }}
                                            >
                                                <img src={cv.src} alt={t(cv.labelKey)} className="h-full w-full object-cover" />
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>
                        </div>
                    )}
                    {/* 自定义头像(TASK-067):现有资产通道落盘 User Avatars/<avatar 键>,
                        键不换、hasImage 翻真;有图后内置选区收起(与 !hasImage 守卫互斥)。 */}
                    <div className="flex items-center justify-between gap-2">
                        <span className="text-[11px] text-[color:var(--fg-muted)]">{t('studio.persona.av.custom')}</span>
                        <button
                            type="button"
                            className="ghost-btn h-7 gap-1.5 rounded-md px-2 text-[11px]"
                            disabled={busy}
                            onClick={() => fileRef.current?.click()}
                        >
                            <Icon name="upload" size={12} /> {p.hasImage ? t('studio.persona.av.replace') : t('studio.persona.av.upload')}
                        </button>
                        <input
                            ref={fileRef} type="file" accept="image/*" className="hidden"
                            onChange={(e) => {
                                const f = e.target.files?.[0];
                                e.target.value = '';
                                if (f) onUpload(f);
                            }}
                        />
                    </div>
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
/* 6. regex —— /api/utopinn/regex 读写;本页口径 = global/char 两域        */
/*   (preset 脚本本体在预设档 extensions.regex_scripts,归宿预设编辑器内  */
/*    PresetRegexSection,不在此混列)。                                  */
/* ------------------------------------------------------------------ */

interface FlatRegexItem {
    key: string;
    target: RegexScopeTarget;
    idOrIdx: string | number;
    scopeLabel: string;
    script: RegexScriptData;
}

function RegexPage() {
    const { t } = useI18n();
    const s = useShell();
    const full = useRemote('regex:full', getRegexFullView);
    const [busyKey, setBusyKey] = useState<string | null>(null);
    const [adding, setAdding] = useState(false);
    const [newName, setNewName] = useState('');
    const [newFind, setNewFind] = useState('');
    const [newReplace, setNewReplace] = useState('');

    const rows = useMemo<FlatRegexItem[]>(() => {
        if (!full.data) return [];
        const out: FlatRegexItem[] = [];
        full.data.global.forEach((sc, idx) => {
            const idOrIdx = typeof sc.id === 'string' && sc.id ? sc.id : idx;
            out.push({
                key: `global:${idOrIdx}:${idx}`,
                target: { scope: 'global' },
                idOrIdx,
                scopeLabel: t('studio.regex.scopeGlobal'),
                script: sc,
            });
        });
        for (const c of full.data.chars) {
            c.scripts.forEach((sc, idx) => {
                const idOrIdx = typeof sc.id === 'string' && sc.id ? sc.id : idx;
                out.push({
                    key: `char:${c.charDir}:${idOrIdx}:${idx}`,
                    target: { scope: 'char', charDir: c.charDir },
                    idOrIdx,
                    scopeLabel: `${t('studio.regex.scope')} · ${c.name || c.charDir}`,
                    script: sc,
                });
            });
        }
        return out;
    }, [full.data, t]);

    const toggleRow = (r: FlatRegexItem) => {
        if (busyKey) return;
        setBusyKey(r.key);
        void patchRegexScript(r.target, r.idOrIdx, { disabled: !r.script.disabled })
            .then(() => full.reload())
            .catch((e) => s.hint(`${t('stage.patch.failed')}: ${e instanceof Error ? e.message : String(e)}`, true))
            .finally(() => setBusyKey(null));
    };

    const removeRow = (r: FlatRegexItem) => {
        if (busyKey) return;
        const label = r.script.scriptName || String(r.idOrIdx);
        if (!window.confirm(`${t('studio.regex.delConfirm')}\n${label}`)) return;
        setBusyKey(r.key);
        void deleteRegexScript(r.target, r.idOrIdx)
            .then(() => full.reload())
            .catch((e) => s.hint(`${t('stage.patch.failed')}: ${e instanceof Error ? e.message : String(e)}`, true))
            .finally(() => setBusyKey(null));
    };

    const createGlobal = () => {
        if (busyKey || !newName.trim() || !newFind.trim() || !full.data) return;
        setBusyKey('create');
        const newSc: RegexScriptData = {
            id: `rx-${Date.now()}`,
            scriptName: newName.trim(),
            findRegex: newFind,
            replaceString: newReplace,
            placement: [2],
            disabled: false,
            markdownOnly: true,
            promptOnly: false,
            runOnEdit: true,
        };
        /* Fresh-base serialized write — appends onto the server's CURRENT
           array, never a snapshot built when the form opened. */
        void mutateRegexScope({ scope: 'global' }, (arr) => [...arr, newSc])
            .then(() => {
                setAdding(false);
                setNewName('');
                setNewFind('');
                setNewReplace('');
                return full.reload();
            })
            .catch((e) => s.hint(`${t('stage.patch.failed')}: ${e instanceof Error ? e.message : String(e)}`, true))
            .finally(() => setBusyKey(null));
    };

    if (full.error) return <PanelError error={full.error} onRetry={full.reload} />;

    return (
        <div className="space-y-4">
            <div className="inset-group">
                {rows.map((r) => {
                    const name = typeof r.script.scriptName === 'string' && r.script.scriptName
                        ? r.script.scriptName
                        : t('studio.regex.unnamed');
                    const on = r.script.disabled !== true;
                    return (
                        <div key={r.key} className="inset-row gap-3">
                            <div className="min-w-0 flex-1">
                                <div className="truncate text-[13px] font-medium text-[color:var(--fg-primary)]">{name}</div>
                                <div className="mt-0.5 flex items-center gap-2 truncate text-[11.5px] text-[color:var(--fg-muted)]">
                                    <span>{r.scopeLabel}</span>
                                    {r.script.findRegex && (
                                        <span className="truncate font-mono-ui text-[10.5px] text-[color:var(--fg-faint)]">{r.script.findRegex}</span>
                                    )}
                                </div>
                            </div>
                            <div className="flex shrink-0 items-center gap-2">
                                <Switch on={on} disabled={busyKey === r.key} onToggle={() => toggleRow(r)} />
                                <button
                                    className="ghost-btn h-7 w-7"
                                    disabled={busyKey !== null}
                                    title={t('studio.persona.delete')}
                                    style={{ color: 'var(--status-danger)' }}
                                    onClick={() => removeRow(r)}
                                >
                                    <Icon name="trash" size={13} />
                                </button>
                            </div>
                        </div>
                    );
                })}
                {full.data && !rows.length && <PanelEmpty icon="code">{t('studio.regex.empty')}</PanelEmpty>}
                {!full.data && <PanelEmpty icon="code">…</PanelEmpty>}
            </div>

            {adding ? (
                <div className="inset-group space-y-2.5 p-3.5">
                    <input
                        value={newName}
                        onChange={(e) => setNewName(e.target.value)}
                        placeholder={t('studio.regex.namePh')}
                        className="h-8 w-full rounded-lg px-2.5 text-xs outline-none"
                        style={{ background: 'var(--bg-canvas)', color: 'var(--fg-primary)', border: '1px solid var(--border-hairline)' }}
                    />
                    <input
                        value={newFind}
                        onChange={(e) => setNewFind(e.target.value)}
                        placeholder="/pattern/g"
                        className="h-8 w-full rounded-lg px-2.5 font-mono-ui text-xs outline-none"
                        style={{ background: 'var(--bg-canvas)', color: 'var(--fg-primary)', border: '1px solid var(--border-hairline)' }}
                    />
                    <textarea
                        value={newReplace}
                        onChange={(e) => setNewReplace(e.target.value)}
                        placeholder={t('studio.regex.replacePh')}
                        rows={2}
                        className="w-full resize-none rounded-lg p-2.5 font-mono-ui text-xs outline-none"
                        style={{ background: 'var(--bg-canvas)', color: 'var(--fg-primary)', border: '1px solid var(--border-hairline)' }}
                    />
                    <div className="flex justify-end gap-2">
                        <button className="ghost-btn h-7 rounded-md px-2.5 text-[11.5px]" onClick={() => setAdding(false)}>{t('studio.persona.cancel')}</button>
                        <button
                            className="h-7 rounded-lg px-3 text-[11.5px] font-medium"
                            style={{ background: 'var(--primary-bg)', color: 'var(--primary-fg)', opacity: busyKey || !newName.trim() || !newFind.trim() ? 0.5 : 1 }}
                            disabled={busyKey !== null || !newName.trim() || !newFind.trim()}
                            onClick={createGlobal}
                        >
                            {t('studio.persona.save')}
                        </button>
                    </div>
                </div>
            ) : (
                <button
                    className="inset-row-btn flex w-full items-center justify-center gap-2 rounded-[10px] py-2.5 text-[12.5px] font-medium"
                    style={{ background: 'var(--bg-surface)', border: '1px dashed var(--border-strong)', color: 'var(--fg-secondary)' }}
                    disabled={!full.data}
                    onClick={() => setAdding(true)}
                >
                    <Icon name="plus" size={13} /> {t('studio.regex.newGlobal')}
                </button>
            )}
        </div>
    );
}

/* ------------------------------------------------------------------ */
/* 6. quickreplies —— QR 册管理(TASK-063 双向写面)                        */
/*   册 CRUD = named-docs PUT/DELETE;条目 label/message/启停 = 册档      */
/*   qrList 整档写回;绑定面 = quickReplyV2(全局/卡)+ chat_metadata        */
/*   (本会话)三 scope link 管理 —— link 在 = 已绑,isVisible = 亮。        */
/* ------------------------------------------------------------------ */

/** scope 芯片行:已绑 link 列(名 + 可见钮 + 摘绑)+ 未绑下拉补绑。 */
function QrScopeChips({ label, cfg, names, disabled, hint, onOp }: {
    label: ReactNode;
    cfg: QrConfig | null;
    names: string[];
    disabled?: boolean;
    hint?: string;
    onOp: (set: string, op: 'on' | 'off' | 'unbind') => void;
}) {
    const { t } = useI18n();
    const list = cfg?.setList ?? [];
    const unbound = names.filter((n) => !list.some((l) => l && l.set === n));
    return (
        <div className="inset-row flex-wrap items-center gap-1.5 py-2.5">
            <span className="w-16 shrink-0 text-[12px] text-[color:var(--fg-secondary)]">{label}</span>
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
                {list.map((l, i) => {
                    const nm = typeof l.set === 'string' ? l.set : '';
                    const on = l.isVisible !== false;
                    return (
                        <span key={`${nm}-${i}`} className="flex h-7 items-center gap-1 rounded-full border border-[color:var(--border-hairline)] bg-[color:var(--bg-surface)] pl-2.5 pr-1 text-[11.5px]">
                            <span className={on ? 'text-[color:var(--fg-primary)]' : 'text-[color:var(--fg-faint)] line-through'}>{nm || '—'}</span>
                            <button
                                type="button"
                                className="ghost-btn h-5 w-5 text-[color:var(--fg-faint)]"
                                title={t('studio.qr.bind.toggle')}
                                disabled={disabled}
                                onClick={() => onOp(nm, on ? 'off' : 'on')}
                            >
                                <Icon name={on ? 'eye' : 'eyeClosed'} size={11} />
                            </button>
                            <button
                                type="button"
                                className="ghost-btn h-5 w-5 text-[color:var(--fg-faint)]"
                                title={t('studio.qr.bind.unbind')}
                                disabled={disabled}
                                onClick={() => onOp(nm, 'unbind')}
                            >
                                <Icon name="x" size={11} />
                            </button>
                        </span>
                    );
                })}
                {unbound.length > 0 && !disabled && (
                    <select
                        className="h-7 rounded-full border border-dashed border-[color:var(--border-hairline)] bg-transparent px-2 text-[11.5px] text-[color:var(--fg-muted)]"
                        value=""
                        onChange={(e) => { if (e.target.value) onOp(e.target.value, 'on'); }}
                    >
                        <option value="">{t('studio.qr.bind.add')}</option>
                        {unbound.map((n) => <option key={n} value={n}>{n}</option>)}
                    </select>
                )}
                {list.length === 0 && unbound.length === 0 && (
                    <span className="text-[11px] text-[color:var(--fg-faint)]">{hint ?? t('studio.qr.bind.none')}</span>
                )}
                {disabled && hint && <span className="text-[11px] text-[color:var(--fg-faint)]">{hint}</span>}
            </div>
        </div>
    );
}

function QuickRepliesPage() {
    const { t } = useI18n();
    const s = useShell();
    const names = useRemote('qr:names', listQrSets);
    const [sel, setSel] = useState('');
    const [doc, setDoc] = useState<QrSetDoc | null>(null);
    const [draft, setDraft] = useState<QrSetDoc | null>(null);
    const [dirty, setDirty] = useState(false);
    /* Bindings doc + per-chat link doc come from the shared stores — the
       composer header and the automation panel toggle the SAME docs, so
       a scope write here can never revert a toggle made elsewhere. */
    const qrSnap = useQrSettings();
    const qr = qrSnap.doc;
    const chatCfgSnap = useQrChatCfg(s.chat?.charDir ?? null, s.chat?.chatName ?? null);
    const chatCfg = chatCfgSnap.doc;
    const [charKey, setCharKey] = useState('');
    const [busy, setBusy] = useState<string | null>(null);
    const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
    const [newName, setNewName] = useState('');
    const [renName, setRenName] = useState('');

    /* —— 取数:绑定档(settings)+ 本会话 link;深链落点 qrStudioFocus 消一次 —— */

    /* 名录 → 选中册:深链 > 现选留 > 首册。 */
    useEffect(() => {
        const ns = names.data ?? [];
        if (!ns.length) { setSel(''); return; }
        if (sel && ns.includes(sel)) return;
        const focus = qrStudioFocus.set;
        qrStudioFocus.set = null;
        setSel(focus && ns.includes(focus) ? focus : ns[0] ?? '');
    }, [names.data, sel]);

    /* 选中册 → 档进编辑稿;脏稿拦切换?—— 保持轻:切换直接弃稿(worldbook
       页同款语义,编辑器上的「未保存」徽是提醒不是锁)。 */
    useEffect(() => {
        if (!sel) { setDoc(null); setDraft(null); setDirty(false); return; }
        let dead = false;
        setDoc(null); setDraft(null); setDirty(false); setRenName(sel);
        getQrSet(sel)
            .then((d) => { if (!dead) { setDoc(d); setDraft(JSON.parse(JSON.stringify(d)) as QrSetDoc); } })
            .catch(() => { if (!dead) { setDoc(null); setDraft(null); } });
        return () => { dead = true; };
    }, [sel]);

    /* 卡 scope 默认键 = 当前会话的卡;无会话取卡表第一张。 */
    const cards = useMemo(() => [...s.cards.values()], [s.cards]);
    const chatCardKey = s.chat?.charDir
        ? qrCharScopeKey(s.cards.get(s.chat.charDir)?.avatar ?? null, s.chat.charDir)
        : '';
    useEffect(() => {
        if (charKey) return;
        if (chatCardKey) { setCharKey(chatCardKey); return; }
        const first = cards[0];
        if (first) setCharKey(qrCharScopeKey(first.avatar, first.charDir));
    }, [charKey, chatCardKey, cards]);

    /* —— 写面 —— */
    const flash = (ok: boolean, text: string) => setNote({ ok, text });
    const failText = (e: unknown) => (e instanceof Error ? e.message : String(e));

    const createSet = async () => {
        const nm = newName.trim();
        if (!nm || busy) return;
        if ((names.data ?? []).includes(nm)) { flash(false, t('studio.qr.exists')); return; }
        setBusy('new');
        try {
            /* Fresh exists-check — the names list is a snapshot; a set
               created elsewhere between fetch and save would be silently
               overwritten by the unconditional PUT upsert. */
            const existing = await getQrSet(nm).then(() => true).catch(() => false);
            if (existing) { flash(false, t('studio.qr.exists')); return; }
            await saveQrSet(nm, newQrSetDoc(nm));
            setNewName('');
            names.reload();
            setSel(nm);
        } catch (e) { flash(false, `${t('studio.qr.opFailed')} · ${failText(e)}`); }
        finally { setBusy(null); }
    };

    /** 摘绑:把册名从 settings 全域 link(global + 所有 characterConfigs)
        与 chat cfg 中摘净 —— 删册/改名共用,不留死链。 */
    const stripLinks = async (name: string, renameTo?: string) => {
        /* The rewrite runs inside the shared store: it applies onto the
           optimistic doc (which already contains other surfaces' pending
           toggles) instead of this page's private snapshot. */
        const rewrite = (cfg: QrConfig | undefined): QrConfig | undefined => {
            if (!cfg?.setList) return cfg;
            const list = cfg.setList
                .map((l) => (l && l.set === name ? (renameTo ? { ...l, set: renameTo } : null) : l))
                .filter((l): l is QrSetLink => l != null);
            return { ...cfg, setList: list };
        };
        mutateQrSettings((base) => {
            const next: QrSettings = { ...base, config: rewrite(base.config) };
            if (base.characterConfigs) {
                const cc: Record<string, QrConfig> = {};
                for (const [k, v] of Object.entries(base.characterConfigs)) {
                    const r = rewrite(v);
                    if (r) cc[k] = r;
                }
                next.characterConfigs = cc;
            }
            return next;
        });
        await flushQrSettings();
        if (s.chat && qrBound(chatCfg, name)) {
            mutateQrChatCfg(s.chat.charDir, s.chat.chatName, (base) => {
                const list = (base?.setList ?? [])
                    .map((l) => (l && l.set === name ? (renameTo ? { ...l, set: renameTo } : null) : l))
                    .filter((l): l is QrSetLink => l != null);
                return { ...(base ?? {}), setList: list };
            });
            await flushQrChatCfg(s.chat.charDir, s.chat.chatName);
        }
    };

    const deleteSet = async (name: string) => {
        if (busy || !window.confirm(t('studio.qr.delConfirm'))) return;
        setBusy('del');
        try {
            await deleteQrSet(name);
            await stripLinks(name);
            names.reload();
            if (sel === name) setSel('');
            flash(true, t('studio.qr.deleted'));
        } catch (e) { flash(false, `${t('studio.qr.opFailed')} · ${failText(e)}`); }
        finally { setBusy(null); }
    };

    const renameSet = async () => {
        const nm = renName.trim();
        if (!nm || !sel || nm === sel || busy) return;
        if ((names.data ?? []).includes(nm)) { flash(false, t('studio.qr.exists')); return; }
        setBusy('ren');
        try {
            const taken = await getQrSet(nm).then(() => true).catch(() => false);
            if (taken) { flash(false, t('studio.qr.exists')); return; }
            /* 改名 = 新名 PUT 现稿 → 旧名 DELETE → 全域 link 指向换新;
               脏稿随改名一起落(等价于先存再改,语义直白)。 */
            const body: QrSetDoc = { ...(draft ?? doc ?? newQrSetDoc(sel)), name: nm };
            await saveQrSet(nm, body);
            await deleteQrSet(sel);
            await stripLinks(sel, nm);
            names.reload();
            setSel(nm);
            flash(true, t('studio.qr.saved'));
        } catch (e) { flash(false, `${t('studio.qr.opFailed')} · ${failText(e)}`); }
        finally { setBusy(null); }
    };

    const editEntry = (i: number, patch: Partial<QrEntry>) => {
        setDraft((d) => {
            if (!d?.qrList) return d;
            const list = [...d.qrList];
            list[i] = { ...list[i], ...patch };
            return { ...d, qrList: list };
        });
        setDirty(true);
    };
    const addEntry = () => {
        setDraft((d) => {
            if (!d) return d;
            const idx = (d.idIndex ?? 0) + 1;
            const list = [...(d.qrList ?? []), { id: idx, label: '', message: '', isHidden: false, showLabel: true } as QrEntry];
            return { ...d, idIndex: idx, qrList: list };
        });
        setDirty(true);
    };
    const delEntry = (i: number) => {
        setDraft((d) => {
            if (!d?.qrList) return d;
            const list = [...d.qrList];
            list.splice(i, 1);
            return { ...d, qrList: list };
        });
        setDirty(true);
    };
    const saveDraft = async () => {
        if (!sel || !draft || busy) return;
        setBusy('save');
        try {
            /* 落盘前摘全空行(label+message 皆空 = 死钮);其余键透传。 */
            const body: QrSetDoc = {
                ...draft, name: sel,
                qrList: (draft.qrList ?? []).filter((q) => ((q.label ?? '') + (q.message ?? '')).trim().length > 0),
            };
            await saveQrSet(sel, body);
            setDoc(body); setDraft(JSON.parse(JSON.stringify(body)) as QrSetDoc); setDirty(false);
            flash(true, t('studio.qr.saved'));
        } catch (e) { flash(false, `${t('studio.qr.saveFailed')} · ${failText(e)}`); }
        finally { setBusy(null); }
    };

    /* scope link 写:global/char → settings 档;chat → chat_metadata ——
       all through the shared stores so a composer/automation toggle
       landing in between is merged, not reverted. */
    const scopeOp = async (scope: 'global' | 'char' | 'chat', set: string, op: 'on' | 'off' | 'unbind') => {
        if (busy) return;
        setBusy(`scope:${scope}:${set}`);
        try {
            if (scope === 'chat') {
                if (!s.chat) return;
                mutateQrChatCfg(s.chat.charDir, s.chat.chatName, (base) => qrConfigWithLink(base, set, op));
                await flushQrChatCfg(s.chat.charDir, s.chat.chatName);
                return;
            }
            mutateQrSettings((base) => {
                const next: QrSettings = { ...base };
                if (scope === 'global') {
                    next.config = qrConfigWithLink(base.config, set, op);
                } else {
                    const cc = { ...(base.characterConfigs ?? {}) };
                    cc[charKey] = qrConfigWithLink(cc[charKey], set, op);
                    next.characterConfigs = cc;
                }
                return next;
            });
            await flushQrSettings();
        } catch (e) { flash(false, `${t('studio.qr.opFailed')} · ${failText(e)}`); }
        finally { setBusy(null); }
    };

    /* —— 渲染 —— */
    const ns = names.data ?? [];
    const entries = draft?.qrList ?? [];
    if (names.error) return <PanelError error={names.error} onRetry={names.reload} />;
    return (
        <div className="space-y-5">
            {/* 册名录 + 新建 */}
            <div className="inset-group">
                <div className="inset-row items-center gap-2 py-2.5">
                    <input
                        className="min-w-0 flex-1 rounded-lg bg-transparent px-2 py-1 text-[12.5px] outline-none placeholder:text-[color:var(--fg-faint)]"
                        placeholder={t('studio.qr.newNamePh')}
                        value={newName}
                        onChange={(e) => setNewName(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') void createSet(); }}
                    />
                    <button
                        type="button"
                        className="h-7 shrink-0 rounded-lg px-2.5 text-[11.5px] font-medium transition-colors hover:bg-[color:var(--bg-active)]"
                        style={{ border: '1px solid var(--border-strong)', color: 'var(--fg-primary)' }}
                        disabled={busy === 'new' || !newName.trim()}
                        onClick={() => void createSet()}
                    >
                        {t('studio.qr.new')}
                    </button>
                </div>
                {!names.loading && ns.length === 0 && (
                    <div className="inset-row py-3">
                        <span className="text-[12px] text-[color:var(--fg-faint)]">{t('studio.qr.empty')} — {t('studio.qr.emptyDesc')}</span>
                    </div>
                )}
                {ns.map((n) => {
                    const on = sel === n;
                    return (
                        <div key={n} className="inset-row inset-row-btn items-center gap-2 py-2.5" style={on ? { background: 'var(--bg-active)' } : undefined} onClick={() => setSel(n)}>
                            <Icon name="zap" size={14} className="shrink-0 text-[color:var(--fg-muted)]" />
                            <span className="min-w-0 flex-1 truncate text-[13px] text-[color:var(--fg-primary)]">{n}</span>
                            {on && <Icon name="check" size={13} className="shrink-0 text-[color:var(--brand)]" />}
                            <button
                                type="button"
                                className="ghost-btn h-6 w-6 shrink-0 text-[color:var(--fg-faint)] hover:text-[color:var(--status-danger)]"
                                title={t('studio.qr.delete')}
                                onClick={(e) => { e.stopPropagation(); void deleteSet(n); }}
                            >
                                <Icon name="trash" size={13} />
                            </button>
                        </div>
                    );
                })}
            </div>

            {/* 绑定面:全局 / 卡 / 本会话 三 scope link 管理 */}
            <div className="inset-group">
                <div className="inset-row py-2.5">
                    <span className="text-[12px] font-medium text-[color:var(--fg-primary)]">{t('studio.qr.bind.title')}</span>
                </div>
                <QrScopeChips label={t('studio.qr.bind.global')} cfg={qr?.config ?? null} names={ns} disabled={!names.data} onOp={(st, op) => void scopeOp('global', st, op)} />
                <div className="inset-row flex-wrap items-center gap-1.5 py-2.5">
                    <span className="w-16 shrink-0 text-[12px] text-[color:var(--fg-secondary)]">{t('studio.qr.bind.char')}</span>
                    <select
                        className="h-7 max-w-[200px] rounded-lg border border-[color:var(--border-hairline)] bg-transparent px-2 text-[11.5px] text-[color:var(--fg-secondary)]"
                        value={charKey}
                        onChange={(e) => setCharKey(e.target.value)}
                    >
                        {cards.map((c) => {
                            const k = qrCharScopeKey(c.avatar, c.charDir);
                            return <option key={k} value={k}>{c.name || c.charDir}</option>;
                        })}
                    </select>
                </div>
                {charKey && (
                    <QrScopeChips label="" cfg={qr?.characterConfigs?.[charKey] ?? null} names={ns} disabled={!charKey} onOp={(st, op) => void scopeOp('char', st, op)} />
                )}
                <QrScopeChips
                    label={t('studio.qr.bind.chat')}
                    cfg={chatCfg}
                    names={ns}
                    disabled={!s.chat}
                    hint={s.chat ? (s.chat.chatName || undefined) : t('studio.qr.bind.noChat')}
                    onOp={(st, op) => void scopeOp('chat', st, op)}
                />
            </div>

            {/* 选中册内容编辑:册名 + 条目 label/message + 行启停 */}
            {draft && (
                <div className="space-y-3">
                    <div className="flex items-center gap-2">
                        <input
                            className="h-8 min-w-0 flex-1 rounded-lg bg-[color:var(--bg-surface)] px-2.5 text-[12.5px] outline-none"
                            style={{ border: '1px solid var(--border-hairline)' }}
                            value={renName}
                            onChange={(e) => setRenName(e.target.value)}
                        />
                        <button
                            type="button"
                            className="h-8 shrink-0 rounded-lg px-3 text-[12px] font-medium transition-colors hover:bg-[color:var(--bg-active)]"
                            style={{ border: '1px solid var(--border-strong)', color: 'var(--fg-primary)' }}
                            disabled={busy === 'ren' || !renName.trim() || renName.trim() === sel}
                            onClick={() => void renameSet()}
                        >
                            {t('studio.qr.rename')}
                        </button>
                    </div>
                    <div className="inset-group">
                        {entries.map((q, i) => (
                            <div key={q.id ?? i} className="inset-row flex-col items-stretch gap-1.5 py-2.5">
                                <div className="flex items-center gap-2">
                                    <input
                                        className="h-7 min-w-0 flex-1 rounded-md bg-transparent px-1.5 text-[12.5px] outline-none placeholder:text-[color:var(--fg-faint)]"
                                        placeholder={t('studio.qr.f.label')}
                                        value={q.label ?? ''}
                                        onChange={(e) => editEntry(i, { label: e.target.value })}
                                    />
                                    <Switch on={q.isHidden !== true} title={t('studio.qr.f.visible')} onToggle={() => editEntry(i, { isHidden: q.isHidden === true ? false : true })} />
                                    <button type="button" className="ghost-btn h-6 w-6 shrink-0 text-[color:var(--fg-faint)] hover:text-[color:var(--status-danger)]" title={t('studio.qr.f.delete')} onClick={() => delEntry(i)}>
                                        <Icon name="trash" size={13} />
                                    </button>
                                </div>
                                <textarea
                                    className="min-h-[52px] w-full resize-y rounded-md bg-transparent px-1.5 py-1 font-mono-ui text-[11.5px] leading-relaxed outline-none placeholder:text-[color:var(--fg-faint)]"
                                    placeholder={t('studio.qr.f.message')}
                                    value={q.message ?? ''}
                                    onChange={(e) => editEntry(i, { message: e.target.value })}
                                />
                            </div>
                        ))}
                        <div className="inset-row py-2">
                            <button type="button" className="flex items-center gap-1.5 text-[12px] text-[color:var(--fg-secondary)] transition-colors hover:text-[color:var(--fg-primary)]" onClick={addEntry}>
                                <Icon name="plus" size={13} />
                                {t('studio.qr.addEntry')}
                            </button>
                        </div>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                        <span className="text-[11.5px] text-[color:var(--fg-faint)]">
                            {dirty ? t('studio.qr.dirty') : ''}
                            {note && (
                                <span className="ml-2" style={{ color: note.ok ? 'var(--status-ok)' : 'var(--status-danger)' }}>{note.text}</span>
                            )}
                        </span>
                        <button
                            type="button"
                            className="h-8 shrink-0 rounded-lg px-4 text-[12.5px] font-medium"
                            style={{ background: 'var(--brand)', color: 'var(--brand-fg)', opacity: dirty ? 1 : 0.55 }}
                            disabled={!dirty || busy === 'save'}
                            onClick={() => void saveDraft()}
                        >
                            {t('studio.qr.save')}
                        </button>
                    </div>
                </div>
            )}
            {!draft && sel && names.data && (
                <PanelEmpty icon="zap" desc={t('studio.qr.loadWait')}>{sel}</PanelEmpty>
            )}
        </div>
    );
}

/* ------------------------------------------------------------------ */
/* StudioView 派发 + MobileHubView(端稿 renderMobileHubPage)              */
/* ------------------------------------------------------------------ */

export function StudioView() {
    const s = useShell();
    const nav = normStudioNav(s.studioNav);
    const body =
        nav === 'global' ? <GlobalPage /> :
        nav === 'worldbook' ? <WorldbookPage /> :
        nav === 'presets' ? <PresetsPage /> :
        nav === 'persona' ? <PersonaPage /> :
        nav === 'quickreplies' ? <QuickRepliesPage /> :
        <RegexPage />;
    return <StudioShell nav={nav} fill={nav === 'worldbook'}>{body}</StudioShell>;
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
    const studioCnts = useStudioCounts();
    const { slices } = useSettingsSlices();
    const goStudio = (nav: StudioNav) => { s.setStudioNav(nav); s.setView('studio', true); };
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
                {/* 1. hero:卡墙入口(2px bold + 叠卡头像)→ home 卡画廊,工坊不再藏卡库。 */}
                <button
                    className="flex w-full items-center justify-between gap-3 rounded-[12px] p-4 text-left transition-transform active:scale-[0.99]"
                    style={{ background: 'var(--bg-surface)', border: '2px solid var(--border-bold)', boxShadow: 'var(--shadow-card)' }}
                    onClick={() => s.setView('home')}
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
                            <div className="mt-1.5 text-[12.5px] text-[color:var(--fg-secondary)]">{t('mob.hub.worldbook')}</div>
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
                            <span className="font-mono-ui text-[11.5px] text-[color:var(--fg-muted)]">{studioCnts.regex}</span>
                            <span className="text-[color:var(--fg-faint)]"><Icon name="arrowRight" size={14} /></span>
                        </div>
                    </button>
                    <button className="inset-row inset-row-btn py-3" onClick={() => goStudio('quickreplies')}>
                        <div className="flex min-w-0 items-center gap-3">
                            <span className="text-[color:var(--fg-primary)]"><Icon name="zap" size={18} /></span>
                            <span className="truncate text-[13.5px] font-medium text-[color:var(--fg-primary)]">{t('studio.nav.quickreplies')}</span>
                        </div>
                        <div className="flex shrink-0 items-center gap-1.5">
                            <span className="font-mono-ui text-[11.5px] text-[color:var(--fg-muted)]">{studioCnts.quickreplies}</span>
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
