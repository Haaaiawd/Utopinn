// 规范稿视图体:home(资产画廊)。
// studio 六类页已迁至 views/studio.tsx(端稿 renderStudioMain —— 真 API 面),
// plugins 域迁至 views/plugins.tsx(真 /api/utopinn/plugins 面)。
// 走 view 贡献点注册;数据一律 useShell + SPEC-DATA mock。
import { useShell } from '../../kernel/context';
import { useI18n } from '../../i18n';
import { Icon } from '../Icon';
import { charImageUrl } from '../../api/characters';
import { charImgFallback } from '../stage/StageFrame';
import { openCharEditor, openImportModal } from '../shell/overlayBus';

/** home:卡画廊 —— 点击卡面选中该卡最新会话(规范稿画廊网格)。
 *  移动端按规范稿 renderHomeGallery(true):h-12 头(menu + 标题 + 导入钮)
 *  + 「继续你的故事」hero + 16/11 封面砖(渐变压底,卡名·会话题叠字)。 */
export function HomeView() {
    const { t } = useI18n();
    const s = useShell();
    const cards = [...s.cards.values()];
    if (s.isMobile) {
        return (
            <section className="flex h-full min-w-0 flex-1 flex-col" style={{ background: 'var(--bg-canvas)' }}>
                <header className="flex h-12 shrink-0 items-center justify-between border-b border-[color:var(--border-hairline)] px-4">
                    <div className="flex items-center gap-2">
                        <button className="ghost-btn h-8 w-8" onClick={() => s.setMobileDrawer(true)} title={t('mob.menu')}><Icon name="menu" size={20} /></button>
                        <span className="heading-tight text-[13.5px] font-medium text-[color:var(--fg-primary)]">{t('nav.home')}</span>
                    </div>
                    <button
                        className="rounded-lg border border-[color:var(--border-hairline)] bg-[color:var(--bg-surface)] px-3 py-1 text-[12px] text-[color:var(--fg-secondary)] transition-colors hover:bg-[color:var(--bg-surface-hover)]"
                        onClick={openImportModal}
                    >
                        + {t('ov.import.short')}{t('mob.hub.cards')}
                    </button>
                </header>
                <div className="scroll-fade-mask min-h-0 flex-1 overflow-y-auto px-5 py-6">
                    <div className="mx-auto max-w-3xl space-y-8">
                        <div className="pt-2"><h1 className="heading-tight text-[24px] font-medium text-[color:var(--fg-primary)]">{t('home.hero')}</h1></div>
                        <div className="grid grid-cols-1 gap-3.5">
                            {cards.map((c) => {
                                const chat = s.chats.find((x) => x.charDir === c.charDir);
                                return (
                                    <button
                                        key={c.charDir}
                                        className="group relative aspect-[16/11] overflow-hidden rounded-[12px] border border-[color:var(--border-hairline)] text-left"
                                        onClick={() => (chat ? s.selectChat(chat.id) : s.newChat(c.charDir))}
                                    >
                                        {c.avatar
                                            ? <img src={charImageUrl(c.avatar)} alt="" className="absolute inset-0 h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.03]" onError={charImgFallback} />
                                            : <span className="absolute inset-0 flex items-center justify-center bg-[color:var(--bg-active)] text-[28px] text-[color:var(--brand)]">{c.name?.[0] ?? c.charDir[0]}</span>}
                                        <span className="absolute inset-0" style={{ background: 'linear-gradient(180deg, rgba(8,9,10,0.04) 0%, rgba(8,9,10,0.22) 48%, rgba(8,9,10,0.90) 100%)' }} />
                                        <span className="absolute bottom-3.5 left-4 right-4">
                                            <span className="heading-tight block truncate text-[14px] font-medium text-white">{c.name || c.charDir}</span>
                                            <span className="mt-0.5 block truncate text-[12px] text-white/65">{chat?.title ?? c.charDir}</span>
                                        </span>
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                </div>
            </section>
        );
    }
    return (
        <div className="min-h-0 flex-1 overflow-y-auto px-8 py-7">
            <div className="mx-auto max-w-5xl">
                <div className="mb-6 flex items-center justify-between gap-4">
                    <div>
                        <h1 className="heading-tight text-[20px] font-semibold text-[color:var(--fg-primary)]">{t('nav.home')}</h1>
                        <p className="mt-1 text-[12.5px] text-[color:var(--fg-muted)]">
                            {cards.length} {t('mob.hub.cardsN')} · {t('home.hero')}
                        </p>
                    </div>
                    <button
                        className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-3.5 text-[12.5px] font-medium transition-opacity hover:opacity-90"
                        style={{ background: 'var(--brand)', color: 'var(--brand-fg)' }}
                        onClick={openImportModal}
                    >
                        <Icon name="import" size={15} />
                        <span>{t('ov.import.short')}</span>
                    </button>
                </div>
                {cards.length === 0 ? (
                    <div className="flex min-h-[260px] flex-col items-center justify-center rounded-2xl border border-dashed border-[color:var(--border-strong)] p-8 text-center">
                        <div className="text-[13.5px] font-medium text-[color:var(--fg-secondary)]">{t('studio.cards.empty')}</div>
                        <button
                            className="mt-4 h-8 rounded-lg px-4 text-[12.5px] font-medium"
                            style={{ background: 'var(--brand)', color: 'var(--brand-fg)' }}
                            onClick={openImportModal}
                        >
                            + {t('ov.import.short')}
                        </button>
                    </div>
                ) : (
                    <div className="grid grid-cols-[repeat(auto-fill,minmax(188px,1fr))] gap-4">
                        {cards.map((c) => {
                            const chat = s.chats.find((x) => x.charDir === c.charDir && !x.id.startsWith('st-'));
                            const chatCount = s.chats.filter((x) => x.charDir === c.charDir && !x.id.startsWith('st-')).length;
                            return (
                                <div
                                    key={c.charDir}
                                    className="group relative aspect-[3/4] overflow-hidden rounded-[14px] border border-[color:var(--border-hairline)] bg-[color:var(--bg-surface)] text-left transition-all hover:border-[color:var(--border-strong)]"
                                    style={{ boxShadow: 'var(--shadow-card)' }}
                                >
                                    <button
                                        type="button"
                                        className="absolute inset-0 h-full w-full text-left"
                                        onClick={() => (chat ? s.selectChat(chat.id) : s.newChat(c.charDir))}
                                    >
                                        {c.avatar ? (
                                            <img
                                                src={charImageUrl(c.avatar)}
                                                alt={c.name || c.charDir}
                                                className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.03]"
                                                onError={charImgFallback}
                                            />
                                        ) : (
                                            <img
                                                src="/assets/avatars/default-char.png"
                                                alt=""
                                                className="h-full w-full object-cover opacity-80"
                                            />
                                        )}
                                        <span
                                            className="absolute inset-0"
                                            style={{ background: 'linear-gradient(180deg, rgba(8,9,10,0.02) 0%, rgba(8,9,10,0.18) 52%, rgba(8,9,10,0.92) 100%)' }}
                                        />
                                        <span className="absolute bottom-3.5 left-3.5 right-3.5">
                                            <span className="heading-tight block truncate text-[14.5px] font-semibold text-white">{c.name || c.charDir}</span>
                                            <span className="mt-0.5 block truncate text-[11.5px] text-white/70">
                                                {chat ? `${chat.title}${chatCount > 1 ? ` · ${chatCount} ${t('studio.cards.chats')}` : ''}` : `+ ${t('sidebar.newChat')}`}
                                            </span>
                                        </span>
                                    </button>
                                    <button
                                        type="button"
                                        title={t('studio.cards.detail')}
                                        onClick={(e) => { e.stopPropagation(); openCharEditor(c.charDir); }}
                                        className="absolute right-2.5 top-2.5 flex h-7 w-7 items-center justify-center rounded-lg opacity-0 transition-opacity group-hover:opacity-100"
                                        style={{ background: 'rgba(14,15,18,0.68)', color: '#fff', backdropFilter: 'blur(6px)' }}
                                    >
                                        <Icon name="pencil" size={13} />
                                    </button>
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>
        </div>
    );
}


