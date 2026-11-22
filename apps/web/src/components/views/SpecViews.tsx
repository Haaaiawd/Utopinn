// 规范稿视图体:home(资产画廊)。
// studio 六类页已迁至 views/studio.tsx(端稿 renderStudioMain —— 真 API 面),
// plugins 域迁至 views/plugins.tsx(真 /api/utopinn/plugins 面)。
// 走 view 贡献点注册;数据一律 useShell + SPEC-DATA mock。
import { useShell } from '../../kernel/context';
import { useI18n } from '../../i18n';
import { Icon } from '../Icon';
import { openCharEditor, openImportModal } from '../shell/overlayBus';
import { CardMasonry, CardTile } from '../CardTile';

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
                        <CardMasonry>
                            {cards.map((c) => {
                                const chat = s.chats.find((x) => x.charDir === c.charDir);
                                return (
                                    <CardTile
                                        key={c.charDir}
                                        card={c}
                                        sub={chat?.title ?? c.charDir}
                                        onOpen={() => s.openChar(c.charDir)}
                                    />
                                );
                            })}
                        </CardMasonry>
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
                    <CardMasonry>
                        {cards.map((c) => {
                            const chat = s.chats.find((x) => x.charDir === c.charDir && !x.id.startsWith('st-'));
                            const chatCount = s.chats.filter((x) => x.charDir === c.charDir && !x.id.startsWith('st-')).length;
                            return (
                                <CardTile
                                    key={c.charDir}
                                    card={c}
                                    sub={chat ? `${chat.title}${chatCount > 1 ? ` · ${chatCount} ${t('studio.cards.chats')}` : ''}` : `+ ${t('sidebar.newChat')}`}
                                    onOpen={() => s.openChar(c.charDir)}
                                    onEdit={() => openCharEditor(c.charDir)}
                                />
                            );
                        })}
                    </CardMasonry>
                )}
            </div>
        </div>
    );
}


