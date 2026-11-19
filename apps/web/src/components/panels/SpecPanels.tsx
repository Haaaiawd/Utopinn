// 规范稿七个板块目录的面本体(panel.type 贡献):
//   preset/mvu/notes 真交互(ctx 目录态),ledger = CardApp 宿主槽,
//   lore/chapters/channels mock(SPEC-DATA 标),session/diag 旧板块保留。
import { useI18n } from '../../i18n';
import { useShell } from '../../kernel/context';
import { Icon } from '../Icon';
import { CardAppFrame } from '../../cardapp/CardAppFrame';
import { MOCK_CHAPTERS, MOCK_CHANNELS, MOCK_LORE_ENTRIES } from '../../api/mock';

function Card({ children }: { children: React.ReactNode }) {
    return <div className="inset-group mb-2">{children}</div>;
}
function Row({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) {
    return onClick
        ? <button type="button" className="inset-row inset-row-btn" onClick={onClick}>{children}</button>
        : <div className="inset-row">{children}</div>;
}

/* —— preset:目录 + 激活态 + 温度(真:ctx.presets/activePreset) —— */
export function PresetPanel() {
    const { t } = useI18n();
    const { presets, activePresetId, setActivePreset } = useShell();
    return (
        <Card>
            {presets.map((p) => (
                <Row key={p.id} onClick={() => setActivePreset(p.id)}>
                    <span className="flex min-w-0 items-center gap-2">
                        <Icon name={p.id === activePresetId ? 'check' : 'zap'} size={13}
                            className={p.id === activePresetId ? 'text-[color:var(--brand)]' : 'text-[color:var(--fg-faint)]'} />
                        <span className="min-w-0">
                            <span className="block truncate text-[12px] text-[color:var(--fg-primary)]">{p.name}</span>
                            <span className="block truncate text-[10px] text-[color:var(--fg-faint)]">{p.desc} · T{p.temp}</span>
                        </span>
                    </span>
                    <span className="text-[10px] text-[color:var(--fg-faint)]">{p.updatedAt}</span>
                </Row>
            ))}
            <div className="inset-row"><span className="text-[10px] text-[color:var(--fg-faint)]">{t('panel.preset.mockNote')}</span></div>
        </Card>
    );
}

/* —— mvu:变量表 + 步进(真:ctx.mvu;SPEC-DATA 服务端同步) —— */
export function MvuPanel() {
    const { t } = useI18n();
    const { mvu, mvuStep, echoMvu } = useShell();
    return (
        <Card>
            <div className="px-3.5 pb-1 pt-3 text-[10px] font-medium text-[color:var(--fg-faint)]">{t('panel.mvu.vars')}</div>
            {Object.entries(mvu).map(([k, v]) => (
                <Row key={k}>
                    <span className="text-[12px] text-[color:var(--fg-secondary)]">{k}</span>
                    <span className="flex items-center gap-2">
                        {typeof v === 'number' && (
                            <>
                                <button type="button" className="ghost-btn h-5 w-5" onClick={() => mvuStep(k, -1)}><Icon name="minus" size={10} /></button>
                                <span className="font-mono-ui w-10 text-center text-[12px] text-[color:var(--fg-primary)]">{v}</span>
                                <button type="button" className="ghost-btn h-5 w-5" onClick={() => mvuStep(k, 1)}><Icon name="plus" size={10} /></button>
                            </>
                        )}
                        {typeof v !== 'number' && <span className="max-w-[140px] truncate text-[12px] text-[color:var(--fg-primary)]">{v}</span>}
                    </span>
                </Row>
            ))}
            <div className="inset-row">
                <span className="text-[10px] text-[color:var(--fg-faint)]">{echoMvu ? t('panel.mvu.echoed') : t('panel.mvu.mockNote')}</span>
            </div>
        </Card>
    );
}

/* —— notes:便签列表(本地态,真交互;SPEC-DATA 持久化) —— */
export function NotesPanel() {
    const { t } = useI18n();
    // SPEC-DATA: 待接 —— 服务端无便签端点,先本地 session 态
    const notes = [
        { id: 'n1', title: '归墟的钥匙 —— 追问来历', time: '今天 14:20' },
        { id: 'n2', title: '第 12 章要点:潮下之门开启条件', time: '昨天' },
        { id: 'n3', title: '灵感:把「过路费」写成记忆而非金币', time: '周一' },
    ];
    return (
        <Card>
            {notes.map((n) => (
                <Row key={n.id}>
                    <span className="min-w-0">
                        <span className="block truncate text-[12px] text-[color:var(--fg-primary)]">{n.title}</span>
                        <span className="block text-[10px] text-[color:var(--fg-faint)]">{n.time}</span>
                    </span>
                    <Icon name="chevronRight" size={12} className="text-[color:var(--fg-faint)]" />
                </Row>
            ))}
            <Row><span className="text-[10px] text-[color:var(--fg-faint)]">{t('panel.notes.mockNote')}</span></Row>
        </Card>
    );
}

/* —— ledger:CardApp 宿主槽(utopinn-th 面板位,真接线) —— */
export function LedgerPanel() {
    const { t } = useI18n();
    const { chat } = useShell();
    if (chat?.charDir) return <CardAppFrame charDir={chat.charDir} chatName={chat.chatName} />;
    return (
        <Card>
            <Row>
                <span className="text-[12px] text-[color:var(--fg-secondary)]">{t('panel.ledger.noChat')}</span>
            </Row>
        </Card>
    );
}

/* —— lore:世界书条目(mock,SPEC-DATA) —— */
export function LorePanel() {
    const { t } = useI18n();
    return (
        <Card>
            {MOCK_LORE_ENTRIES.map((e) => (
                <Row key={e.id}>
                    <span className="min-w-0">
                        <span className="block truncate text-[12px] text-[color:var(--fg-primary)]">{e.name}</span>
                        <span className="block truncate text-[10px] text-[color:var(--fg-faint)]">{e.keys} · {e.scope}</span>
                    </span>
                    <span className={`sh-switch ${e.enabled ? '' : 'opacity-60'}`} data-checked={e.enabled}><span className="sh-switch-thumb" /></span>
                </Row>
            ))}
            <Row><span className="text-[10px] text-[color:var(--fg-faint)]">{t('panel.lore.mockNote')}</span></Row>
        </Card>
    );
}

/* —— chapters:novel 章节(mock) —— */
export function ChaptersPanel() {
    const { t } = useI18n();
    return (
        <Card>
            {MOCK_CHAPTERS.map((c) => (
                <Row key={c.id}>
                    <span className="flex min-w-0 items-center gap-2">
                        <span className="font-mono-ui w-6 text-[10px] text-[color:var(--fg-faint)]">{c.n}</span>
                        <span className="min-w-0">
                            <span className={`block truncate text-[12px] ${c.active ? 'text-[color:var(--brand)]' : 'text-[color:var(--fg-primary)]'}`}>{c.title}</span>
                            <span className="block text-[10px] text-[color:var(--fg-faint)]">{c.words} {t('panel.chapters.words')}</span>
                        </span>
                    </span>
                    {c.active && <span className="h-1.5 w-1.5 rounded-full bg-[color:var(--brand)]" />}
                </Row>
            ))}
        </Card>
    );
}

/* —— channels:messenger 频道(mock) —— */
export function ChannelsPanel() {
    const { t } = useI18n();
    return (
        <Card>
            {MOCK_CHANNELS.map((c) => (
                <Row key={c.id}>
                    <span className="flex min-w-0 items-center gap-2 text-[12px]">
                        <span className="text-[color:var(--fg-faint)]">#</span>
                        <span className={c.active ? 'text-[color:var(--fg-primary)]' : 'text-[color:var(--fg-secondary)]'}>{c.name}</span>
                    </span>
                    {c.unread > 0 && <span className="rounded-full bg-[color:var(--brand)] px-1.5 text-[9px] text-white">{c.unread}</span>}
                </Row>
            ))}
            <Row><span className="text-[10px] text-[color:var(--fg-faint)]">{t('panel.channels.mockNote')}</span></Row>
        </Card>
    );
}
