// ImportView — 导入中心(TASK-016 web 面)。
// 入口三路:全局拖放(App 的 window drop → queueImport)、本页拖放/选文件、URL。
// 每个待办卡独立走 preview→commit 两段式;同名冲突显式选 rename|overwrite|skip。
// 服务端不可达 → 本地嗅探的 mock 预览(徽标诚实标注),提交禁按。
// 回执即历史:localStorage 持久化最近导入,行尾直达对应列表。
import { useCallback, useEffect, useRef, useState } from 'react';
import {
    bytesToBase64, commitImport, fileToDraft, ImportApiError, MAX_IMPORT_BYTES,
    nextDraftId, previewImportWithFallback,
    type ImportCommitResult, type ImportConflictPolicy, type ImportDraft,
    type ImportKind, type ImportPreviewResult, type ImportSummary,
} from '../../api/import';
import { useI18n } from '../../i18n';
import { useShell } from '../../kernel/context';
import { Icon, type IconName } from '../Icon';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { IconButton } from '../ui/icon-button';
import { Input } from '../ui/input';
import { ToggleGroup, ToggleGroupItem } from '../ui/toggle-group';

const HISTORY_KEY = 'utopinn.import.history';
const HISTORY_MAX = 30;

const KIND_ICON: Record<ImportKind, IconName> = {
    char: 'stories', world: 'rules', preset: 'settings', persona: 'user',
};

interface ImportRecord {
    name: string;
    kind: ImportKind;
    targetName: string;
    renamed: boolean;
    result: 'ok' | 'skipped' | 'failed';
    detail?: string;
    at: number;
}

function readHistory(): ImportRecord[] {
    try {
        const raw = localStorage.getItem(HISTORY_KEY);
        const list: unknown = raw ? JSON.parse(raw) : [];
        return Array.isArray(list)
            ? list.filter((r): r is ImportRecord => r != null && typeof r === 'object')
            : [];
    } catch { return []; }
}

function pushHistory(rec: ImportRecord): ImportRecord[] {
    const next = [rec, ...readHistory()].slice(0, HISTORY_MAX);
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(next)); } catch { /* storage full/blocked */ }
    return next;
}

function clearStoredHistory() {
    try { localStorage.removeItem(HISTORY_KEY); } catch { /* ignore */ }
}

/** 422 hints 对象 → 可读行(value 非字符串就 JSON 截断)。 */
function hintLines(hints?: Record<string, unknown>): string[] {
    if (!hints) return [];
    return Object.entries(hints).map(([k, v]) => {
        const val = typeof v === 'string' ? v : JSON.stringify(v);
        return `${k}: ${val.length > 160 ? `${val.slice(0, 160)}…` : val}`;
    });
}

/** kind+summary → 统计 chip 行(卡面清单纯列摘要,不执行)。 */
function SummaryChips({ kind, summary, targetName }: {
    kind: ImportKind; summary: ImportSummary; targetName: string;
}) {
    const { t } = useI18n();
    const chips: { icon: IconName; text: string }[] = [];
    chips.push({ icon: 'file', text: `${t('imp.sum.target')} ${targetName}` });
    if (summary.sourceFormat) chips.push({ icon: 'file', text: summary.sourceFormat });
    if (summary.spec) chips.push({ icon: 'check', text: summary.spec });
    if (kind === 'world') {
        chips.push({ icon: 'list', text: `${summary.entries ?? 0} ${t('imp.sum.entries')}` });
    }
    if (kind === 'preset') {
        chips.push({ icon: 'command', text: `${summary.prompts ?? 0} ${t('imp.sum.prompts')}` });
        if (summary.apiId) chips.push({ icon: 'settings', text: summary.apiId });
    }
    if (kind === 'persona') {
        chips.push({ icon: 'user', text: `${summary.descriptionLen ?? 0} ${t('imp.sum.descLen')}` });
        if (summary.title) chips.push({ icon: 'user', text: summary.title });
    }
    if (kind === 'char') {
        if ((summary.bookEntries ?? 0) > 0) chips.push({ icon: 'book', text: `${summary.bookEntries} ${t('imp.sum.book')}` });
        if ((summary.regexScripts ?? 0) > 0) chips.push({ icon: 'zap', text: `${summary.regexScripts} ${t('imp.sum.regex')}` });
        if ((summary.cardAppFiles ?? 0) > 0) chips.push({ icon: 'layout', text: `${summary.cardAppFiles} ${t('imp.sum.cardapp')}` });
        if (summary.depthPrompt) chips.push({ icon: 'layers', text: t('imp.sum.depth') });
        if (summary.boundWorld) chips.push({ icon: 'rules', text: `${t('imp.sum.bound')} ${summary.boundWorld}` });
        if ((summary.alternateGreetings ?? 0) > 0) chips.push({ icon: 'chat', text: `${summary.alternateGreetings} ${t('imp.sum.alt')}` });
        if (summary.avatar === 'bundled') chips.push({ icon: 'image', text: t('imp.sum.avatarBundled') });
    }
    const extra = [
        (summary.tags?.length ?? 0) > 0 ? summary.tags!.join(' · ') : '',
        summary.creator ? `${t('imp.sum.by')} ${summary.creator}` : '',
        (summary.regexScriptNames?.length ?? 0) > 0 ? summary.regexScriptNames!.join(' · ') : '',
    ].filter(Boolean);
    return (
        <div className="imp-stats">
            {chips.map((c, i) => (
                <span key={i} className="imp-stat"><Icon name={c.icon} size={11} />{c.text}</span>
            ))}
            {extra.map((line) => <span key={line} className="imp-stat-extra mut">{line}</span>)}
        </div>
    );
}

/** 单个待办卡:挂载即预览 → 冲突选项(如有)→ 提交回执/错误。 */
function ImportItemCard({ draft, onCommitted, onFailed, onRemove }: {
    draft: ImportDraft;
    onCommitted: (draft: ImportDraft, r: ImportCommitResult) => void;
    onFailed: (draft: ImportDraft, kind: ImportKind, msg: string) => void;
    onRemove: () => void;
}) {
    const { t } = useI18n();
    const { hint } = useShell();
    const [phase, setPhase] = useState<'previewing' | 'ready' | 'committing' | 'error'>('previewing');
    const [result, setResult] = useState<ImportPreviewResult | null>(null);
    const [policy, setPolicy] = useState<ImportConflictPolicy>('rename');
    /** 预览后才冒出的同名(commit 409)→ 就地展开策略行。 */
    const [raced, setRaced] = useState(false);
    const [commitErr, setCommitErr] = useState('');

    useEffect(() => {
        let dead = false;
        previewImportWithFallback(draft.name, draft.dataBase64)
            .then((r) => {
                if (dead) return;
                setResult(r);
                setPhase(r.data ? 'ready' : 'error');
            });
        return () => { dead = true; };
    }, [draft]);

    const p = result?.data ?? null;
    const mock = result?.mock === true;
    const conflicted = (p?.conflicts.existingSameName ?? false) || raced;
    const busy = phase === 'committing';

    const commit = async () => {
        if (!p || busy) return;
        setPhase('committing');
        setCommitErr('');
        try {
            const r = await commitImport({
                name: draft.name,
                dataBase64: draft.dataBase64,
                conflict: conflicted ? policy : undefined,
            });
            hint(r.skipped ? t('imp.res.skipped') : t('imp.done'));
            onCommitted(draft, r);
        } catch (e) {
            if (e instanceof ImportApiError && e.status === 409) {
                setRaced(true);
                setPhase('ready');
                hint(t('imp.conflict.need'), true);
                return;
            }
            const msg = e instanceof Error ? e.message : String(e);
            setCommitErr(msg);
            setPhase('ready');
            onFailed(draft, p.kind, msg);
        }
    };

    return (
        <div className="imp-item card">
            <div className="imp-item-head">
                {p && (
                    <span className="imp-kind">
                        <Icon name={KIND_ICON[p.kind]} size={11} />{t(`imp.kind.${p.kind}`)}
                    </span>
                )}
                <span className="imp-item-name">{p?.name || draft.name}</span>
                {p && p.name !== draft.name && <span className="imp-item-file mut">{draft.name}</span>}
                <span className="grow" />
                {mock && <Badge variant="warning">{t('common.mockData')}</Badge>}
                <IconButton label={t('imp.remove')} icon={<Icon name="x" size={13} />} onClick={onRemove} />
            </div>

            {phase === 'previewing' && <div className="imp-item-body mut">{t('imp.previewing')}</div>}

            {phase === 'error' && (
                <div className="imp-item-body">
                    <div className="err">{result?.error || draft.name}</div>
                    {hintLines(result?.hints).map((h) => <div key={h} className="imp-hint mut">{h}</div>)}
                </div>
            )}

            {p && phase !== 'error' && phase !== 'previewing' && (
                <div className="imp-item-body">
                    <SummaryChips kind={p.kind} summary={p.summary} targetName={p.targetName} />
                    {p.warnings.length > 0 && (
                        <div className="imp-warns">
                            {p.warnings.map((w) => (
                                <div key={w} className="imp-warn"><Icon name="warning" size={11} />{w}</div>
                            ))}
                        </div>
                    )}
                    {conflicted && (
                        <div className="imp-conflict">
                            <span className="imp-conflict-lbl">{t('imp.conflict.existing')} {p?.targetName}</span>
                            <ToggleGroup type="single" size="sm" value={policy}
                                onValueChange={(v) => v && setPolicy(v as ImportConflictPolicy)}>
                                <ToggleGroupItem value="rename">{t('imp.conflict.rename')}</ToggleGroupItem>
                                <ToggleGroupItem value="overwrite">{t('imp.conflict.overwrite')}</ToggleGroupItem>
                                <ToggleGroupItem value="skip">{t('imp.conflict.skip')}</ToggleGroupItem>
                            </ToggleGroup>
                        </div>
                    )}
                    {commitErr && <div className="err">{commitErr}</div>}
                    <div className="imp-acts">
                        <Button size="sm" disabled={busy || mock} onClick={() => void commit()}>
                            <Icon name="import" size={13} />{busy ? t('imp.committing') : t('imp.commit')}
                        </Button>
                        {mock && <span className="mut">{t('imp.needsServer')}</span>}
                    </div>
                </div>
            )}
        </div>
    );
}

export function ImportView() {
    const { t, locale } = useI18n();
    const {
        importDrafts, queueImport, dismissImportDraft,
        refreshCards, openCharacter, setView, hint,
    } = useShell();
    const [url, setUrl] = useState('');
    const [urlBusy, setUrlBusy] = useState(false);
    const [dragHot, setDragHot] = useState(false);
    const fileRef = useRef<HTMLInputElement>(null);
    const [history, setHistory] = useState<ImportRecord[]>(readHistory);

    const enqueue = useCallback(async (files: File[]) => {
        const drafts: ImportDraft[] = [];
        let skipped = 0;
        for (const f of files) {
            if (f.size > MAX_IMPORT_BYTES) { skipped += 1; continue; }
            drafts.push(await fileToDraft(f));
        }
        if (skipped) hint(t('imp.tooLarge'), true);
        if (drafts.length) queueImport(drafts);
    }, [queueImport, hint, t]);

    // 拖出窗口/松手都落回非 hot(真正收文件是 App 的 window drop,这里只画态)。
    useEffect(() => {
        const off = () => setDragHot(false);
        window.addEventListener('drop', off);
        window.addEventListener('dragend', off);
        return () => {
            window.removeEventListener('drop', off);
            window.removeEventListener('dragend', off);
        };
    }, []);

    /** 队列清空 → 落在导入物所属的列表(char→角色页,world→规则,余→设置)。 */
    const goHome = useCallback((r: ImportCommitResult) => {
        if (r.kind === 'char') openCharacter(r.targetName);
        else setView(r.kind === 'world' ? 'rules' : 'settings');
    }, [openCharacter, setView]);

    const handleCommitted = useCallback((draft: ImportDraft, r: ImportCommitResult) => {
        setHistory(pushHistory({
            name: r.name || draft.name, kind: r.kind, targetName: r.targetName,
            renamed: r.renamed, result: r.skipped ? 'skipped' : 'ok', at: Date.now(),
        }));
        dismissImportDraft(draft.id);
        if (r.kind === 'char' && !r.skipped) void refreshCards();
        // 队列还有未结的卡 → 留在中心继续收;清空了才跳对应列表。
        if (importDrafts.every((d) => d.id === draft.id)) goHome(r);
    }, [importDrafts, dismissImportDraft, refreshCards, goHome]);

    const handleFailed = useCallback((draft: ImportDraft, kind: ImportKind, msg: string) => {
        setHistory(pushHistory({
            name: draft.name, kind, targetName: draft.name,
            renamed: false, result: 'failed', detail: msg.slice(0, 200), at: Date.now(),
        }));
    }, []);

    const importUrl = useCallback(async () => {
        const raw = url.trim();
        if (!raw || urlBusy) return;
        let parsed: URL;
        try {
            parsed = new URL(raw);
        } catch {
            hint(t('imp.urlInvalid'), true);
            return;
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            hint(t('imp.urlInvalid'), true);
            return;
        }
        setUrlBusy(true);
        try {
            const res = await fetch(raw);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const buf = new Uint8Array(await res.arrayBuffer());
            if (!buf.length) throw new Error('empty response');
            if (buf.length > MAX_IMPORT_BYTES) throw new Error('too large');
            const name = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() ?? '') || 'import';
            queueImport([{ id: nextDraftId(), name, dataBase64: bytesToBase64(buf) }]);
            setUrl('');
        } catch (e) {
            hint(`${t('imp.urlFailed')}: ${e instanceof Error ? e.message : e}`, true);
        } finally {
            setUrlBusy(false);
        }
    }, [url, urlBusy, queueImport, hint, t]);

    const openRecord = useCallback((r: ImportRecord) => {
        if (r.kind === 'char') { void refreshCards(); openCharacter(r.targetName); }
        else setView(r.kind === 'world' ? 'rules' : 'settings');
    }, [refreshCards, openCharacter, setView]);

    const clearHistory = useCallback(() => {
        clearStoredHistory();
        setHistory([]);
    }, []);

    return (
        <div className="page-scroll lib imp">
            <div className="lib-head">
                <div className="lib-head-text">
                    <h1>{t('imp.title')}</h1>
                    <p className="mut">{t('imp.desc')}</p>
                </div>
            </div>

            <div className="imp-sources">
                <div className="imp-url">
                    <span className="imp-url-ic"><Icon name="link" size={14} /></span>
                    <Input value={url} placeholder={t('imp.urlPlaceholder')}
                        onChange={(e) => setUrl(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') void importUrl(); }} />
                    <Button variant="secondary" size="sm" disabled={urlBusy || !url.trim()}
                        onClick={() => void importUrl()}>
                        {urlBusy ? t('imp.urlBusy') : t('imp.urlGo')}
                    </Button>
                </div>
                {/* 拖放面:本体是 App 的 window drop;这块只做入口态 + 选文件。 */}
                <div className={`imp-drop${dragHot ? ' hot' : ''}`}
                    onClick={() => fileRef.current?.click()}
                    onDragEnter={(e) => { e.preventDefault(); setDragHot(true); }}
                    onDragOver={(e) => e.preventDefault()}
                    onDragLeave={() => setDragHot(false)}>
                    <Icon name="upload" size={22} />
                    <span>{t('imp.drop')}</span>
                    <span className="mut">{t('imp.formats')}</span>
                </div>
                <input ref={fileRef} type="file" multiple hidden
                    accept=".png,.webp,.json,.jsonl,.charx,.byaf"
                    onChange={(e) => {
                        void enqueue(Array.from(e.target.files ?? []));
                        e.target.value = '';
                    }} />
            </div>

            {importDrafts.length > 0 && (
                <>
                    <div className="lib-sect">
                        <h3>{t('imp.pending')}</h3>
                        <Badge variant="secondary">{importDrafts.length}</Badge>
                    </div>
                    <div className="imp-items">
                        {importDrafts.map((d) => (
                            <ImportItemCard key={d.id} draft={d}
                                onCommitted={handleCommitted}
                                onFailed={handleFailed}
                                onRemove={() => dismissImportDraft(d.id)} />
                        ))}
                    </div>
                </>
            )}

            <div className="lib-sect">
                <h3>{t('imp.history')}</h3>
                <span className="grow" />
                {history.length > 0 && (
                    <Button variant="ghost" size="sm" onClick={clearHistory}>
                        <Icon name="trash" size={13} />{t('imp.history.clear')}
                    </Button>
                )}
            </div>
            <div className="imp-hist">
                {history.map((r) => (
                    <div key={`${r.at}-${r.targetName}`} className="imp-hist-row" onClick={() => openRecord(r)}>
                        <span className="imp-kind">
                            <Icon name={KIND_ICON[r.kind]} size={11} />{t(`imp.kind.${r.kind}`)}
                        </span>
                        <span className="imp-hist-text">
                            <span className="imp-hist-name">{r.name}</span>
                            <span className="imp-hist-sub mut">
                                {r.result === 'failed' && r.detail ? r.detail : r.targetName}
                                {r.renamed ? ` · ${t('imp.renamed')}` : ''}
                            </span>
                        </span>
                        <span className={`imp-res${r.result === 'failed' ? ' err' : ''}${r.result === 'ok' ? ' ok' : ''}`}>
                            {t(`imp.res.${r.result}`)}
                        </span>
                        <span className="mut">{new Date(r.at).toLocaleDateString(locale === 'en' ? 'en' : 'zh-CN')}</span>
                        <Icon name="chevronRight" size={12} className="cp-chat-arrow" />
                    </div>
                ))}
                {history.length === 0 && <div className="lib-empty">{t('imp.history.empty')}</div>}
            </div>
        </div>
    );
}
