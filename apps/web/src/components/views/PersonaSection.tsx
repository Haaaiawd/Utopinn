// PersonaSection — 设置页的人设管理块(TASK-024)。
// 列表(头像缩略/名字/title/描述摘要/默认徽标)+ 就地编辑 + 新建 + 删除,
// 全部走 /api/utopinn/personas(avatar 文件名兼任主键,创建 = PUT 新 id)。
// 头像图按 ST 惯例拼 /thumbnail?type=persona;无图人设落 User 图标占位。
// 服务器不可达时回退 MOCK_PERSONAS + mock 徽标,写操作短路成提示。
import { useCallback, useEffect, useState } from 'react';
import { deletePersona, listPersonas, savePersona, type PersonaItem } from '../../api/personas';
import { MOCK_PERSONAS } from '../../api/mock';
import { useI18n } from '../../i18n';
import { useShell } from '../../kernel/context';
import { Icon } from '../Icon';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { IconButton } from '../ui/icon-button';
import { Input } from '../ui/input';
import { Textarea } from '../ui/textarea';

/** 编辑/新建共用一个 draft;mode 决定 PUT 到既有 avatar 还是生成新 id。 */
type FormState = { mode: 'create' } | { mode: 'edit'; avatar: string };

interface Draft {
    name: string;
    title: string;
    description: string;
}

const EMPTY_DRAFT: Draft = { name: '', title: '', description: '' };

/** ST 前端对 persona 头像的约定(getThumbnailUrl('persona', …))。 */
const personaThumb = (avatar: string) => `/thumbnail?type=persona&file=${encodeURIComponent(avatar)}`;

/** 头像缩略:dev 代理不转发 /thumbnail,404 → 回落 User 图标。 */
function PersonaAvatar({ p }: { p: PersonaItem }) {
    const [err, setErr] = useState(false);
    if (!p.hasImage || err) return <Icon name="user" size={15} />;
    return <img src={personaThumb(p.avatar)} alt="" loading="lazy" className="size-full object-cover"
        onError={() => setErr(true)} />;
}

export function PersonaSection() {
    const { t } = useI18n();
    const { hint } = useShell();
    const [items, setItems] = useState<PersonaItem[]>([]);
    const [mock, setMock] = useState(false);
    const [loaded, setLoaded] = useState(false);
    const [form, setForm] = useState<FormState | null>(null);
    const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
    const [busy, setBusy] = useState(false);

    const refresh = useCallback(async () => {
        try {
            const r = await listPersonas();
            setItems(r.items);
            setMock(false);
        } catch {
            setItems(MOCK_PERSONAS);
            setMock(true);
        } finally {
            setLoaded(true);
        }
    }, []);

    useEffect(() => { void refresh(); }, [refresh]);

    const startEdit = (p: PersonaItem) => {
        setForm({ mode: 'edit', avatar: p.avatar });
        setDraft({ name: p.name, title: p.title, description: p.description });
    };

    const startCreate = () => {
        setForm({ mode: 'create' });
        setDraft(EMPTY_DRAFT);
    };

    /** mock 态下所有写操作一律短路 —— 落不了盘,诚实提示。 */
    const writable = (): boolean => {
        if (!mock) return true;
        hint(t('common.mockData'), true);
        return false;
    };

    const submit = async () => {
        if (!form || busy) return;
        const name = draft.name.trim();
        if (!name) return;
        if (!writable()) return;
        const avatar = form.mode === 'edit' ? form.avatar : `persona-${Date.now()}.png`;
        setBusy(true);
        try {
            await savePersona(avatar, {
                name,
                title: draft.title.trim(),
                description: draft.description,
            });
            setForm(null);
            await refresh();
        } catch (e) {
            hint(`${t('persona.saveFailed')}: ${e instanceof Error ? e.message : e}`, true);
        } finally {
            setBusy(false);
        }
    };

    const setDefault = async (p: PersonaItem) => {
        if (!writable() || busy) return;
        setBusy(true);
        try {
            await savePersona(p.avatar, { is_default: true });
            await refresh();
        } catch (e) {
            hint(`${t('persona.saveFailed')}: ${e instanceof Error ? e.message : e}`, true);
        } finally {
            setBusy(false);
        }
    };

    const remove = async (p: PersonaItem) => {
        if (!writable() || busy) return;
        const msg = p.isDefault ? t('persona.deleteDefaultConfirm') : t('persona.deleteConfirm');
        if (!window.confirm(`${msg}\n${p.name || p.avatar}`)) return;
        setBusy(true);
        try {
            await deletePersona(p.avatar);
            if (form?.mode === 'edit' && form.avatar === p.avatar) setForm(null);
            await refresh();
        } catch (e) {
            hint(`${t('persona.deleteFailed')}: ${e instanceof Error ? e.message : e}`, true);
        } finally {
            setBusy(false);
        }
    };

    const formBox = (
        <div className="rounded-md border border-border bg-surface p-3">
            <div className="grid gap-2">
                <Input autoFocus value={draft.name} placeholder={t('persona.field.name')}
                    onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} />
                <Input value={draft.title} placeholder={t('persona.field.title')}
                    onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))} />
                <Textarea rows={3} value={draft.description} placeholder={t('persona.field.desc')}
                    onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))} />
                <div className="flex justify-end gap-2">
                    <Button variant="ghost" size="sm" onClick={() => setForm(null)}>{t('persona.cancel')}</Button>
                    <Button size="sm" disabled={busy || !draft.name.trim()} onClick={() => void submit()}>
                        {form?.mode === 'create' ? t('persona.create') : t('persona.save')}
                    </Button>
                </div>
            </div>
        </div>
    );

    return (
        <>
            <div className="sect-title">
                {t('persona.title')}
                {mock && <Badge variant="warning" className="ml-2">{t('common.mockData')}</Badge>}
            </div>
            <div className="card">
                <p className="mut" style={{ fontSize: 12, lineHeight: 1.8, marginTop: 0 }}>{t('persona.desc')}</p>
                <div className="grid gap-1">
                    {items.map((p) => (
                        form?.mode === 'edit' && form.avatar === p.avatar ? (
                            <div key={p.avatar}>{formBox}</div>
                        ) : (
                            <div key={p.avatar} className="group flex items-center gap-3 rounded-md px-2 py-2 hover:bg-bubble">
                                <span className="grid size-9 flex-none place-items-center overflow-hidden rounded-md bg-surface text-ink-2">
                                    <PersonaAvatar p={p} />
                                </span>
                                <span className="min-w-0 flex-1">
                                    <span className="flex items-center gap-2">
                                        <span className="truncate text-sm font-medium">{p.name || p.avatar}</span>
                                        {p.isDefault && <Badge variant="default">{t('persona.default')}</Badge>}
                                    </span>
                                    <span className="block truncate text-xs text-muted-foreground">
                                        {[p.title, p.description].filter(Boolean).join(' · ') || p.avatar}
                                    </span>
                                </span>
                                <span className="flex flex-none items-center opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                                    {!p.isDefault && (
                                        <IconButton label={t('persona.setDefault')} icon={<Icon name="check" size={14} />}
                                            onClick={() => void setDefault(p)} />
                                    )}
                                    <IconButton label={t('persona.edit')} icon={<Icon name="edit" size={14} />}
                                        onClick={() => startEdit(p)} />
                                    <IconButton label={t('persona.delete')} icon={<Icon name="x" size={14} />}
                                        className="hover:text-destructive" onClick={() => void remove(p)} />
                                </span>
                            </div>
                        )
                    ))}
                    {loaded && items.length === 0 && (
                        <div className="py-6 text-center text-sm text-muted-foreground">{t('persona.empty')}</div>
                    )}
                    {form?.mode === 'create' && formBox}
                </div>
                {form === null && (
                    <Button variant="outline" size="sm" className="mt-3" onClick={startCreate}>
                        <Icon name="plus" size={14} />{t('persona.new')}
                    </Button>
                )}
            </div>
        </>
    );
}
