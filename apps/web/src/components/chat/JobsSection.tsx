// JobsSection — TASK-017 生成任务监视/回放面(diag 板块内一段)。
// 列表=/api/uberge/jobs 摘要;点行展开=详情(状态/文本回放/trace 分块数
// /sources 关键字段)。job 是服务端权威回放源 —— events 经 WS resume,
// 这里只画详情面有的东西。
import { useEffect, useState } from 'react';
import { getJob, listJobs, type JobDetail, type JobSummary } from '../../api/jobs';
import { useI18n } from '../../i18n';
import { Icon, type IconName } from '../Icon';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible';

const STATUS_ICON: Record<string, IconName> = {
    done: 'check', completed: 'check', failed: 'x', aborted: 'x',
    running: 'pulse', streaming: 'pulse', awaiting_ack: 'clock',
};

const statusIcon = (status: string): IconName => STATUS_ICON[status] ?? 'clock';

function JobRow({ job }: { job: JobSummary }) {
    const { t } = useI18n();
    const [detail, setDetail] = useState<JobDetail | null>(null);
    const [failed, setFailed] = useState(false);

    const load = () => {
        if (detail || failed) return;
        getJob(job.id).then(setDetail).catch(() => setFailed(true));
    };

    const collections = detail?.trace?.collections ?? [];
    const wi = detail?.sources?.worldInfo?.activated;
    const wiCount = Array.isArray(wi) ? wi.length : undefined;

    return (
        <Collapsible className="fold" onOpenChange={(o) => { if (o) load(); }}>
            <CollapsibleTrigger className="fold-trigger">
                <Icon name="chevronRight" size={12} className="fold-caret" />
                <Icon name={statusIcon(job.status)} size={11} />
                <span className="grow truncate">{job.textPreview || job.id.slice(0, 8)}</span>
                <span className="mut2">{job.status}</span>
            </CollapsibleTrigger>
            <CollapsibleContent className="fold-body">
                {failed && <p className="mut2">{t('diag.job.loadFailed')}</p>}
                {detail && (
                    <>
                        <dl className="diag-kv">
                            <dt>{t('diag.job.status')}</dt><dd>{detail.status}</dd>
                            <dt>{t('diag.job.persisted')}</dt><dd>{detail.persisted ? '✓' : '—'}</dd>
                            <dt>{t('diag.job.events')}</dt><dd>{detail.eventCount}</dd>
                            {detail.trace && (
                                <>
                                    <dt>{t('diag.budget')}</dt><dd>{detail.trace.budget ?? '—'}</dd>
                                    <dt>{t('diag.collections')}</dt><dd>{collections.length}</dd>
                                </>
                            )}
                            {wiCount != null && <dt>{t('diag.wi')}</dt>} {wiCount != null && <dd>{wiCount}</dd>}
                            {detail.error && <><dt>{t('diag.job.error')}</dt><dd className="err">{detail.error}</dd></>}
                        </dl>
                        {detail.text && (
                            <p className="mut" style={{ whiteSpace: 'pre-wrap', fontSize: 12, lineHeight: 1.7 }}>
                                {detail.text.length > 400 ? detail.text.slice(0, 400) + '…' : detail.text}
                            </p>
                        )}
                    </>
                )}
                {!detail && !failed && <p className="mut2">{t('diag.job.loading')}</p>}
            </CollapsibleContent>
        </Collapsible>
    );
}

export function JobsSection() {
    const { t } = useI18n();
    const [items, setItems] = useState<JobSummary[] | null>(null);
    const [failed, setFailed] = useState(false);

    useEffect(() => {
        let dead = false;
        listJobs()
            .then((r) => { if (!dead) setItems(r.items); })
            .catch(() => { if (!dead) setFailed(true); });
        return () => { dead = true; };
    }, []);

    if (failed) return null; // 端点缺席时整段诚实消失,不画空壳
    if (items == null) return null;
    if (items.length === 0) return null;

    return (
        <Collapsible className="fold" defaultOpen={false}>
            <CollapsibleTrigger className="fold-trigger">
                <Icon name="chevronRight" size={12} className="fold-caret" />
                {t('diag.jobs')}<span className="mut2">({items.length})</span>
            </CollapsibleTrigger>
            <CollapsibleContent className="fold-body">
                {items.slice(0, 8).map((j) => <JobRow key={j.id} job={j} />)}
            </CollapsibleContent>
        </Collapsible>
    );
}
