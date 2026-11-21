// 规范稿视图体:home(资产画廊)。
// studio 六类页已迁至 views/studio.tsx(端稿 renderStudioMain —— 真 API 面),
// plugins 域迁至 views/plugins.tsx(真 /api/utopinn/plugins 面)。
// 走 view 贡献点注册;数据一律 useShell + SPEC-DATA mock。
import { useShell } from '../../kernel/context';
import { useI18n } from '../../i18n';
import { Icon } from '../Icon';
import { charImageUrl } from '../../api/characters';
import { charImgFallback } from '../stage/StageFrame';
import { openImportModal } from '../shell/overlayBus';

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
        <div className="min-h-0 flex-1 overflow-y-auto p-6">
            <h1 className="heading-tight mb-1 text-title-lg text-[color:var(--fg-primary)]">{t('nav.home')}</h1>
            <p className="mb-5 text-[12px] text-[color:var(--fg-muted)]">{t('home.sub')}</p>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3">
                {cards.map((c) => {
                    const chat = s.chats.find((x) => x.charDir === c.charDir);
                    return (
                        <button
                            key={c.charDir}
                            className="inset-group inset-row-btn overflow-hidden text-left"
                            onClick={() => (chat ? s.selectChat(chat.id) : s.newChat(c.charDir))}
                        >
                            <div className="flex h-[150px] items-center justify-center bg-[color:var(--bg-active)] text-[28px]" style={{ color: 'var(--brand)' }}>
                                {c.avatar ? <img src={charImageUrl(c.avatar)} alt="" className="h-full w-full object-cover" onError={charImgFallback} /> : (c.name?.[0] ?? c.charDir[0])}
                            </div>
                            <div className="p-2.5">
                                <div className="truncate text-[12px] font-medium text-[color:var(--fg-primary)]">{c.name || c.charDir}</div>
                                <div className="mt-0.5 truncate text-[10px] text-[color:var(--fg-faint)]">{chat?.title ?? c.charDir}</div>
                            </div>
                        </button>
                    );
                })}
            </div>
            {s.cardsMock && <p className="mt-4 text-[10.5px] text-[color:var(--fg-faint)]">{t('common.mockData')}</p>}
        </div>
    );
}


