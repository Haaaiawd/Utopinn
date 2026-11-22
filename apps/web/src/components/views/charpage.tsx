// 角色页 —— TASK-026 三级路径中层:卡格 → 本页 → 会话。
// 卡从「文件」变「故事」:封面 + greeting(first_mes)预览 + 该卡会话列表
// + 绑定资产读数(主绑书 extensions.world / 内嵌书 character_book /
// 辅书 charLore / 卡级正则,全部真接口,读不到照实空着不造假)。
// 数据:卡文档 loadCharDoc(共享缓存)、会话 listChatsForChar、
// 正则 getRegexFullView、辅书 settings.charLore —— 离线回落 ctx.chats 汇总。
import { useMemo } from 'react';
import { useShell } from '../../kernel/context';
import { useI18n } from '../../i18n';
import { Icon, type IconName } from '../Icon';
import { cardData, charImageUrl, loadCharDoc } from '../../api/characters';
import { listChatsForChar, type CharChatItem } from '../../api/chats';
import { getRegexFullView } from '../../api/regex';
import { getSettings } from '../../api/settings';
import { PanelEmpty, PanelError, useRemote } from '../panels/panelShared';
import { charImgFallback } from '../stage/StageFrame';
import { renderInline } from '../stage/prose';
import { openCharEditor } from '../shell/overlayBus';
import { relTime } from '../sidebar/trees';

/** updatedAt 兼容 number(ms)与 ISO 串;解析不了归 0 排尾。 */
const tsOf = (v: string | number | undefined): number => {
    if (v == null) return 0;
    const n = typeof v === 'number' ? v : Date.parse(v);
    return Number.isFinite(n) ? n : 0;
};

/** 卡文件大小 —— 读数小注(不足 1KB 照实 B)。 */
const fmtSize = (bytes: number): string =>
    bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
        : bytes >= 1024 ? `${(bytes / 1024).toFixed(0)} KB`
            : `${bytes} B`;

/** 资产 chip —— 有动作的是可点入口,纯读数渲 span(不假装能点)。 */
function AssetChip({ icon, label, title, onClick }: { icon: IconName; label: string; title?: string; onClick?: () => void }) {
    const cls = 'inline-flex max-w-[180px] items-center gap-1.5 rounded-full px-2.5 py-1 text-[11.5px] transition-colors';
    const style = { background: 'var(--bg-surface)', border: '1px solid var(--border-hairline)', color: 'var(--fg-secondary)' };
    if (onClick) {
        return (
            <button type="button" className={`${cls} hover:bg-[color:var(--bg-active)] hover:text-[color:var(--fg-primary)]`} style={style} title={title ?? label} onClick={onClick}>
                <Icon name={icon} size={12} /><span className="truncate">{label}</span>
            </button>
        );
    }
    return (
        <span className={cls} style={style} title={title ?? label}>
            <Icon name={icon} size={12} /><span className="truncate">{label}</span>
        </span>
    );
}

export function CharView() {
    const { t } = useI18n();
    const s = useShell();
    const dir = s.charDir;
    const card = dir ? s.cards.get(dir) : undefined;

    /* 三/四条取数互不相干:卡文档 / 会话列表 / 正则全量 / 辅书(settings)。
       离线一律不取(key=null) —— 空态如实,不拿 mock 糊窗。 */
    const docR = useRemote(dir && s.live ? `charpage:doc:${dir}` : null, () => loadCharDoc(dir!));
    const chatsR = useRemote(dir && s.live ? `charpage:chats:${dir}` : null, () => listChatsForChar(dir!).then((r) => r.items));
    const regexR = useRemote(dir && s.live ? 'regex:full' : null, getRegexFullView);
    const settingsR = useRemote(dir && s.live ? 'charpage:settings' : null, getSettings);

    const data = cardData(docR.data);
    const greeting = typeof data.first_mes === 'string' ? data.first_mes.trim() : '';
    const ext = data.extensions ?? {};
    const boundWorld = typeof ext.world === 'string' && ext.world ? ext.world : '';
    const book = data.character_book as { entries?: unknown } | undefined;
    const bookEntries = Array.isArray(book?.entries) ? book.entries.length
        : book?.entries && typeof book.entries === 'object' ? Object.keys(book.entries).length : 0;

    /* 辅书层:settings.world_info.charLore 里本卡条目的 extraBooks。 */
    const extraBooks = useMemo<string[]>(() => {
        const wi = (settingsR.data?.settings as Record<string, unknown> | undefined)?.world_info_settings as Record<string, unknown> | undefined;
        const wiInfo = wi?.world_info as { charLore?: { name?: unknown; extraBooks?: unknown }[] } | undefined;
        const lore = Array.isArray(wiInfo?.charLore) ? wiInfo.charLore : [];
        const hit = lore.find((l) => l?.name === dir);
        return Array.isArray(hit?.extraBooks) ? hit.extraBooks.filter((x): x is string => typeof x === 'string' && !!x) : [];
    }, [settingsR.data, dir]);

    /* 卡级正则读数:char scope 组 → 启用/总条数(0 条不画 chip,没东西不装)。 */
    const regexChar = useMemo(() => {
        const g = regexR.data?.chars.find((x) => x.charDir === dir);
        const scripts = g?.scripts ?? [];
        if (!scripts.length) return null;
        return { total: scripts.length, enabled: scripts.filter((x) => x.disabled !== true).length, allowed: g?.allowed !== false };
    }, [regexR.data, dir]);

    /* 会话行:真端点行优先;离线/取数失败回落 ctx.chats 汇总行(标 demo 同侧栏)。 */
    const rows = useMemo<(CharChatItem & { demo?: boolean })[]>(() => {
        const src: (CharChatItem & { demo?: boolean })[] = chatsR.data ?? s.chats
            .filter((c) => c.charDir === dir)
            .map((c) => ({
                name: c.chatName,
                messageCount: 0,
                updatedAt: c.updatedAt,
                demo: c.id.startsWith('st-') || c.id === 'c1' || c.id === 'c2',
            }));
        return [...src].sort((a, b) => tsOf(b.updatedAt) - tsOf(a.updatedAt));
    }, [chatsR.data, s.chats, dir]);

    if (!dir) {
        /* 无 charDir 直达 —— 诚实引导回卡面大厅,不捏造角色页。 */
        return (
            <section className="flex h-full min-w-0 flex-1 flex-col" style={{ background: 'var(--bg-canvas)' }}>
                <PanelEmpty icon="user" desc={t('charpage.nodir.desc')} action={{ label: t('nav.home'), onClick: () => s.setView('home') }}>
                    {t('charpage.nodir')}
                </PanelEmpty>
            </section>
        );
    }

    const name = data.name || card?.name || dir;
    const goStudio = (nav: string) => { s.setStudioNav(nav); s.setView('studio'); };

    return (
        <section className="flex h-full min-w-0 flex-1 flex-col" style={{ background: 'var(--bg-canvas)' }}>
            {/* 页头:返回卡面大厅(移动端 gotoView 把 home 映射回 chat)+ 标题 + 动作 */}
            <header className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-[color:var(--border-hairline)] px-4">
                <div className="flex min-w-0 items-center gap-1.5">
                    {s.isMobile && (
                        <button className="ghost-btn h-8 w-8 shrink-0" onClick={() => s.setMobileDrawer(true)} title={t('mob.menu')}>
                            <Icon name="menu" size={20} />
                        </button>
                    )}
                    <button
                        className="heading-tight flex min-w-0 items-center gap-1.5 rounded-lg px-2 py-1.5 text-[13.5px] font-medium transition-colors hover:bg-[color:var(--bg-surface)]"
                        onClick={() => s.setView('home')}
                        title={t('nav.home')}
                    >
                        <Icon name="chevronLeft" size={15} />
                        <span className="truncate text-[color:var(--fg-primary)]">{t('nav.home')}</span>
                    </button>
                    <span className="shrink-0 text-[color:var(--fg-faint)]">/</span>
                    <span className="heading-tight truncate text-[13.5px] font-medium text-[color:var(--fg-primary)]">{name}</span>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                    <button
                        className="ghost-btn h-8 gap-1.5 border border-[color:var(--border-hairline)] bg-[color:var(--bg-surface)] px-2.5 text-[12px] text-[color:var(--fg-secondary)]"
                        style={{ borderRadius: 10 }}
                        onClick={() => openCharEditor(dir)}
                        title={t('charpage.edit')}
                    >
                        <Icon name="pencil" size={14} /><span className="hidden sm:inline">{t('charpage.edit')}</span>
                    </button>
                    <button
                        className="flex h-8 items-center gap-1.5 rounded-lg px-3 text-[12.5px] font-medium transition-opacity hover:opacity-90"
                        style={{ background: 'var(--brand)', color: 'var(--brand-fg)' }}
                        onClick={() => s.newChat(dir)}
                    >
                        <Icon name="plus" size={14} /><span className="hidden sm:inline">{t('sidebar.newChat')}</span>
                    </button>
                </div>
            </header>

            <div className="scroll-fade-mask min-h-0 flex-1 overflow-y-auto px-5 py-6 sm:px-8">
                <div className="mx-auto max-w-3xl space-y-8 pb-8">
                    {/* ——— 封面 + 元信息 ——— */}
                    <div className="flex items-start gap-5">
                        <div className={`relative shrink-0 overflow-hidden rounded-[14px] border border-[color:var(--border-hairline)] bg-[color:var(--bg-surface)] ${s.isMobile ? 'h-36 w-24' : 'h-48 w-32'}`} style={{ boxShadow: 'var(--shadow-card)' }}>
                            {card?.avatar ? (
                                <img src={charImageUrl(card.avatar)} alt={name} className="h-full w-full object-cover" onError={charImgFallback} />
                            ) : (
                                <img src="/assets/avatars/default-char.png" alt="" className="h-full w-full object-cover opacity-80" />
                            )}
                        </div>
                        <div className="min-w-0 flex-1 space-y-2.5 pt-0.5">
                            <h1 className="heading-tight truncate text-[20px] font-semibold text-[color:var(--fg-primary)]">{name}</h1>
                            <div className="font-mono-ui text-[11.5px] text-[color:var(--fg-muted)]">
                                {card ? `${card.fileName} · ${fmtSize(card.fileSize)}` : dir}
                                {!card?.readable && card ? <span style={{ color: 'var(--status-danger)' }}> · {t('studio.cards.unreadable')}</span> : null}
                            </div>
                            {docR.error && (
                                <div className="rounded-lg px-2.5 py-1.5 font-mono-ui text-[10.5px]" style={{ background: 'var(--bg-surface)', color: 'var(--status-danger)' }}>
                                    {t('charpage.docFailed')}: {docR.error}
                                </div>
                            )}
                            {(card?.tags?.length ?? data.tags?.length ?? 0) > 0 && (
                                <div className="flex flex-wrap gap-1.5">
                                    {(card?.tags?.length ? card.tags : (data.tags ?? [])).map((tag) => (
                                        <span key={tag} className="rounded-full bg-[color:var(--bg-active)] px-2 py-0.5 text-[10.5px] text-[color:var(--fg-secondary)]">{tag}</span>
                                    ))}
                                </div>
                            )}
                            {/* 绑定资产 —— 全真读数:主绑书/内嵌书/辅书/卡级正则 */}
                            {(boundWorld || bookEntries > 0 || extraBooks.length > 0 || regexChar) && (
                                <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                                    {boundWorld && <AssetChip icon="bookOpen" label={boundWorld} title={t('charpage.chip.world')} onClick={() => goStudio('worldbook')} />}
                                    {bookEntries > 0 && <AssetChip icon="book" label={`${t('charpage.chip.embedded')} ×${bookEntries}`} title={t('charpage.chip.embedded.t')} onClick={() => openCharEditor(dir)} />}
                                    {extraBooks.length > 0 && <AssetChip icon="layers" label={`${t('charpage.chip.extraBooks')} ×${extraBooks.length}`} title={extraBooks.join(' · ')} onClick={() => goStudio('worldbook')} />}
                                    {regexChar && (
                                        <AssetChip
                                            icon="code"
                                            label={`${t('studio.nav.regex')} ×${regexChar.enabled}/${regexChar.total}`}
                                            title={regexChar.allowed ? t('charpage.chip.regex') : t('charpage.chip.regex.off')}
                                            onClick={() => goStudio('regex')}
                                        />
                                    )}
                                </div>
                            )}
                        </div>
                    </div>

                    {/* ——— greeting 预览:first_mes 过 prose 惯例同源渲染 ——— */}
                    {greeting && (
                        <div className="space-y-2.5">
                            <div className="text-[11px] font-medium text-[color:var(--fg-muted)]">{t('charpage.greeting')}</div>
                            <div
                                className="chat-body-text max-h-64 overflow-y-auto rounded-[14px] px-4 py-3.5 text-[13.5px] leading-relaxed whitespace-pre-line"
                                style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-hairline)', color: 'var(--fg-secondary)' }}
                            >
                                {renderInline(greeting)}
                            </div>
                        </div>
                    )}

                    {/* ——— 会话列表(三级路径第三跳:点行才进会话)——— */}
                    <div className="space-y-2.5">
                        <div className="flex items-center justify-between">
                            <div className="text-[11px] font-medium text-[color:var(--fg-muted)]">
                                {t('pane.chat')}{rows.length > 0 ? ` · ${rows.length}` : ''}
                            </div>
                            <button
                                className="flex items-center gap-1 rounded-md px-2 py-1 text-[11.5px] text-[color:var(--fg-secondary)] transition-colors hover:bg-[color:var(--bg-surface)] hover:text-[color:var(--fg-primary)]"
                                onClick={() => s.newChat(dir)}
                            >
                                <Icon name="plus" size={12} />{t('sidebar.newChat')}
                            </button>
                        </div>
                        {chatsR.error && s.live && (
                            <PanelError error={chatsR.error} onRetry={chatsR.reload} />
                        )}
                        {rows.length === 0 && !chatsR.error ? (
                            <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-[color:var(--border-strong)] px-6 py-10 text-center">
                                <div className="text-[13px] font-medium text-[color:var(--fg-secondary)]">{t('charpage.chats.empty')}</div>
                                <div className="mt-1 max-w-[280px] text-[11.5px] leading-relaxed text-[color:var(--fg-muted)]">{t('charpage.chats.emptyDesc')}</div>
                                <button
                                    className="mt-4 h-8 rounded-lg px-4 text-[12.5px] font-medium"
                                    style={{ background: 'var(--brand)', color: 'var(--brand-fg)' }}
                                    onClick={() => s.newChat(dir)}
                                >
                                    + {t('sidebar.newChat')}
                                </button>
                            </div>
                        ) : (
                            <div className="inset-group">
                                {rows.map((r) => {
                                    const last = typeof r.lastMessage?.mes === 'string' ? r.lastMessage.mes.trim() : '';
                                    return (
                                        <button
                                            key={r.name}
                                            type="button"
                                            className="inset-row inset-row-btn flex w-full items-center gap-3 text-left"
                                            onClick={() => s.selectChat(`${dir}/${r.name}`)}
                                        >
                                            <div className="min-w-0 flex-1">
                                                <div className="flex items-baseline gap-2">
                                                    <span className="truncate text-[13px] font-medium text-[color:var(--fg-primary)]">{r.name}</span>
                                                    {r.demo && <span className="shrink-0 font-mono-ui text-[10px] uppercase text-[color:var(--fg-faint)]">{t('chat.demo')}</span>}
                                                </div>
                                                {last && <div className="mt-0.5 truncate text-[11.5px] text-[color:var(--fg-muted)]">{last}</div>}
                                            </div>
                                            <div className="flex shrink-0 flex-col items-end gap-0.5">
                                                <span className="font-mono-ui text-[11px] text-[color:var(--fg-faint)]">
                                                    {relTime(typeof r.updatedAt === 'number' ? new Date(r.updatedAt).toISOString() : r.updatedAt)}
                                                </span>
                                                {r.messageCount > 0 && <span className="font-mono-ui text-[10.5px] text-[color:var(--fg-faint)]">{r.messageCount} {t('charpage.floors')}</span>}
                                            </div>
                                        </button>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </section>
    );
}
