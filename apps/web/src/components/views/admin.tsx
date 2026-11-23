// 管理面板视图(TASK-052 刀1):
//   · AdminTree —— 侧栏分区索引(按桶排:实例·总览 / 访问·账号+服务端配置)+ 内核插件域深链
//   · AdminView —— 移动端落 mob.view.noMobile 占位;桌面渲染三区:
//       1) 总览(Overview):实例/内核/存储引擎/数据根/多 handle 概览/上游连接探测 +
//          内核 vs Luker Server Plugins 两套插件体系视觉分家 + 安全待办
//       2) 账号(Users):多 handle 生命周期(列/建含 slugify 预览/改名/改密/配额/启停/升降权/删含 purge),
//          危险动作(停用/降权/删除)全部二次确认;不做「以 handle 身份游玩」
//       3) 服务端配置(Config):访问控制表单 ↔ config.yaml 原文同源双写 + 安全闸回显 +
//          保存二次确认 + admin settings(默认配额/注册开关/折叠 OAuth)
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useShell } from '../../kernel/context';
import { useI18n } from '../../i18n';
import { Icon, type IconName } from '../Icon';
import { PanelEmpty, PanelError, useRemote } from '../panels/panelShared';
import { WiredBadge } from './studio';
import { pluginLabel } from './plugins';
import {
    ConfigSaveError,
    createUserHandle,
    deleteUserHandle,
    demoteUserHandle,
    disableUserHandle,
    enableUserHandle,
    getAdminOverview,
    getAdminSettings,
    getKernelSnapshot,
    getServerConfig,
    getStorageHealth,
    getStorageStatus,
    isAdminForbidden,
    listAdminUsers,
    listLukerServerPlugins,
    listSharedSecrets,
    probeUpstreamConnection,
    promoteSharedSecret,
    promoteUserHandle,
    rotateSharedSecret,
    saveAdminSettings,
    saveServerConfig,
    setSharedSecretVisibility,
    setUserQuota,
    slugifyHandle,
    writeSharedSecret,
    deleteSharedSecret,
    type AdminOverview,
    type AdminSettings,
    type AdminUserItem,
    type ConfigDocument,
    type ConnectionProbeResult,
    type KernelSnapshot,
    type LukerServerPluginsList,
    type SharedSecretEntry,
    type SharedSecretMode,
    type StorageHealth,
    type StorageStatus,
} from '../../api/admin';
import { listSecrets } from '../../api/secrets';
import { changeUserName, changeUserPassword, getMe, type CurrentUser } from '../../api/account';
import { listPlugins, type PluginItem } from '../../api/plugins';
import { diagStats, type DiagBusStats } from '../../api/diag';
import { getSettings } from '../../api/settings';
import {
    diffCriticalConfigKeys,
    formatBytes,
    formatUptime,
    parseConfigSummary,
    setYamlTopBool,
    type ConfigAccessFlags,
} from '../../lib/yamlConfig';

/* ------------------------------------------------------------------ */
/* 分区定义(刀1 三区)                                                   */
/* ------------------------------------------------------------------ */

export const ADMIN_NAVS = ['overview', 'users', 'keys', 'config'] as const;
export type AdminNav = (typeof ADMIN_NAVS)[number];

const ADMIN_BUCKETS: {
    bucketKey: string;
    items: { id: AdminNav; icon: IconName }[];
}[] = [
    {
        bucketKey: 'admin.bucket.instance',
        items: [{ id: 'overview', icon: 'pulse' }],
    },
    {
        bucketKey: 'admin.bucket.access',
        items: [
            { id: 'users', icon: 'user' },
            { id: 'keys', icon: 'shield' },
            { id: 'config', icon: 'sliders' },
        ],
    },
];

export function normAdminNav(v: string): AdminNav {
    return (ADMIN_NAVS as readonly string[]).includes(v) ? (v as AdminNav) : 'overview';
}

/* ------------------------------------------------------------------ */
/* 共享基础件(Switch / StatusDot / 403 空态 / 二次确认弹层)               */
/* ------------------------------------------------------------------ */

const mono = 'font-mono-ui';
const inputCls = 'h-8 w-full rounded-lg border px-2.5 text-[12px] outline-none transition-colors';

function AdminSwitch({
    on,
    onToggle,
    disabled,
    title,
}: {
    on: boolean;
    onToggle?: () => void;
    disabled?: boolean;
    title?: string;
}) {
    return (
        <button
            type="button"
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

function StatusDot({ color }: { color: string }) {
    return <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />;
}

/** 403 非管理员友好空态(accounts-on 且当前 handle 非 admin)。 */
function AdminForbiddenView() {
    const { t } = useI18n();
    const s = useShell();
    return (
        <PanelEmpty
            icon="shield"
            desc={t('admin.forbidden.desc')}
            action={{ label: t('admin.forbidden.back'), onClick: () => s.setView('chat') }}
        >
            {t('admin.forbidden.title')}
        </PanelEmpty>
    );
}

/** 统一内嵌二次确认弹层(匹配 SettingsModal/ImportModal 视觉层级)。 */
function ConfirmDialog({
    title,
    desc,
    danger,
    confirmLabel,
    busy,
    confirmDisabled,
    onConfirm,
    onCancel,
    children,
}: {
    title: string;
    desc?: string;
    danger?: boolean;
    confirmLabel?: string;
    busy?: boolean;
    confirmDisabled?: boolean;
    onConfirm: () => void;
    onCancel: () => void;
    children?: ReactNode;
}) {
    const { t } = useI18n();
    return (
        <div
            className="fixed inset-0 z-[85] flex items-center justify-center p-4"
            style={{ background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(4px)' }}
            onClick={() => { if (!busy) onCancel(); }}
        >
            <div
                className="pop-in w-full max-w-[440px] overflow-hidden rounded-2xl"
                style={{ background: 'var(--bg-elevated)', boxShadow: 'var(--shadow-float)', border: '1px solid var(--border-hairline)' }}
                onClick={(e) => e.stopPropagation()}
            >
                <div className="flex h-12 items-center justify-between border-b border-[color:var(--border-hairline)] px-4">
                    <span className="heading-tight flex items-center gap-2 text-[13.5px] font-semibold text-[color:var(--fg-primary)]">
                        {danger && <Icon name="warning" size={16} className="text-[color:var(--status-danger)]" />}
                        {title}
                    </span>
                    <button className="ghost-btn h-7 w-7" disabled={busy} onClick={onCancel}>
                        <Icon name="x" size={14} />
                    </button>
                </div>
                <div className="space-y-3 p-4">
                    {desc && <p className="text-[12.5px] leading-relaxed text-[color:var(--fg-secondary)]">{desc}</p>}
                    {children}
                </div>
                <div className="flex items-center justify-end gap-2 border-t border-[color:var(--border-hairline)] px-4 py-3">
                    <button
                        type="button"
                        className="h-8 rounded-lg px-3 text-[12px] font-medium transition-colors hover:bg-[color:var(--bg-active)]"
                        style={{ color: 'var(--fg-secondary)' }}
                        disabled={busy}
                        onClick={onCancel}
                    >
                        {t('admin.common.cancel')}
                    </button>
                    <button
                        type="button"
                        className="h-8 rounded-lg px-3.5 text-[12px] font-medium transition-opacity"
                        style={{
                            background: danger ? 'var(--status-danger)' : 'var(--brand)',
                            color: '#fff',
                            opacity: busy || confirmDisabled ? 0.45 : 1,
                            cursor: busy || confirmDisabled ? 'not-allowed' : 'pointer',
                        }}
                        disabled={busy || confirmDisabled}
                        onClick={onConfirm}
                    >
                        {confirmLabel ?? t('admin.common.confirm')}
                    </button>
                </div>
            </div>
        </div>
    );
}

/** 将异步取数包一层 403 判别:403 不进 PanelError,转由调用方渲染 AdminForbiddenView。 */
type Guarded<T> = { forbidden: true } | { forbidden: false; value: T };

async function guardForbidden<T>(fn: () => Promise<T>): Promise<Guarded<T>> {
    try {
        return { forbidden: false, value: await fn() };
    } catch (e) {
        if (isAdminForbidden(e)) return { forbidden: true };
        throw e;
    }
}

/* ------------------------------------------------------------------ */
/* AdminTree —— 侧栏分区索引(sidebar.tree rail:'admin')                 */
/* ------------------------------------------------------------------ */

export function AdminTree() {
    const { t } = useI18n();
    const s = useShell();
    const nav = normAdminNav(s.adminNav);
    return (
        <div className="flex h-full min-h-0 flex-col">
            {!s.isMobile && (
                <div className="flex h-12 shrink-0 items-center px-3">
                    <span className="heading-tight text-[13.5px] font-medium text-[color:var(--fg-primary)]">
                        {t('nav.admin')}
                    </span>
                </div>
            )}
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-2 pb-4">
                {ADMIN_BUCKETS.map((bucket) => (
                    <div key={bucket.bucketKey} className="space-y-0.5">
                        <div className="px-2 pb-1 text-[11px] font-medium text-[color:var(--fg-muted)]">
                            {t(bucket.bucketKey)}
                        </div>
                        {bucket.items.map(({ id, icon }) => {
                            const act = nav === id;
                            return (
                                <button
                                    key={id}
                                    className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] transition-colors"
                                    style={act
                                        ? { background: 'var(--bg-active)', color: 'var(--fg-primary)' }
                                        : { color: 'var(--fg-secondary)' }}
                                    onClick={() => s.setAdminNav(id)}
                                >
                                    <span style={{ color: act ? 'var(--fg-primary)' : 'var(--fg-muted)' }}>
                                        <Icon name={icon} size={17} active={act} />
                                    </span>
                                    <span className="truncate">{t(`admin.nav.${id}`)}</span>
                                </button>
                            );
                        })}
                    </div>
                ))}
                {/* 视觉分家入口:Cordis 插件域仍归 plugins 视图管,不混进管理侧栏 */}
                <div className="border-t border-[color:var(--border-hairline)] pt-3">
                    <button
                        className="flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-[12.5px] transition-colors hover:bg-[color:var(--bg-surface)]"
                        style={{ color: 'var(--fg-muted)' }}
                        onClick={() => s.setView('plugins')}
                    >
                        <span className="flex items-center gap-2">
                            <Icon name="plugins" size={15} />
                            <span>{t('admin.tree.cordisLink')}</span>
                        </span>
                        <Icon name="chevronRight" size={13} />
                    </button>
                </div>
            </div>
        </div>
    );
}

/* ------------------------------------------------------------------ */
/* 1. 总览 Overview                                                    */
/* ------------------------------------------------------------------ */

interface OverviewBundle {
    overview: AdminOverview;
    me: CurrentUser | null;
    storageHealth: StorageHealth | null;
    storageStatus: StorageStatus | null;
    kernel: KernelSnapshot | null;
    kernelPlugins: PluginItem[];
    lukerPlugins: LukerServerPluginsList | null;
    diag: (DiagBusStats & { events?: { total: number }; errors?: { total: number } }) | null;
    config: ConfigDocument | null;
    oaiSource: string | null;
    oaiEndpoint: string | null;
}

async function fetchOverviewBundle(): Promise<OverviewBundle> {
    const overview = await getAdminOverview();
    const [
        me,
        storageHealth,
        storageStatus,
        kernel,
        kernelRes,
        lukerPlugins,
        diag,
        config,
        settingsRes,
    ] = await Promise.all([
        getMe().catch(() => null),
        getStorageHealth().catch(() => null),
        getStorageStatus().catch(() => null),
        getKernelSnapshot().catch(() => null),
        listPlugins().catch(() => ({ items: [] as PluginItem[] })),
        listLukerServerPlugins().catch(() => null),
        diagStats().catch(() => null),
        getServerConfig().catch(() => null),
        getSettings().catch(() => null),
    ]);

    const oai = (settingsRes?.settings?.oai_settings ?? {}) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
    /* 档案制读面:activeModel 指针 → 命中 profile 显示 名·格式/端点;
       未命中(旧库未迁移)→ legacy 单槽字段兜底。 */
    const profs = (Array.isArray(oai.connection_profiles) ? oai.connection_profiles : [])
        .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object' && !Array.isArray(p));
    const conn = (oai.connection && typeof oai.connection === 'object' && !Array.isArray(oai.connection))
        ? oai.connection as Record<string, unknown> : {};
    const am = (conn.activeModel && typeof conn.activeModel === 'object' && !Array.isArray(conn.activeModel))
        ? conn.activeModel as Record<string, unknown> : {};
    const activeProf = profs.find((p) => str(p.id) === str(am.profileId) && !p.disabled)
        ?? profs.find((p) => !p.disabled) ?? null;
    return {
        overview,
        me,
        storageHealth,
        storageStatus,
        kernel,
        kernelPlugins: kernelRes.items ?? [],
        lukerPlugins,
        diag: diag as OverviewBundle['diag'],
        config,
        oaiSource: activeProf
            ? `${str(activeProf.name) ?? 'profile'} · ${str(activeProf.format) === 'anthropic' ? 'Anthropic' : 'OpenAI'}`
            : str(oai.chat_completion_source),
        oaiEndpoint: activeProf
            ? (str(activeProf.baseUrl) ?? (str(activeProf.format) === 'anthropic' ? 'api.anthropic.com' : null))
            : (str(oai.reverse_proxy) ?? str(oai.custom_url)),
    };
}

function OverviewSection() {
    const { t } = useI18n();
    const s = useShell();
    const remote = useRemote('admin:overview', () => guardForbidden(fetchOverviewBundle));
    const [probing, setProbing] = useState(false);
    const [probeRes, setProbeRes] = useState<ConnectionProbeResult | null>(null);
    const [probeErr, setProbeErr] = useState<string | null>(null);

    const runProbe = () => {
        if (probing) return;
        setProbing(true);
        setProbeErr(null);
        void probeUpstreamConnection()
            .then((r) => setProbeRes(r))
            .catch((e) => setProbeErr(e instanceof Error ? e.message : String(e)))
            .finally(() => setProbing(false));
    };

    const d = remote.data && !remote.data.forbidden ? remote.data.value : null;
    const cfgSum = useMemo(() => (d?.config ? parseConfigSummary(d.config.content) : null), [d?.config]);

    if (remote.error) return <PanelError error={remote.error} onRetry={remote.reload} />;
    if (remote.data?.forbidden) return <AdminForbiddenView />;

    const kernelActive = d?.kernelPlugins.filter((p) => !p.disabled && p.status === 'active').length ?? 0;
    const kernelDisabled = d?.kernelPlugins.filter((p) => p.disabled).length ?? 0;
    const kernelFailed = d?.kernelPlugins.filter((p) => p.status === 'failed').length ?? 0;

    const diagErrCount = d?.diag?.errors?.total ?? ((d?.diag?.byLvl?.warn ?? 0) + (d?.diag?.byLvl?.error ?? 0));
    const diagEventCount = d?.diag?.events?.total ?? d?.diag?.size ?? 0;

    // 聚合待办与安全提醒(深链至各区)
    const notices: { level: 'danger' | 'warn' | 'info'; text: string; onClick: () => void }[] = [];
    if (d) {
        if (cfgSum) {
            const a = cfgSum.access;
            if (a.listen && !a.whitelistMode && !a.basicAuthMode && !a.enableUserAccounts && !a.securityOverride) {
                notices.push({ level: 'danger', text: t('admin.ov.notice.noAuth'), onClick: () => s.setAdminNav('config') });
            }
            if (!a.enableUserAccounts) {
                notices.push({ level: 'info', text: t('admin.ov.notice.accountsOff'), onClick: () => s.setAdminNav('config') });
            }
        }
        if (d.overview.security.adminWithoutPassword.length > 0) {
            notices.push({
                level: 'warn',
                text: `${d.overview.security.adminWithoutPassword.length} ${t('admin.ov.notice.adminNoPwd')} (${d.overview.security.adminWithoutPassword.join(', ')})`,
                onClick: () => s.setAdminNav('users'),
            });
        }
        if (d.overview.security.disabledAdmins.length > 0) {
            notices.push({
                level: 'warn',
                text: `${d.overview.security.disabledAdmins.length} ${t('admin.ov.notice.disabledAdmin')}`,
                onClick: () => s.setAdminNav('users'),
            });
        }
        if (d.overview.totals.overQuotaUsers > 0) {
            notices.push({
                level: 'warn',
                text: `${d.overview.totals.overQuotaUsers} ${t('admin.ov.notice.overQuota')}`,
                onClick: () => s.setAdminNav('users'),
            });
        }
        const storageKind = d.storageStatus?.currentMode ?? d.storageHealth?.kind ?? cfgSum?.storageMode;
        if (storageKind === 'fs') {
            notices.push({ level: 'info', text: t('admin.ov.notice.fsMode'), onClick: () => s.setAdminNav('config') });
        }
        if (diagErrCount > 0) {
            notices.push({
                level: 'warn',
                text: `${diagErrCount} · ${t('admin.ov.notice.diagErr')}`,
                onClick: () => s.openPanel('diag'),
            });
        }
    }

    const cardCls = 'flex flex-col justify-between gap-2.5 rounded-[12px] p-4';
    const cardStyle = {
        background: 'var(--bg-surface)',
        border: '1px solid var(--border-hairline)',
        boxShadow: 'var(--shadow-card)',
    };

    return (
        <div className="space-y-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                    <h1 className="heading-tight text-title-lg font-semibold text-[color:var(--fg-primary)]">{t('admin.ov.title')}</h1>
                    <p className="mt-1 text-[12.5px] text-[color:var(--fg-muted)]">{t('admin.ov.sub')}</p>
                </div>
                <button
                    className="ghost-btn h-8 gap-1.5 px-3 text-[12px]"
                    style={{ border: '1px solid var(--border-hairline)', background: 'var(--bg-surface)' }}
                    onClick={() => { remote.reload(); s.hint(t('admin.refreshed')); }}
                >
                    <Icon name="refresh" size={14} />
                    <span>{t('admin.refresh')}</span>
                </button>
            </div>

            {!d ? (
                <div className="inset-group">
                    <div className="inset-row text-[12px] text-[color:var(--fg-faint)]">…</div>
                </div>
            ) : (
                <>
                    {/* 一屏四态卡:实例内核 / 存储引擎 / 多 Handle / 上游连接 */}
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        {/* 1. 实例与内核 */}
                        <div className={cardCls} style={cardStyle}>
                            <div className="flex items-center justify-between">
                                <span className="flex items-center gap-2 text-[12px] font-medium text-[color:var(--fg-muted)]">
                                    <Icon name="cpu" size={15} />
                                    {t('admin.ov.card.instance')}
                                </span>
                                <span className={`text-[11px] ${mono} text-[color:var(--fg-faint)]`}>
                                    {d.overview.server.nodeVersion} · {d.overview.server.platform}
                                </span>
                            </div>
                            <div className="flex items-baseline gap-2">
                                <span className={`text-[18px] font-semibold text-[color:var(--fg-primary)] ${mono}`}>
                                    {formatUptime(d.overview.server.uptimeSec)}
                                </span>
                                <span className="text-[11.5px] text-[color:var(--fg-muted)]">{t('admin.ov.uptime')}</span>
                            </div>
                            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[color:var(--border-hairline)] pt-2.5 text-[11px] text-[color:var(--fg-secondary)]">
                                <span className={mono}>
                                    {d.kernel ? `${d.kernel.routes.length} ${t('admin.ov.routes')} · ${d.kernel.services.length} ${t('admin.ov.services')}` : 'kernel —'}
                                </span>
                                <button
                                    className="inline-flex items-center gap-1 text-[11px] text-[color:var(--fg-muted)] transition-colors hover:text-[color:var(--fg-primary)]"
                                    onClick={() => s.openPanel('diag')}
                                >
                                    <span className={mono}>{t('admin.ov.diagBuf')} {diagEventCount}</span>
                                    <Icon name="detach" size={12} />
                                </button>
                            </div>
                        </div>

                        {/* 2. 存储引擎与数据根 */}
                        <div className={cardCls} style={cardStyle}>
                            <div className="flex items-center justify-between">
                                <span className="flex items-center gap-2 text-[12px] font-medium text-[color:var(--fg-muted)]">
                                    <Icon name="database" size={15} />
                                    {t('admin.ov.card.storage')}
                                </span>
                                <span className="inline-flex items-center gap-1.5 text-[11px] text-[color:var(--fg-secondary)]">
                                    <StatusDot
                                        color={
                                            d.storageHealth?.ok === false
                                                ? 'var(--status-danger)'
                                                : d.storageStatus?.readOnly
                                                    ? 'var(--status-warn)'
                                                    : 'var(--status-ok)'
                                        }
                                    />
                                    <span className={mono}>
                                        {d.storageHealth?.ok === false
                                            ? t('admin.ov.unhealthy')
                                            : d.storageStatus?.migrationInProgress
                                                ? t('admin.ov.migrating')
                                                : d.storageStatus?.readOnly
                                                    ? t('admin.ov.readOnly')
                                                    : t('admin.ov.writable')}
                                        {typeof d.storageHealth?.latencyMs === 'number' ? ` · ${d.storageHealth.latencyMs}ms` : ''}
                                    </span>
                                </span>
                            </div>
                            <div className="flex items-baseline gap-2.5">
                                <span className={`text-[18px] font-semibold uppercase text-[color:var(--fg-primary)] ${mono}`}>
                                    {d.storageStatus?.currentMode ?? d.storageHealth?.kind ?? cfgSum?.storageMode ?? '—'}
                                </span>
                                <span className={`text-[11.5px] ${mono} text-[color:var(--fg-muted)]`}>
                                    {t('admin.ov.totalUsed')} {formatBytes(d.overview.totals.storageBytes)}
                                </span>
                            </div>
                            <div className="flex items-center justify-between gap-2 border-t border-[color:var(--border-hairline)] pt-2.5 text-[11px] text-[color:var(--fg-secondary)]">
                                <span className="truncate text-[color:var(--fg-muted)]">
                                    {t('admin.ov.dataRoot')}: <span className={`${mono} text-[color:var(--fg-primary)]`}>{cfgSum?.dataRoot ?? '—'}</span>
                                </span>
                                {cfgSum && <span className={`shrink-0 ${mono} text-[color:var(--fg-faint)]`}>:{cfgSum.port}</span>}
                            </div>
                        </div>

                        {/* 3. 多 Handle 空间 */}
                        <div className={cardCls} style={cardStyle}>
                            <div className="flex items-center justify-between">
                                <span className="flex items-center gap-2 text-[12px] font-medium text-[color:var(--fg-muted)]">
                                    <Icon name="user" size={15} />
                                    {t('admin.ov.card.handles')}
                                </span>
                                <span className="inline-flex items-center gap-1.5 text-[11px] text-[color:var(--fg-muted)]">
                                    <StatusDot color={cfgSum?.access.enableUserAccounts ? 'var(--brand)' : 'var(--fg-faint)'} />
                                    {cfgSum?.access.enableUserAccounts ? t('admin.ov.gateOn') : t('admin.ov.gateOff')}
                                </span>
                            </div>
                            <div className="flex items-baseline gap-2">
                                <span className={`text-[18px] font-semibold text-[color:var(--fg-primary)] ${mono}`}>
                                    {d.overview.totals.users}
                                </span>
                                <span className="text-[11.5px] text-[color:var(--fg-muted)]">
                                    handle · {d.overview.totals.enabledUsers} {t('admin.ov.enabled')} · {d.overview.totals.adminUsers} {t('admin.ov.admins')}
                                </span>
                            </div>
                            <div className="flex items-center justify-between gap-2 border-t border-[color:var(--border-hairline)] pt-2.5 text-[11px]">
                                <span className="truncate text-[color:var(--fg-muted)]">
                                    {t('admin.ov.current')}: <span className={`${mono} text-[color:var(--fg-primary)]`}>{d.me?.handle ?? 'default-user'}</span>
                                </span>
                                <button
                                    className="inline-flex shrink-0 items-center gap-1 text-[color:var(--fg-secondary)] hover:text-[color:var(--fg-primary)]"
                                    onClick={() => s.setAdminNav('users')}
                                >
                                    <span>{t('admin.nav.users')}</span>
                                    <Icon name="chevronRight" size={12} />
                                </button>
                            </div>
                        </div>

                        {/* 4. 上游连接态(读生效配置 + 按需探测) */}
                        <div className={cardCls} style={cardStyle}>
                            <div className="flex items-center justify-between">
                                <span className="flex items-center gap-2 text-[12px] font-medium text-[color:var(--fg-muted)]">
                                    <Icon name="plug" size={15} />
                                    {t('admin.ov.card.connection')}
                                </span>
                                <button
                                    className="h-6 rounded-md px-2 text-[11px] font-medium transition-colors hover:bg-[color:var(--bg-active)]"
                                    style={{ border: '1px solid var(--border-subtle)', color: 'var(--fg-primary)', opacity: probing ? 0.55 : 1 }}
                                    disabled={probing}
                                    onClick={runProbe}
                                >
                                    {probing ? t('admin.ov.probing') : t('admin.ov.probe')}
                                </button>
                            </div>
                            <div className="min-w-0">
                                <div className={`truncate text-[15px] font-semibold text-[color:var(--fg-primary)] ${mono}`}>
                                    {d.oaiSource ?? t('admin.ov.connUnset')}
                                </div>
                                <div className={`mt-0.5 truncate text-[11px] ${mono} text-[color:var(--fg-faint)]`}>
                                    {d.oaiEndpoint ?? t('admin.ov.probeHint')}
                                </div>
                            </div>
                            <div className="flex items-center justify-between gap-2 border-t border-[color:var(--border-hairline)] pt-2.5 text-[11px]">
                                {probeRes ? (
                                    <span className="inline-flex min-w-0 items-center gap-1.5">
                                        <StatusDot color={probeRes.ok ? 'var(--status-ok)' : 'var(--status-danger)'} />
                                        <span className={`truncate ${mono}`} style={{ color: probeRes.ok ? 'var(--status-ok)' : 'var(--status-danger)' }}>
                                            {probeRes.ok
                                                ? `${t('admin.ov.probeOk')} · ${probeRes.latencyMs}ms${probeRes.modelCount != null ? ` · ${probeRes.modelCount} ${t('admin.ov.probeModels')}` : ''}`
                                                : `${probeRes.error ?? 'error'}${probeRes.upstreamStatus ? ` (${probeRes.upstreamStatus})` : ''}${probeRes.detail ? ` · ${probeRes.detail}` : ''}`}
                                        </span>
                                    </span>
                                ) : probeErr ? (
                                    <span className={`truncate ${mono} text-[color:var(--status-danger)]`}>{probeErr}</span>
                                ) : (
                                    <span className="text-[color:var(--fg-faint)]">
                                        {t('admin.ov.connSource')}: {d.oaiSource ?? '—'}
                                    </span>
                                )}
                            </div>
                        </div>
                    </div>

                    {/* 两套插件体系视觉分家:内核(profile.yaml) vs Luker Server Plugins(plugins/ 目录) */}
                    <div className="space-y-2.5">
                        <div className="flex items-center justify-between px-0.5">
                            <span className="text-[11.5px] font-medium text-[color:var(--fg-muted)]">{t('admin.ov.pluginsSplit')}</span>
                            <span className={`text-[10.5px] ${mono} text-[color:var(--fg-faint)]`}>{t('admin.ov.pluginsSplitNote')}</span>
                        </div>
                        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                            {/* 左:Cordis 内核插件 */}
                            <div className="inset-group">
                                <div className="inset-row">
                                    <div className="min-w-0">
                                        <div className="flex items-center gap-2">
                                            <Icon name="plugins" size={15} className="text-[color:var(--brand)]" />
                                            <span className="text-[13px] font-semibold text-[color:var(--fg-primary)]">{t('admin.ov.cordis.title')}</span>
                                            <span className={`text-[11px] ${mono} text-[color:var(--fg-muted)]`}>{d.kernelPlugins.length}</span>
                                        </div>
                                        <div className="mt-0.5 text-[11px] text-[color:var(--fg-muted)]">{t('admin.ov.cordis.sub')}</div>
                                    </div>
                                    <button
                                        className="ghost-btn h-7 shrink-0 gap-1 px-2.5 text-[11.5px]"
                                        style={{ border: '1px solid var(--border-hairline)' }}
                                        onClick={() => s.setView('plugins')}
                                    >
                                        <span>{t('admin.ov.cordis.goto')}</span>
                                        <Icon name="chevronRight" size={12} />
                                    </button>
                                </div>
                                <div className="inset-row">
                                    <div className={`flex flex-wrap items-center gap-3 text-[11.5px] ${mono}`}>
                                        <span className="inline-flex items-center gap-1.5 text-[color:var(--fg-primary)]">
                                            <StatusDot color="var(--status-ok)" />
                                            {kernelActive} {t('admin.ov.cordis.active')}
                                        </span>
                                        <span className="inline-flex items-center gap-1.5 text-[color:var(--fg-muted)]">
                                            <StatusDot color="var(--fg-faint)" />
                                            {kernelDisabled} {t('admin.ov.cordis.disabled')}
                                        </span>
                                        {kernelFailed > 0 && (
                                            <span className="inline-flex items-center gap-1.5 text-[color:var(--status-danger)]">
                                                <StatusDot color="var(--status-danger)" />
                                                {kernelFailed} {t('admin.ov.cordis.failed')}
                                            </span>
                                        )}
                                    </div>
                                    <span className={`text-[10px] ${mono} text-[color:var(--fg-faint)]`}>/api/utopinn/plugins</span>
                                </div>
                                {d.kernelPlugins.length > 0 ? (
                                    <div className="inset-row flex-wrap !justify-start gap-1.5">
                                        {d.kernelPlugins.map((p) => (
                                            <span
                                                key={p.id}
                                                title={p.id}
                                                className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[10.5px] ${mono}`}
                                                style={{
                                                    background: 'var(--bg-canvas)',
                                                    border: '1px solid var(--border-hairline)',
                                                    color: p.disabled ? 'var(--fg-faint)' : 'var(--fg-secondary)',
                                                }}
                                            >
                                                <StatusDot
                                                    color={
                                                        p.status === 'failed'
                                                            ? 'var(--status-danger)'
                                                            : p.disabled
                                                                ? 'var(--fg-faint)'
                                                                : 'var(--status-ok)'
                                                    }
                                                />
                                                {pluginLabel(p.id)}
                                            </span>
                                        ))}
                                    </div>
                                ) : (
                                    <div className="inset-row text-[11.5px] text-[color:var(--fg-faint)]">{t('admin.ov.cordis.empty')}</div>
                                )}
                            </div>

                            {/* 右:Luker 服务端插件(plugins/ 目录) */}
                            <div className="inset-group">
                                <div className="inset-row">
                                    <div className="min-w-0">
                                        <div className="flex items-center gap-2">
                                            <Icon name="folder" size={15} className="text-[color:var(--fg-secondary)]" />
                                            <span className="text-[13px] font-semibold text-[color:var(--fg-primary)]">{t('admin.ov.luker.title')}</span>
                                            <span className={`text-[11px] ${mono} text-[color:var(--fg-muted)]`}>
                                                {d.lukerPlugins?.plugins.length ?? 0}
                                            </span>
                                        </div>
                                        <div className="mt-0.5 text-[11px] text-[color:var(--fg-muted)]">{t('admin.ov.luker.sub')}</div>
                                    </div>
                                    <WiredBadge>{t('admin.ov.luker.readonly')}</WiredBadge>
                                </div>
                                <div className="inset-row">
                                    <span className="inline-flex items-center gap-1.5 text-[11.5px] text-[color:var(--fg-secondary)]">
                                        <StatusDot color={d.lukerPlugins?.enabled ? 'var(--status-ok)' : 'var(--fg-faint)'} />
                                        {d.lukerPlugins?.enabled ? t('admin.ov.luker.enabled') : t('admin.ov.luker.disabled')}
                                    </span>
                                    <button
                                        className="text-[11px] text-[color:var(--fg-muted)] hover:text-[color:var(--fg-primary)]"
                                        onClick={() => s.setAdminNav('config')}
                                    >
                                        {t('admin.ov.luker.configLink')} ▸
                                    </button>
                                </div>
                                {d.lukerPlugins && d.lukerPlugins.plugins.length > 0 ? (
                                    d.lukerPlugins.plugins.map((sp) => (
                                        <div key={sp.directory} className="inset-row">
                                            <div className="min-w-0">
                                                <div className={`truncate text-[12px] font-medium text-[color:var(--fg-primary)] ${mono}`}>
                                                    {sp.name || sp.directory}
                                                </div>
                                                <div className={`truncate text-[10.5px] ${mono} text-[color:var(--fg-faint)]`}>
                                                    {sp.directory}{sp.version ? ` · v${sp.version}` : ''}
                                                </div>
                                            </div>
                                            {sp.dependencyStatus?.hasPackageJson && (
                                                <span
                                                    className={`shrink-0 text-[10.5px] ${mono}`}
                                                    style={{ color: sp.dependencyStatus.installed ? 'var(--status-ok)' : 'var(--status-warn)' }}
                                                >
                                                    {sp.dependencyStatus.installed ? t('admin.ov.luker.depsOk') : t('admin.ov.luker.depsMissing')}
                                                </span>
                                            )}
                                        </div>
                                    ))
                                ) : (
                                    <div className="inset-row text-[11.5px] text-[color:var(--fg-faint)]">
                                        <span className="truncate">{t('admin.ov.luker.empty')}</span>
                                        <span className={`shrink-0 text-[10px] ${mono}`}>/api/users/plugins/*</span>
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>

                    {/* 安全与部署提醒 */}
                    <div className="space-y-2">
                        <div className="px-0.5 text-[11.5px] font-medium text-[color:var(--fg-muted)]">{t('admin.ov.notices')}</div>
                        <div className="inset-group">
                            {notices.length > 0 ? (
                                notices.map((n, idx) => (
                                    <button key={idx} className="inset-row inset-row-btn" onClick={n.onClick}>
                                        <span className="flex min-w-0 items-center gap-2.5 text-[12.5px] text-[color:var(--fg-primary)]">
                                            <StatusDot
                                                color={
                                                    n.level === 'danger'
                                                        ? 'var(--status-danger)'
                                                        : n.level === 'warn'
                                                            ? 'var(--status-warn)'
                                                            : 'var(--fg-muted)'
                                                }
                                            />
                                            <span className="truncate">{n.text}</span>
                                        </span>
                                        <Icon name="chevronRight" size={14} className="shrink-0 text-[color:var(--fg-faint)]" />
                                    </button>
                                ))
                            ) : (
                                <div className="inset-row text-[12px] text-[color:var(--fg-muted)]">
                                    <span className="flex items-center gap-2">
                                        <StatusDot color="var(--status-ok)" />
                                        {t('admin.ov.notice.allGood')}
                                    </span>
                                </div>
                            )}
                        </div>
                    </div>
                </>
            )}
        </div>
    );
}

/* ------------------------------------------------------------------ */
/* 2. 账号 Users —— 多 handle 生命周期(不做「以 handle 身份游玩」)        */
/* ------------------------------------------------------------------ */

interface MergedHandleRow {
    handle: string;
    name: string;
    avatar: string;
    admin: boolean;
    enabled: boolean;
    password: boolean;
    created?: number;
    storageBytes: number;
    effectiveQuotaBytes: number;
    explicitQuotaBytes: number | null;
    usageRatio: number | null;
}

interface UsersBundle {
    rows: MergedHandleRow[];
    totals: AdminOverview['totals'];
    meHandle: string;
    enableUserAccounts: boolean;
}

async function fetchUsersBundle(): Promise<UsersBundle> {
    const [overview, users, me, cfg] = await Promise.all([
        getAdminOverview(),
        listAdminUsers(),
        getMe().catch(() => null),
        getServerConfig().catch(() => null),
    ]);
    const statsByHandle = new Map(overview.users.map((u) => [u.handle, u]));
    const rows: MergedHandleRow[] = users.map((u: AdminUserItem) => {
        const st = statsByHandle.get(u.handle);
        return {
            handle: u.handle,
            name: u.name,
            avatar: u.avatar,
            admin: u.admin,
            enabled: u.enabled,
            password: u.password,
            created: u.created,
            storageBytes: st?.storageBytes ?? 0,
            effectiveQuotaBytes: st?.storageQuotaBytes ?? (u.storageQuotaBytes ?? -1),
            explicitQuotaBytes: u.storageQuotaBytes,
            usageRatio: st?.storageUsageRatio ?? null,
        };
    });
    const enableUserAccounts = cfg ? parseConfigSummary(cfg.content).access.enableUserAccounts : false;
    return {
        rows,
        totals: overview.totals,
        meHandle: me?.handle ?? 'default-user',
        enableUserAccounts,
    };
}

type UserModalState =
    | null
    | { kind: 'rename'; row: MergedHandleRow }
    | { kind: 'password'; row: MergedHandleRow }
    | { kind: 'quota'; row: MergedHandleRow }
    | { kind: 'disable'; row: MergedHandleRow }
    | { kind: 'demote'; row: MergedHandleRow }
    | { kind: 'delete'; row: MergedHandleRow };

function UsersSection() {
    const { t } = useI18n();
    const s = useShell();
    const remote = useRemote('admin:users', () => guardForbidden(fetchUsersBundle));

    /* 新建抽屉态 */
    const [createOpen, setCreateOpen] = useState(false);
    const [newName, setNewName] = useState('');
    const [newHandle, setNewHandle] = useState('');
    const [slugPreview, setSlugPreview] = useState('');
    const [newPwd, setNewPwd] = useState('');
    const [newAdmin, setNewAdmin] = useState(false);
    const [createBusy, setCreateBusy] = useState(false);
    const [createErr, setCreateErr] = useState<string | null>(null);

    /* 行内动作与二次确认态 */
    const [rowBusy, setRowBusy] = useState<string | null>(null);
    const [modal, setModal] = useState<UserModalState>(null);
    const [modalInput, setModalInput] = useState('');
    const [deleteTyped, setDeleteTyped] = useState('');
    const [deletePurge, setDeletePurge] = useState(false);
    const [modalBusy, setModalBusy] = useState(false);
    const [modalErr, setModalErr] = useState<string | null>(null);

    // 实时 slugify 预览(防抖 200ms 调 /api/users/slugify)
    useEffect(() => {
        const raw = newHandle.trim();
        if (!raw) {
            setSlugPreview('');
            return;
        }
        let dead = false;
        const timer = setTimeout(() => {
            void slugifyHandle(raw)
                .then((slug) => { if (!dead) setSlugPreview(slug); })
                .catch(() => {
                    if (!dead) {
                        setSlugPreview(raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''));
                    }
                });
        }, 200);
        return () => { dead = true; clearTimeout(timer); };
    }, [newHandle]);

    const openModal = (next: UserModalState) => {
        setModal(next);
        setModalErr(null);
        setDeleteTyped('');
        setDeletePurge(false);
        if (next?.kind === 'rename') setModalInput(next.row.name);
        else if (next?.kind === 'password') setModalInput('');
        else if (next?.kind === 'quota') {
            const q = next.row.explicitQuotaBytes;
            setModalInput(q !== null && q >= 0 ? String(Math.round(q / (1024 * 1024))) : '');
        } else {
            setModalInput('');
        }
    };

    const runDirectAction = (handle: string, fn: () => Promise<void>) => {
        if (rowBusy) return;
        setRowBusy(handle);
        void fn()
            .then(() => {
                s.hint(t('admin.users.opDone'));
                remote.reload();
            })
            .catch((e) => s.hint(`${t('admin.users.opFailed')}: ${e instanceof Error ? e.message : String(e)}`, true))
            .finally(() => setRowBusy(null));
    };

    const submitCreate = () => {
        if (createBusy) return;
        const name = newName.trim();
        const handle = newHandle.trim();
        if (!name || !handle) return;
        setCreateBusy(true);
        setCreateErr(null);
        void createUserHandle({ handle, name, password: newPwd || undefined, admin: newAdmin })
            .then((r) => {
                s.hint(`${t('admin.users.created')}: ${r.handle}`);
                setNewName('');
                setNewHandle('');
                setSlugPreview('');
                setNewPwd('');
                setNewAdmin(false);
                setCreateOpen(false);
                remote.reload();
            })
            .catch((e) => setCreateErr(e instanceof Error ? e.message : String(e)))
            .finally(() => setCreateBusy(false));
    };

    const submitModal = () => {
        if (!modal || modalBusy) return;
        setModalBusy(true);
        setModalErr(null);
        let p: Promise<void>;
        if (modal.kind === 'rename') {
            const trimmed = modalInput.trim();
            if (!trimmed) { setModalBusy(false); return; }
            p = changeUserName(modal.row.handle, trimmed);
        } else if (modal.kind === 'password') {
            p = changeUserPassword(modal.row.handle, modalInput);
        } else if (modal.kind === 'quota') {
            const raw = modalInput.trim();
            const mb = raw === '' ? -1 : Number(raw);
            if (raw !== '' && !Number.isFinite(mb)) {
                setModalErr('Invalid number');
                setModalBusy(false);
                return;
            }
            const bytes = mb < 0 ? null : Math.floor(mb * 1024 * 1024);
            p = setUserQuota(modal.row.handle, bytes);
        } else if (modal.kind === 'disable') {
            p = disableUserHandle(modal.row.handle);
        } else if (modal.kind === 'demote') {
            p = demoteUserHandle(modal.row.handle);
        } else {
            p = deleteUserHandle(modal.row.handle, deletePurge);
        }

        void p
            .then(() => {
                s.hint(t('admin.users.opDone'));
                setModal(null);
                remote.reload();
            })
            .catch((e) => setModalErr(e instanceof Error ? e.message : String(e)))
            .finally(() => setModalBusy(false));
    };

    if (remote.error) return <PanelError error={remote.error} onRetry={remote.reload} />;
    if (remote.data?.forbidden) return <AdminForbiddenView />;

    const d = remote.data?.value ?? null;

    return (
        <div className="space-y-5">
            {/* 页头 */}
            <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                    <h1 className="heading-tight text-title-lg font-semibold text-[color:var(--fg-primary)]">{t('admin.users.title')}</h1>
                    <p className="mt-1 text-[12.5px] text-[color:var(--fg-muted)]">{t('admin.users.sub')}</p>
                </div>
                <div className="flex items-center gap-2">
                    <button
                        className="ghost-btn h-8 gap-1.5 px-3 text-[12px]"
                        style={{ border: '1px solid var(--border-hairline)', background: 'var(--bg-surface)' }}
                        onClick={() => { remote.reload(); s.hint(t('admin.refreshed')); }}
                    >
                        <Icon name="refresh" size={14} />
                        <span>{t('admin.refresh')}</span>
                    </button>
                    <button
                        className="inline-flex h-8 items-center gap-1.5 rounded-lg px-3.5 text-[12px] font-medium"
                        style={{ background: 'var(--brand)', color: 'var(--brand-fg)' }}
                        onClick={() => { setCreateOpen((v) => !v); setCreateErr(null); }}
                    >
                        <Icon name={createOpen ? 'x' : 'plus'} size={14} />
                        <span>{t('admin.users.new')}</span>
                    </button>
                </div>
            </div>

            {/* 统计行 */}
            {d && (
                <div className={`flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px] ${mono} text-[color:var(--fg-muted)]`}>
                    <span>{d.totals.users} handle</span>
                    <span>· {d.totals.enabledUsers} {t('admin.ov.enabled')}</span>
                    <span>· {d.totals.adminUsers} {t('admin.ov.admins')}</span>
                    <span>· {t('admin.ov.totalUsed')} {formatBytes(d.totals.storageBytes)}</span>
                </div>
            )}

            {/* accounts-off 语义说明条(不禁用功能,把语义讲清) */}
            {d && !d.enableUserAccounts && (
                <div
                    className="flex flex-wrap items-center justify-between gap-3 rounded-[10px] px-3.5 py-2.5 text-[12px]"
                    style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-hairline)', color: 'var(--fg-secondary)' }}
                >
                    <span className="min-w-0 flex-1 leading-relaxed">{t('admin.users.accountsOffBanner')}</span>
                    <button
                        className="shrink-0 text-[12px] font-medium text-[color:var(--brand)] hover:underline"
                        onClick={() => s.setAdminNav('config')}
                    >
                        {t('admin.users.gotoConfig')} ▸
                    </button>
                </div>
            )}

            {/* 新建 Handle 折叠表单 */}
            {createOpen && (
                <div
                    className="space-y-3 rounded-[12px] p-4"
                    style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-strong)', boxShadow: 'var(--shadow-card)' }}
                >
                    <div className="heading-tight text-[13px] font-semibold text-[color:var(--fg-primary)]">
                        {t('admin.users.createTitle')}
                    </div>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <div className="space-y-1">
                            <label className="block text-[11px] text-[color:var(--fg-muted)]">{t('admin.users.fieldName')}</label>
                            <input
                                value={newName}
                                onChange={(e) => setNewName(e.target.value)}
                                placeholder={t('admin.users.fieldNamePh')}
                                className={inputCls}
                                style={{ background: 'var(--bg-canvas)', borderColor: 'var(--border-hairline)', color: 'var(--fg-primary)' }}
                            />
                        </div>
                        <div className="space-y-1">
                            <label className="block text-[11px] text-[color:var(--fg-muted)]">{t('admin.users.fieldHandle')}</label>
                            <input
                                value={newHandle}
                                onChange={(e) => setNewHandle(e.target.value)}
                                placeholder={t('admin.users.fieldHandlePh')}
                                className={`${inputCls} ${mono}`}
                                style={{ background: 'var(--bg-canvas)', borderColor: 'var(--border-hairline)', color: 'var(--fg-primary)' }}
                            />
                            {slugPreview && (
                                <div className={`text-[10.5px] ${mono} text-[color:var(--fg-muted)]`}>
                                    {t('admin.users.slugPreview')} <span className="text-[color:var(--fg-primary)]">{slugPreview}</span>
                                </div>
                            )}
                        </div>
                        <div className="space-y-1">
                            <label className="block text-[11px] text-[color:var(--fg-muted)]">{t('admin.users.fieldPwd')}</label>
                            <input
                                type="password"
                                value={newPwd}
                                onChange={(e) => setNewPwd(e.target.value)}
                                placeholder={t('admin.users.fieldPwdPh')}
                                className={inputCls}
                                style={{ background: 'var(--bg-canvas)', borderColor: 'var(--border-hairline)', color: 'var(--fg-primary)' }}
                            />
                        </div>
                        <div className="flex items-end justify-between pb-1">
                            <span className="text-[12px] text-[color:var(--fg-secondary)]">{t('admin.users.fieldAdmin')}</span>
                            <AdminSwitch on={newAdmin} onToggle={() => setNewAdmin((v) => !v)} />
                        </div>
                    </div>
                    {createErr && (
                        <div className={`rounded-lg px-2.5 py-2 text-[11.5px] ${mono}`} style={{ background: 'var(--bg-canvas)', color: 'var(--status-danger)' }}>
                            {createErr}
                        </div>
                    )}
                    <div className="flex items-center justify-end gap-2 pt-1">
                        <button
                            className="h-8 rounded-lg px-3 text-[12px] text-[color:var(--fg-secondary)] hover:bg-[color:var(--bg-active)]"
                            disabled={createBusy}
                            onClick={() => setCreateOpen(false)}
                        >
                            {t('admin.common.cancel')}
                        </button>
                        <button
                            className="h-8 rounded-lg px-3.5 text-[12px] font-medium"
                            style={{
                                background: 'var(--brand)',
                                color: 'var(--brand-fg)',
                                opacity: createBusy || !newName.trim() || !newHandle.trim() ? 0.45 : 1,
                            }}
                            disabled={createBusy || !newName.trim() || !newHandle.trim()}
                            onClick={submitCreate}
                        >
                            {createBusy ? t('admin.users.creating') : t('admin.users.createSubmit')}
                        </button>
                    </div>
                </div>
            )}

            {/* Handle 列表(行对齐 + 状态点,不堆徽章墙) */}
            {!d ? (
                <div className="inset-group">
                    <div className="inset-row text-[12px] text-[color:var(--fg-faint)]">…</div>
                </div>
            ) : d.rows.length === 0 ? (
                <div className="inset-group">
                    <div className="inset-row text-[12px] text-[color:var(--fg-faint)]">{t('admin.users.empty')}</div>
                </div>
            ) : (
                <div className="inset-group">
                    {d.rows.map((row) => {
                        const isSelf = row.handle === d.meHandle;
                        const isDefault = row.handle === 'default-user';
                        const cannotDisable = isSelf || isDefault;
                        const cannotDelete = isSelf || isDefault;
                        const cannotDemote = isSelf;
                        const busy = rowBusy === row.handle;
                        const quotaFinite = row.effectiveQuotaBytes >= 0;
                        const ratioPct = row.usageRatio !== null ? Math.min(100, Math.round(row.usageRatio * 100)) : 0;
                        const overQuota = quotaFinite && row.storageBytes > row.effectiveQuotaBytes;
                        const adminNoPwd = row.admin && !row.password;

                        const actBtnCls = 'rounded-md px-2 py-1 text-[11.5px] transition-colors hover:bg-[color:var(--bg-active)] disabled:cursor-not-allowed disabled:opacity-35';

                        return (
                            <div key={row.handle} className="inset-row flex-wrap !items-center gap-y-2.5">
                                {/* 左:状态点 + 标识 + 显示名 */}
                                <div className="flex min-w-[200px] flex-1 items-center gap-3">
                                    <StatusDot color={row.enabled ? 'var(--status-ok)' : 'var(--fg-faint)'} />
                                    <div className="min-w-0">
                                        <div className="flex flex-wrap items-center gap-2">
                                            <span className={`truncate text-[13px] font-semibold text-[color:var(--fg-primary)] ${mono}`}>
                                                {row.handle}
                                            </span>
                                            <span className="text-[11px] text-[color:var(--fg-muted)]">
                                                {[
                                                    row.admin ? t('admin.users.tagAdmin') : null,
                                                    isSelf ? t('admin.users.tagCurrent') : null,
                                                    isDefault ? t('admin.users.tagDefault') : null,
                                                    !row.enabled ? t('admin.users.tagDisabled') : null,
                                                ].filter(Boolean).join(' · ')}
                                            </span>
                                        </div>
                                        <div className="mt-0.5 truncate text-[12px] text-[color:var(--fg-secondary)]">
                                            {row.name}
                                        </div>
                                    </div>
                                </div>

                                {/* 中:凭据 + 存储/配额 */}
                                <div className="flex shrink-0 items-center gap-5 text-[11.5px]">
                                    <span
                                        className={`w-[74px] ${mono}`}
                                        style={{ color: adminNoPwd ? 'var(--status-warn)' : row.password ? 'var(--fg-secondary)' : 'var(--fg-faint)' }}
                                    >
                                        {row.password ? t('admin.users.pwdSet') : t('admin.users.pwdNone')}
                                    </span>
                                    <div className="w-[132px]">
                                        <div className={`text-right ${mono}`} style={{ color: overQuota ? 'var(--status-danger)' : 'var(--fg-secondary)' }}>
                                            {formatBytes(row.storageBytes)} / {quotaFinite ? formatBytes(row.effectiveQuotaBytes) : t('admin.users.unlimited')}
                                        </div>
                                        {quotaFinite && (
                                            <div className="mt-1 h-1 w-full overflow-hidden rounded-full" style={{ background: 'var(--bg-active)' }}>
                                                <div
                                                    className="h-full rounded-full"
                                                    style={{
                                                        width: `${ratioPct}%`,
                                                        background: overQuota ? 'var(--status-danger)' : 'var(--brand)',
                                                    }}
                                                />
                                            </div>
                                        )}
                                    </div>
                                </div>

                                {/* 右:操作带 */}
                                <div className="flex shrink-0 flex-wrap items-center gap-0.5 text-[color:var(--fg-secondary)]">
                                    <button className={actBtnCls} disabled={busy} onClick={() => openModal({ kind: 'rename', row })}>
                                        {t('admin.users.actRename')}
                                    </button>
                                    <button className={actBtnCls} disabled={busy} onClick={() => openModal({ kind: 'password', row })}>
                                        {t('admin.users.actPassword')}
                                    </button>
                                    <button className={actBtnCls} disabled={busy} onClick={() => openModal({ kind: 'quota', row })}>
                                        {t('admin.users.actQuota')}
                                    </button>
                                    {row.enabled ? (
                                        <button
                                            className={actBtnCls}
                                            disabled={busy || cannotDisable}
                                            title={isDefault ? t('admin.users.defaultProtected') : isSelf ? t('admin.users.selfProtected') : undefined}
                                            onClick={() => openModal({ kind: 'disable', row })}
                                        >
                                            {t('admin.users.actDisable')}
                                        </button>
                                    ) : (
                                        <button
                                            className={actBtnCls}
                                            disabled={busy}
                                            style={{ color: 'var(--status-ok)' }}
                                            onClick={() => runDirectAction(row.handle, () => enableUserHandle(row.handle))}
                                        >
                                            {t('admin.users.actEnable')}
                                        </button>
                                    )}
                                    {row.admin ? (
                                        <button
                                            className={actBtnCls}
                                            disabled={busy || cannotDemote}
                                            title={isSelf ? t('admin.users.selfProtected') : undefined}
                                            onClick={() => openModal({ kind: 'demote', row })}
                                        >
                                            {t('admin.users.actDemote')}
                                        </button>
                                    ) : (
                                        <button
                                            className={actBtnCls}
                                            disabled={busy}
                                            onClick={() => runDirectAction(row.handle, () => promoteUserHandle(row.handle))}
                                        >
                                            {t('admin.users.actPromote')}
                                        </button>
                                    )}
                                    <button
                                        className={actBtnCls}
                                        disabled={busy || cannotDelete}
                                        style={{ color: cannotDelete ? undefined : 'var(--status-danger)' }}
                                        title={isDefault ? t('admin.users.defaultProtected') : isSelf ? t('admin.users.selfProtected') : undefined}
                                        onClick={() => openModal({ kind: 'delete', row })}
                                    >
                                        {t('admin.users.actDelete')}
                                    </button>
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}

            {/* 各类弹窗与危险动作二次确认 */}
            {modal?.kind === 'rename' && (
                <ConfirmDialog
                    title={`${t('admin.users.renameTitle')} · ${modal.row.handle}`}
                    confirmLabel={t('admin.common.save')}
                    busy={modalBusy}
                    confirmDisabled={!modalInput.trim()}
                    onConfirm={submitModal}
                    onCancel={() => setModal(null)}
                >
                    <input
                        autoFocus
                        value={modalInput}
                        onChange={(e) => setModalInput(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') submitModal(); }}
                        className={inputCls}
                        style={{ background: 'var(--bg-canvas)', borderColor: 'var(--border-hairline)', color: 'var(--fg-primary)' }}
                    />
                    {modalErr && <div className={`text-[11.5px] ${mono} text-[color:var(--status-danger)]`}>{modalErr}</div>}
                </ConfirmDialog>
            )}

            {modal?.kind === 'password' && (
                <ConfirmDialog
                    title={`${t('admin.users.pwdTitle')} · ${modal.row.handle}`}
                    desc={t('admin.users.pwdHint')}
                    confirmLabel={t('admin.common.save')}
                    busy={modalBusy}
                    onConfirm={submitModal}
                    onCancel={() => setModal(null)}
                >
                    <input
                        autoFocus
                        type="password"
                        value={modalInput}
                        onChange={(e) => setModalInput(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') submitModal(); }}
                        placeholder={t('admin.users.fieldPwdPh')}
                        className={inputCls}
                        style={{ background: 'var(--bg-canvas)', borderColor: 'var(--border-hairline)', color: 'var(--fg-primary)' }}
                    />
                    {modalErr && <div className={`text-[11.5px] ${mono} text-[color:var(--status-danger)]`}>{modalErr}</div>}
                </ConfirmDialog>
            )}

            {modal?.kind === 'quota' && (
                <ConfirmDialog
                    title={`${t('admin.users.quotaTitle')} · ${modal.row.handle}`}
                    desc={t('admin.users.quotaHint')}
                    confirmLabel={t('admin.common.save')}
                    busy={modalBusy}
                    onConfirm={submitModal}
                    onCancel={() => setModal(null)}
                >
                    <input
                        autoFocus
                        value={modalInput}
                        onChange={(e) => setModalInput(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') submitModal(); }}
                        placeholder={t('admin.users.quotaPh')}
                        className={`${inputCls} ${mono}`}
                        style={{ background: 'var(--bg-canvas)', borderColor: 'var(--border-hairline)', color: 'var(--fg-primary)' }}
                    />
                    {modalErr && <div className={`text-[11.5px] ${mono} text-[color:var(--status-danger)]`}>{modalErr}</div>}
                </ConfirmDialog>
            )}

            {modal?.kind === 'disable' && (
                <ConfirmDialog
                    title={`${t('admin.users.disableTitle')} · ${modal.row.handle}`}
                    desc={t('admin.users.disableDesc')}
                    danger
                    confirmLabel={t('admin.users.actDisable')}
                    busy={modalBusy}
                    onConfirm={submitModal}
                    onCancel={() => setModal(null)}
                >
                    {modalErr && <div className={`text-[11.5px] ${mono} text-[color:var(--status-danger)]`}>{modalErr}</div>}
                </ConfirmDialog>
            )}

            {modal?.kind === 'demote' && (
                <ConfirmDialog
                    title={`${t('admin.users.demoteTitle')} · ${modal.row.handle}`}
                    desc={t('admin.users.demoteDesc')}
                    danger
                    confirmLabel={t('admin.users.actDemote')}
                    busy={modalBusy}
                    onConfirm={submitModal}
                    onCancel={() => setModal(null)}
                >
                    {modalErr && <div className={`text-[11.5px] ${mono} text-[color:var(--status-danger)]`}>{modalErr}</div>}
                </ConfirmDialog>
            )}

            {modal?.kind === 'delete' && (
                <ConfirmDialog
                    title={`${t('admin.users.deleteTitle')} · ${modal.row.handle}`}
                    desc={t('admin.users.deleteDesc')}
                    danger
                    confirmLabel={t('admin.users.actDelete')}
                    busy={modalBusy}
                    confirmDisabled={deleteTyped !== modal.row.handle}
                    onConfirm={submitModal}
                    onCancel={() => setModal(null)}
                >
                    <label
                        className="flex cursor-pointer items-start gap-2.5 rounded-lg p-2.5 text-[12px]"
                        style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-hairline)' }}
                    >
                        <input
                            type="checkbox"
                            className="mt-0.5 shrink-0"
                            checked={deletePurge}
                            onChange={(e) => setDeletePurge(e.target.checked)}
                        />
                        <div>
                            <div className="font-medium text-[color:var(--fg-primary)]">{t('admin.users.deletePurge')}</div>
                            {deletePurge && (
                                <div className="mt-1 text-[11px] leading-relaxed text-[color:var(--status-danger)]">
                                    {t('admin.users.deletePurgeWarn')}
                                </div>
                            )}
                        </div>
                    </label>
                    <div className="space-y-1.5">
                        <label className="block text-[11.5px] text-[color:var(--fg-secondary)]">
                            {t('admin.users.deleteTypeLabel')} <span className={`font-semibold text-[color:var(--fg-primary)] ${mono}`}>{modal.row.handle}</span>
                        </label>
                        <input
                            autoFocus
                            value={deleteTyped}
                            onChange={(e) => setDeleteTyped(e.target.value)}
                            placeholder={modal.row.handle}
                            className={`${inputCls} ${mono}`}
                            style={{ background: 'var(--bg-canvas)', borderColor: 'var(--border-hairline)', color: 'var(--fg-primary)' }}
                        />
                    </div>
                    {modalErr && <div className={`text-[11.5px] ${mono} text-[color:var(--status-danger)]`}>{modalErr}</div>}
                </ConfirmDialog>
            )}
        </div>
    );
}

/* ------------------------------------------------------------------ */
/* 3. 服务端配置 Config(访问表单 ↔ config.yaml 同源双写 + admin settings) */
/* ------------------------------------------------------------------ */

interface ConfigBundle {
    config: ConfigDocument;
    settings: AdminSettings;
}

const ACCESS_TOGGLES: { key: keyof ConfigAccessFlags; labelKey: string; descKey: string }[] = [
    { key: 'listen', labelKey: 'admin.cfg.key.listen', descKey: 'admin.cfg.key.listenDesc' },
    { key: 'whitelistMode', labelKey: 'admin.cfg.key.whitelistMode', descKey: 'admin.cfg.key.whitelistModeDesc' },
    { key: 'basicAuthMode', labelKey: 'admin.cfg.key.basicAuthMode', descKey: 'admin.cfg.key.basicAuthModeDesc' },
    { key: 'perUserBasicAuth', labelKey: 'admin.cfg.key.perUserBasicAuth', descKey: 'admin.cfg.key.perUserBasicAuthDesc' },
    { key: 'enableUserAccounts', labelKey: 'admin.cfg.key.enableUserAccounts', descKey: 'admin.cfg.key.enableUserAccountsDesc' },
    { key: 'enableServerPlugins', labelKey: 'admin.cfg.key.enableServerPlugins', descKey: 'admin.cfg.key.enableServerPluginsDesc' },
];

function ConfigSection() {
    const { t } = useI18n();
    const s = useShell();
    const remote = useRemote('admin:config', () =>
        guardForbidden(async (): Promise<ConfigBundle> => {
            const [config, settings] = await Promise.all([getServerConfig(), getAdminSettings()]);
            return { config, settings };
        }),
    );

    const [serverYaml, setServerYaml] = useState('');
    const [yamlDraft, setYamlDraft] = useState('');
    const [saveBusy, setSaveBusy] = useState(false);
    const [saveErr, setSaveErr] = useState<{ message: string; codes: string[] } | null>(null);
    const [restartNote, setRestartNote] = useState(false);
    const [confirmSave, setConfirmSave] = useState(false);
    const [confirmReload, setConfirmReload] = useState(false);

    /* admin settings 本地表单态 */
    const [settingsDraft, setSettingsDraft] = useState<AdminSettings | null>(null);
    const [quotaMbInput, setQuotaMbInput] = useState('');
    const [oauthOpen, setOauthOpen] = useState(false);
    const [settingsBusy, setSettingsBusy] = useState(false);

    const loaded = remote.data && !remote.data.forbidden ? remote.data.value : null;

    useEffect(() => {
        if (!loaded) return;
        setServerYaml(loaded.config.content);
        setYamlDraft(loaded.config.content);
        setSaveErr(null);
        setSettingsDraft(loaded.settings);
        const q = loaded.settings.storage.defaultUserQuotaBytes;
        setQuotaMbInput(q >= 0 ? String(Math.round(q / (1024 * 1024))) : '');
    }, [loaded]);

    const dirty = yamlDraft !== serverYaml;
    const summary = useMemo(() => parseConfigSummary(yamlDraft), [yamlDraft]);
    const criticalDiff = useMemo(() => diffCriticalConfigKeys(serverYaml, yamlDraft), [serverYaml, yamlDraft]);

    const toggleFlag = useCallback((key: keyof ConfigAccessFlags) => {
        setYamlDraft((prev) => {
            const cur = parseConfigSummary(prev).access[key];
            return setYamlTopBool(prev, key, !cur);
        });
        setSaveErr(null);
    }, []);

    // 从访问开关推导出人类可读的当前态说明(不做联动禁逻辑,服务端安全闸兜底)
    const derivedPosture = useMemo(() => {
        const a = summary.access;
        const unsafe = a.listen && !a.whitelistMode && !a.basicAuthMode && !a.enableUserAccounts && !a.securityOverride;
        if (unsafe) return { unsafe: true, text: t('admin.cfg.derivedUnsafe') };
        const parts = [
            a.listen ? t('admin.cfg.derivedPublic') : t('admin.cfg.derivedLocal'),
            a.enableUserAccounts ? t('admin.cfg.derivedMulti') : t('admin.cfg.derivedSingle'),
        ];
        if (a.basicAuthMode && a.perUserBasicAuth) parts.push(t('admin.cfg.derivedPerUser'));
        return { unsafe: false, text: parts.join(' · ') };
    }, [summary, t]);

    const doSaveYaml = () => {
        if (saveBusy) return;
        setSaveBusy(true);
        setSaveErr(null);
        void saveServerConfig(yamlDraft)
            .then((res) => {
                setServerYaml(yamlDraft);
                setConfirmSave(false);
                setRestartNote(res.restartRecommended);
                s.hint(t('admin.cfg.saved'));
            })
            .catch((e) => {
                setConfirmSave(false);
                if (e instanceof ConfigSaveError) {
                    setSaveErr({ message: e.message, codes: e.codes });
                } else {
                    setSaveErr({ message: e instanceof Error ? e.message : String(e), codes: [] });
                }
            })
            .finally(() => setSaveBusy(false));
    };

    const doSaveSettings = () => {
        if (!settingsDraft || settingsBusy) return;
        const raw = quotaMbInput.trim();
        const mb = raw === '' ? -1 : Number(raw);
        const defaultUserQuotaBytes = Number.isFinite(mb) && mb >= 0 ? Math.floor(mb * 1024 * 1024) : -1;
        const next: AdminSettings = {
            ...settingsDraft,
            storage: { defaultUserQuotaBytes },
        };
        setSettingsBusy(true);
        void saveAdminSettings(next)
            .then((saved) => {
                setSettingsDraft(saved);
                s.hint(t('admin.cfg.settingsSaved'));
            })
            .catch((e) => s.hint(`${t('admin.users.opFailed')}: ${e instanceof Error ? e.message : String(e)}`, true))
            .finally(() => setSettingsBusy(false));
    };

    if (remote.error) return <PanelError error={remote.error} onRetry={remote.reload} />;
    if (remote.data?.forbidden) return <AdminForbiddenView />;

    return (
        <div className="space-y-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                    <h1 className="heading-tight text-title-lg font-semibold text-[color:var(--fg-primary)]">{t('admin.cfg.title')}</h1>
                    <p className="mt-1 text-[12.5px] text-[color:var(--fg-muted)]">{t('admin.cfg.sub')}</p>
                </div>
                <div className="flex items-center gap-2">
                    <button
                        className="ghost-btn h-8 gap-1.5 px-3 text-[12px]"
                        style={{ border: '1px solid var(--border-hairline)', background: 'var(--bg-surface)' }}
                        onClick={() => {
                            if (dirty) setConfirmReload(true);
                            else { remote.reload(); s.hint(t('admin.refreshed')); }
                        }}
                    >
                        <Icon name="refresh" size={14} />
                        <span>{t('admin.cfg.reload')}</span>
                    </button>
                    <button
                        className="h-8 rounded-lg px-3.5 text-[12px] font-medium transition-opacity"
                        style={{
                            background: 'var(--brand)',
                            color: 'var(--brand-fg)',
                            opacity: !dirty || saveBusy ? 0.45 : 1,
                        }}
                        disabled={!dirty || saveBusy}
                        onClick={() => setConfirmSave(true)}
                    >
                        {saveBusy ? t('admin.cfg.saving') : t('admin.cfg.save')}
                    </button>
                </div>
            </div>

            {!loaded ? (
                <div className="inset-group">
                    <div className="inset-row text-[12px] text-[color:var(--fg-faint)]">…</div>
                </div>
            ) : (
                <>
                    {/* 服务端安全闸 / YAML 错误提示条 */}
                    {saveErr && (
                        <div
                            className="space-y-1.5 rounded-[10px] p-3.5 text-[12px]"
                            style={{ background: 'var(--bg-surface)', border: '1px solid var(--status-danger)', color: 'var(--status-danger)' }}
                        >
                            {saveErr.codes.includes('CONFIG_UNSAFE_NO_AUTH') && (
                                <div className="font-medium">{t('admin.cfg.errUnsafeNoAuth')}</div>
                            )}
                            {saveErr.codes.includes('CONFIG_UNSAFE_NO_PROTOCOL') && (
                                <div className="font-medium">{t('admin.cfg.errUnsafeNoProto')}</div>
                            )}
                            <div className={`break-words text-[11px] opacity-90 ${mono}`}>{saveErr.message}</div>
                        </div>
                    )}

                    {/* 保存后重启提示 */}
                    {restartNote && (
                        <div
                            className="flex items-center justify-between gap-3 rounded-[10px] px-3.5 py-2.5 text-[12px]"
                            style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-strong)', color: 'var(--fg-secondary)' }}
                        >
                            <span>{t('admin.cfg.restartNote')}</span>
                            <button className="ghost-btn h-6 w-6 shrink-0" onClick={() => setRestartNote(false)}>
                                <Icon name="x" size={13} />
                            </button>
                        </div>
                    )}

                    {/* 1. 访问控制快捷组(同源改写 yamlDraft) */}
                    <div className="space-y-2">
                        <div className="flex flex-wrap items-center justify-between gap-2 px-0.5">
                            <span className="text-[11.5px] font-medium text-[color:var(--fg-muted)]">{t('admin.cfg.accessTitle')}</span>
                            <span className="text-[11px] text-[color:var(--fg-faint)]">{t('admin.cfg.accessSub')}</span>
                        </div>
                        <div className="inset-group">
                            {ACCESS_TOGGLES.map((item) => (
                                <div key={item.key} className="inset-row">
                                    <div className="min-w-0">
                                        <div className="text-[12.5px] font-medium text-[color:var(--fg-primary)]">{t(item.labelKey)}</div>
                                        <div className="mt-0.5 text-[11px] text-[color:var(--fg-muted)]">{t(item.descKey)}</div>
                                    </div>
                                    <AdminSwitch on={summary.access[item.key]} onToggle={() => toggleFlag(item.key)} />
                                </div>
                            ))}
                            {/* 实时推导态 */}
                            <div className="inset-row" style={{ background: 'var(--bg-canvas)' }}>
                                <span className="flex min-w-0 items-center gap-2 text-[12px]">
                                    <StatusDot color={derivedPosture.unsafe ? 'var(--status-danger)' : 'var(--status-ok)'} />
                                    <span className="text-[color:var(--fg-muted)]">{t('admin.cfg.derivedLabel')}</span>
                                    <span style={{ color: derivedPosture.unsafe ? 'var(--status-danger)' : 'var(--fg-primary)' }}>
                                        {derivedPosture.text}
                                    </span>
                                </span>
                            </div>
                        </div>
                    </div>

                    {/* 运行关键参数一览 */}
                    <div className="space-y-2">
                        <div className="px-0.5 text-[11.5px] font-medium text-[color:var(--fg-muted)]">{t('admin.cfg.runtimeStrip')}</div>
                        <div className="inset-group">
                            <div className="inset-row flex-wrap gap-y-2">
                                <div className={`flex flex-wrap items-center gap-x-5 gap-y-1.5 text-[12px] ${mono}`}>
                                    <span><span className="text-[color:var(--fg-muted)]">port:</span> {summary.port}</span>
                                    <span><span className="text-[color:var(--fg-muted)]">dataRoot:</span> {summary.dataRoot}</span>
                                    <span><span className="text-[color:var(--fg-muted)]">storage.mode:</span> {summary.storageMode}</span>
                                    <span><span className="text-[color:var(--fg-muted)]">ipv4/ipv6:</span> {summary.ipv4}/{summary.ipv6}</span>
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* 2. config.yaml 原文编辑器 */}
                    <div className="space-y-2">
                        <div className="flex flex-wrap items-center justify-between gap-2 px-0.5">
                            <div className="flex items-center gap-2">
                                <span className="text-[11.5px] font-medium text-[color:var(--fg-muted)]">{t('admin.cfg.yamlTitle')}</span>
                                <span className={`text-[10.5px] ${mono} text-[color:var(--fg-faint)]`}>{loaded.config.path}</span>
                            </div>
                            {dirty && <WiredBadge warn>{t('admin.cfg.dirty')}</WiredBadge>}
                        </div>
                        <textarea
                            rows={16}
                            spellCheck={false}
                            value={yamlDraft}
                            onChange={(e) => { setYamlDraft(e.target.value); setSaveErr(null); }}
                            className={`w-full select-text rounded-[10px] border p-3.5 text-[11.5px] leading-relaxed outline-none ${mono}`}
                            style={{
                                background: 'var(--bg-surface)',
                                borderColor: dirty ? 'var(--border-strong)' : 'var(--border-hairline)',
                                color: 'var(--fg-primary)',
                            }}
                        />
                    </div>

                    {/* 3. 实例管理设置 (admin settings) */}
                    {settingsDraft && (
                        <div className="space-y-2">
                            <div className="flex flex-wrap items-center justify-between gap-2 px-0.5">
                                <div>
                                    <span className="text-[11.5px] font-medium text-[color:var(--fg-muted)]">{t('admin.cfg.adminSettingsTitle')}</span>
                                    <span className="ml-2 text-[11px] text-[color:var(--fg-faint)]">{t('admin.cfg.adminSettingsSub')}</span>
                                </div>
                                <button
                                    className="h-7 rounded-lg px-3 text-[11.5px] font-medium"
                                    style={{
                                        background: 'var(--primary-bg)',
                                        color: 'var(--primary-fg)',
                                        opacity: settingsBusy ? 0.5 : 1,
                                    }}
                                    disabled={settingsBusy}
                                    onClick={doSaveSettings}
                                >
                                    {t('admin.cfg.saveSettings')}
                                </button>
                            </div>
                            <div className="inset-group">
                                <div className="inset-row">
                                    <label className="text-[12.5px] text-[color:var(--fg-primary)]">{t('admin.cfg.defaultQuota')}</label>
                                    <input
                                        value={quotaMbInput}
                                        onChange={(e) => setQuotaMbInput(e.target.value)}
                                        placeholder={t('admin.cfg.defaultQuotaPh')}
                                        className={`h-8 w-[170px] rounded-lg border px-2.5 text-right text-[12px] outline-none ${mono}`}
                                        style={{ background: 'var(--bg-canvas)', borderColor: 'var(--border-hairline)', color: 'var(--fg-primary)' }}
                                    />
                                </div>
                                <div className="inset-row">
                                    <div className="min-w-0">
                                        <div className="text-[12.5px] text-[color:var(--fg-primary)]">{t('admin.cfg.regEnabled')}</div>
                                        <div className="mt-0.5 text-[11px] text-[color:var(--fg-muted)]">{t('admin.cfg.regEnabledDesc')}</div>
                                    </div>
                                    <AdminSwitch
                                        on={settingsDraft.accountRegistration.enabled}
                                        onToggle={() =>
                                            setSettingsDraft((prev) =>
                                                prev ? { ...prev, accountRegistration: { enabled: !prev.accountRegistration.enabled } } : prev,
                                            )
                                        }
                                    />
                                </div>
                                {/* OAuth 折叠组 */}
                                <button
                                    type="button"
                                    className="inset-row inset-row-btn"
                                    onClick={() => setOauthOpen((v) => !v)}
                                >
                                    <span className="text-[12px] text-[color:var(--fg-secondary)]">{t('admin.cfg.oauthFold')}</span>
                                    <Icon name={oauthOpen ? 'chevronDown' : 'chevronRight'} size={14} className="text-[color:var(--fg-faint)]" />
                                </button>
                                {oauthOpen && (
                                    <div className="space-y-4 border-t border-[color:var(--border-hairline)] p-4">
                                        {/* GitHub */}
                                        <div className="space-y-2">
                                            <div className="flex items-center justify-between">
                                                <span className="text-[12px] font-medium text-[color:var(--fg-primary)]">GitHub OAuth</span>
                                                <div className="flex items-center gap-3">
                                                    <span className="text-[11px] text-[color:var(--fg-muted)]">{t('admin.cfg.oauthEnabled')}</span>
                                                    <AdminSwitch
                                                        on={settingsDraft.oauth.github.enabled}
                                                        onToggle={() =>
                                                            setSettingsDraft((prev) =>
                                                                prev
                                                                    ? { ...prev, oauth: { ...prev.oauth, github: { ...prev.oauth.github, enabled: !prev.oauth.github.enabled } } }
                                                                    : prev,
                                                            )
                                                        }
                                                    />
                                                </div>
                                            </div>
                                            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                                                <input
                                                    value={settingsDraft.oauth.github.clientId}
                                                    onChange={(e) =>
                                                        setSettingsDraft((prev) =>
                                                            prev ? { ...prev, oauth: { ...prev.oauth, github: { ...prev.oauth.github, clientId: e.target.value } } } : prev,
                                                        )
                                                    }
                                                    placeholder={t('admin.cfg.oauthClientId')}
                                                    className={`${inputCls} ${mono}`}
                                                    style={{ background: 'var(--bg-canvas)', borderColor: 'var(--border-hairline)', color: 'var(--fg-primary)' }}
                                                />
                                                <input
                                                    type="password"
                                                    value={settingsDraft.oauth.github.clientSecret}
                                                    onChange={(e) =>
                                                        setSettingsDraft((prev) =>
                                                            prev ? { ...prev, oauth: { ...prev.oauth, github: { ...prev.oauth.github, clientSecret: e.target.value } } } : prev,
                                                        )
                                                    }
                                                    placeholder={t('admin.cfg.oauthClientSecret')}
                                                    className={`${inputCls} ${mono}`}
                                                    style={{ background: 'var(--bg-canvas)', borderColor: 'var(--border-hairline)', color: 'var(--fg-primary)' }}
                                                />
                                            </div>
                                        </div>
                                        {/* Discord */}
                                        <div className="space-y-2 border-t border-[color:var(--border-hairline)] pt-3">
                                            <div className="flex items-center justify-between">
                                                <span className="text-[12px] font-medium text-[color:var(--fg-primary)]">Discord OAuth</span>
                                                <div className="flex items-center gap-3">
                                                    <span className="text-[11px] text-[color:var(--fg-muted)]">{t('admin.cfg.oauthEnabled')}</span>
                                                    <AdminSwitch
                                                        on={settingsDraft.oauth.discord.enabled}
                                                        onToggle={() =>
                                                            setSettingsDraft((prev) =>
                                                                prev
                                                                    ? { ...prev, oauth: { ...prev.oauth, discord: { ...prev.oauth.discord, enabled: !prev.oauth.discord.enabled } } }
                                                                    : prev,
                                                            )
                                                        }
                                                    />
                                                </div>
                                            </div>
                                            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                                                <input
                                                    value={settingsDraft.oauth.discord.clientId}
                                                    onChange={(e) =>
                                                        setSettingsDraft((prev) =>
                                                            prev ? { ...prev, oauth: { ...prev.oauth, discord: { ...prev.oauth.discord, clientId: e.target.value } } } : prev,
                                                        )
                                                    }
                                                    placeholder={t('admin.cfg.oauthClientId')}
                                                    className={`${inputCls} ${mono}`}
                                                    style={{ background: 'var(--bg-canvas)', borderColor: 'var(--border-hairline)', color: 'var(--fg-primary)' }}
                                                />
                                                <input
                                                    type="password"
                                                    value={settingsDraft.oauth.discord.clientSecret}
                                                    onChange={(e) =>
                                                        setSettingsDraft((prev) =>
                                                            prev ? { ...prev, oauth: { ...prev.oauth, discord: { ...prev.oauth.discord, clientSecret: e.target.value } } } : prev,
                                                        )
                                                    }
                                                    placeholder={t('admin.cfg.oauthClientSecret')}
                                                    className={`${inputCls} ${mono}`}
                                                    style={{ background: 'var(--bg-canvas)', borderColor: 'var(--border-hairline)', color: 'var(--fg-primary)' }}
                                                />
                                            </div>
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>
                    )}
                </>
            )}

            {/* 保存 config.yaml 二次确认 */}
            {confirmSave && (
                <ConfirmDialog
                    title={t('admin.cfg.saveConfirmTitle')}
                    desc={t('admin.cfg.saveConfirmDesc')}
                    danger={criticalDiff.length > 0}
                    confirmLabel={t('admin.cfg.save')}
                    busy={saveBusy}
                    onConfirm={doSaveYaml}
                    onCancel={() => setConfirmSave(false)}
                >
                    {criticalDiff.length > 0 ? (
                        <div className="inset-group">
                            {criticalDiff.map((c) => (
                                <div key={c.key} className={`inset-row text-[11.5px] ${mono}`}>
                                    <span className="text-[color:var(--fg-primary)]">{c.key}</span>
                                    <span className="text-[color:var(--fg-muted)]">
                                        {String(c.from)} → <span className="font-semibold text-[color:var(--brand)]">{String(c.to)}</span>
                                    </span>
                                </div>
                            ))}
                        </div>
                    ) : (
                        <div className="text-[12px] text-[color:var(--fg-muted)]">{t('admin.cfg.saveConfirmRawOnly')}</div>
                    )}
                </ConfirmDialog>
            )}

            {/* 放弃未保存草稿二次确认 */}
            {confirmReload && (
                <ConfirmDialog
                    title={t('admin.cfg.reloadConfirmTitle')}
                    desc={t('admin.cfg.reloadConfirmDesc')}
                    danger
                    confirmLabel={t('admin.cfg.reload')}
                    onConfirm={() => {
                        setConfirmReload(false);
                        remote.reload();
                        s.hint(t('admin.refreshed'));
                    }}
                    onCancel={() => setConfirmReload(false)}
                />
            )}
        </div>
    );
}

/* ------------------------------------------------------------------ */
/* 4. 共享密钥(TASK-072 §2.3 六动词:admin 也只见掩码)                      */
/* ------------------------------------------------------------------ */

const SHARE_MODES: SharedSecretMode[] = ['all', 'handles', 'none'];

/** 单条共享密钥行:masked + 可见性 ACL(all/handles/none + 名单)+ 激活/删除。 */
function SharedEntryRow({
    keyName,
    en,
    busy,
    onVis,
    onRotate,
    onDelete,
}: {
    keyName: string;
    en: SharedSecretEntry;
    busy: boolean;
    onVis: (mode: SharedSecretMode, handles?: string[]) => void;
    onRotate: () => void;
    onDelete: () => void;
}) {
    const { t } = useI18n();
    const curMode = (en.share?.mode ?? 'none') as SharedSecretMode;
    const curHandles = (en.share?.handles ?? []).join(', ');
    const [mode, setMode] = useState<SharedSecretMode>(curMode);
    const [handlesCsv, setHandlesCsv] = useState(curHandles);
    useEffect(() => { setMode(curMode); setHandlesCsv(curHandles); }, [curMode, curHandles, en.id]);
    const dirty = mode !== curMode || (mode === 'handles' && handlesCsv !== curHandles);

    const applyVis = () => {
        const handles = handlesCsv.split(',').map((h) => h.trim()).filter(Boolean);
        onVis(mode, mode === 'handles' ? handles : undefined);
    };

    return (
        <div
            className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3"
            style={{ borderBottom: '1px solid var(--border-hairline)' }}
        >
            <div className="min-w-0 flex-1 basis-52">
                <div className={`truncate text-[12px] font-medium text-[color:var(--fg-primary)] ${mono}`}>
                    {keyName}
                    {en.label ? <span className="ml-1.5 text-[10.5px] font-normal text-[color:var(--fg-muted)]">{en.label}</span> : null}
                </div>
                <div className={`mt-0.5 flex items-center gap-1.5 truncate text-[10.5px] ${mono}`} style={{ color: 'var(--fg-faint)' }}>
                    {en.masked}
                    {en.active && (
                        <span className="inline-flex items-center gap-1" style={{ color: 'var(--status-ok)' }}>
                            <StatusDot color="var(--status-ok)" />{t('admin.keys.active')}
                        </span>
                    )}
                </div>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
                <select
                    value={mode}
                    disabled={busy}
                    onChange={(e) => setMode(e.target.value as SharedSecretMode)}
                    className="h-7 rounded-md border px-1.5 text-[11px] outline-none"
                    style={{ background: 'var(--bg-canvas)', borderColor: 'var(--border-hairline)', color: 'var(--fg-primary)' }}
                    title={t('admin.keys.visibility')}
                >
                    {SHARE_MODES.map((m) => <option key={m} value={m}>{t(`admin.keys.mode.${m}`)}</option>)}
                </select>
                {mode === 'handles' && (
                    <input
                        value={handlesCsv}
                        disabled={busy}
                        onChange={(e) => setHandlesCsv(e.target.value)}
                        placeholder={t('admin.keys.handlesPh')}
                        className={`h-7 w-40 rounded-md border px-2 text-[11px] outline-none ${mono}`}
                        style={{ background: 'var(--bg-canvas)', borderColor: 'var(--border-hairline)', color: 'var(--fg-primary)' }}
                    />
                )}
                {dirty && (
                    <button
                        className="h-7 rounded-md px-2.5 text-[11px] font-medium"
                        style={{ background: 'var(--brand)', color: 'var(--brand-fg)' }}
                        disabled={busy}
                        onClick={applyVis}
                    >
                        {t('admin.keys.applyVis')}
                    </button>
                )}
                {!en.active && (
                    <button
                        className="ghost-btn h-7 px-2 text-[11px]"
                        disabled={busy}
                        title={t('admin.keys.activate')}
                        onClick={onRotate}
                    >
                        {t('admin.keys.activate')}
                    </button>
                )}
                <button
                    className="ghost-btn h-7 w-7"
                    disabled={busy}
                    title={t('admin.keys.delete')}
                    style={{ color: 'var(--status-danger)' }}
                    onClick={onDelete}
                >
                    <Icon name="trash" size={12} />
                </button>
            </div>
        </div>
    );
}

function KeysSection() {
    const { t } = useI18n();
    const s = useShell();
    const remote = useRemote('admin:shared-keys', () =>
        guardForbidden(async () => ({
            shared: await listSharedSecrets(),
            mine: await listSecrets(),
        })));

    const [createOpen, setCreateOpen] = useState(false);
    const [wKey, setWKey] = useState('');
    const [wValue, setWValue] = useState('');
    const [wLabel, setWLabel] = useState('');
    const [wMode, setWMode] = useState<SharedSecretMode>('all');
    const [wHandles, setWHandles] = useState('');
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState<string | null>(null);
    const [confirmDel, setConfirmDel] = useState<{ key: string; en: SharedSecretEntry } | null>(null);

    if (remote.error) return <PanelError error={remote.error} onRetry={remote.reload} />;
    if (remote.data?.forbidden) return <AdminForbiddenView />;

    const d = remote.data?.value ?? null;
    const items = d?.shared.items ?? {};
    const allKeys = Object.keys(items);
    const sharedKeys = allKeys.filter((k) => items[k]?.length);
    const myKeys = Object.keys(d?.mine.secrets ?? {}).filter((k) => d!.mine.secrets[k]?.length);

    const run = (fn: () => Promise<unknown>) => {
        if (busy) return;
        setBusy(true);
        setErr(null);
        void fn()
            .then(() => { remote.reload(); s.hint(t('admin.keys.done')); })
            .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
            .finally(() => setBusy(false));
    };

    const submitWrite = () => {
        if (!wKey || !wValue.trim()) return;
        run(() => writeSharedSecret({
            key: wKey,
            value: wValue.trim(),
            ...(wLabel.trim() ? { label: wLabel.trim() } : {}),
            mode: wMode,
            ...(wMode === 'handles'
                ? { handles: wHandles.split(',').map((h) => h.trim()).filter(Boolean) }
                : {}),
        }).then(() => {
            setWValue('');
            setWLabel('');
            setWHandles('');
            setCreateOpen(false);
        }));
    };

    return (
        <div className="space-y-5">
            {/* 页头 */}
            <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                    <h1 className="heading-tight text-title-lg font-semibold text-[color:var(--fg-primary)]">{t('admin.keys.title')}</h1>
                    <p className="mt-1 text-[12.5px] text-[color:var(--fg-muted)]">{t('admin.keys.sub')}</p>
                </div>
                <div className="flex items-center gap-2">
                    <button
                        className="ghost-btn h-8 gap-1.5 px-3 text-[12px]"
                        style={{ border: '1px solid var(--border-hairline)', background: 'var(--bg-surface)' }}
                        onClick={() => { remote.reload(); s.hint(t('admin.refreshed')); }}
                    >
                        <Icon name="refresh" size={14} />
                        <span>{t('admin.refresh')}</span>
                    </button>
                    <button
                        className="inline-flex h-8 items-center gap-1.5 rounded-lg px-3.5 text-[12px] font-medium"
                        style={{ background: 'var(--brand)', color: 'var(--brand-fg)' }}
                        onClick={() => { setCreateOpen((v) => !v); setErr(null); }}
                    >
                        <Icon name={createOpen ? 'x' : 'plus'} size={14} />
                        <span>{t('admin.keys.new')}</span>
                    </button>
                </div>
            </div>

            {/* 说明条:共享档语义一句话(布局讲清优先级,不堆文案) */}
            <div
                className="rounded-[10px] px-3.5 py-2.5 text-[12px] leading-relaxed"
                style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-hairline)', color: 'var(--fg-secondary)' }}
            >
                {t('admin.keys.banner')}
            </div>

            {/* 新建共享密钥折叠表单 */}
            {createOpen && (
                <div
                    className="space-y-3 rounded-[12px] p-4"
                    style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-strong)', boxShadow: 'var(--shadow-card)' }}
                >
                    <div className="heading-tight text-[13px] font-semibold text-[color:var(--fg-primary)]">
                        {t('admin.keys.createTitle')}
                    </div>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <div className="space-y-1">
                            <label className="block text-[11px] text-[color:var(--fg-muted)]">{t('admin.keys.fieldKey')}</label>
                            <select
                                value={wKey}
                                onChange={(e) => setWKey(e.target.value)}
                                className={`${inputCls} ${mono}`}
                                style={{ background: 'var(--bg-canvas)', borderColor: 'var(--border-hairline)', color: 'var(--fg-primary)' }}
                            >
                                <option value="">{t('admin.keys.fieldKeyPh')}</option>
                                {allKeys.map((k) => <option key={k} value={k}>{k}</option>)}
                            </select>
                        </div>
                        <div className="space-y-1">
                            <label className="block text-[11px] text-[color:var(--fg-muted)]">{t('admin.keys.fieldValue')}</label>
                            <input
                                type="password"
                                value={wValue}
                                onChange={(e) => setWValue(e.target.value)}
                                placeholder={t('admin.keys.fieldValuePh')}
                                className={`${inputCls} ${mono}`}
                                style={{ background: 'var(--bg-canvas)', borderColor: 'var(--border-hairline)', color: 'var(--fg-primary)' }}
                            />
                        </div>
                        <div className="space-y-1">
                            <label className="block text-[11px] text-[color:var(--fg-muted)]">{t('admin.keys.fieldLabel')}</label>
                            <input
                                value={wLabel}
                                onChange={(e) => setWLabel(e.target.value)}
                                placeholder={t('admin.keys.fieldLabelPh')}
                                className={inputCls}
                                style={{ background: 'var(--bg-canvas)', borderColor: 'var(--border-hairline)', color: 'var(--fg-primary)' }}
                            />
                        </div>
                        <div className="space-y-1">
                            <label className="block text-[11px] text-[color:var(--fg-muted)]">{t('admin.keys.visibility')}</label>
                            <select
                                value={wMode}
                                onChange={(e) => setWMode(e.target.value as SharedSecretMode)}
                                className={inputCls}
                                style={{ background: 'var(--bg-canvas)', borderColor: 'var(--border-hairline)', color: 'var(--fg-primary)' }}
                            >
                                {SHARE_MODES.map((m) => <option key={m} value={m}>{t(`admin.keys.mode.${m}`)}</option>)}
                            </select>
                        </div>
                        {wMode === 'handles' && (
                            <div className="space-y-1 sm:col-span-2">
                                <label className="block text-[11px] text-[color:var(--fg-muted)]">{t('admin.keys.handlesLabel')}</label>
                                <input
                                    value={wHandles}
                                    onChange={(e) => setWHandles(e.target.value)}
                                    placeholder={t('admin.keys.handlesPh')}
                                    className={`${inputCls} ${mono}`}
                                    style={{ background: 'var(--bg-canvas)', borderColor: 'var(--border-hairline)', color: 'var(--fg-primary)' }}
                                />
                            </div>
                        )}
                    </div>
                    <div className="flex items-center justify-end gap-2 pt-1">
                        <button
                            className="h-8 rounded-lg px-3 text-[12px] text-[color:var(--fg-secondary)] hover:bg-[color:var(--bg-active)]"
                            disabled={busy}
                            onClick={() => setCreateOpen(false)}
                        >
                            {t('admin.common.cancel')}
                        </button>
                        <button
                            className="h-8 rounded-lg px-3.5 text-[12px] font-medium"
                            style={{ background: 'var(--brand)', color: 'var(--brand-fg)', opacity: busy || !wKey || !wValue.trim() ? 0.45 : 1 }}
                            disabled={busy || !wKey || !wValue.trim()}
                            onClick={submitWrite}
                        >
                            {t('admin.keys.create')}
                        </button>
                    </div>
                </div>
            )}

            {err && (
                <div className={`rounded-lg px-3 py-2 text-[11.5px] ${mono}`} style={{ background: 'var(--bg-surface)', color: 'var(--status-danger)' }}>
                    {err}
                </div>
            )}

            {/* 共享档条目(按 key 分组;每条 masked,永不回显明文) */}
            {sharedKeys.length === 0 && !remote.loading ? (
                <PanelEmpty icon="shield" desc={t('admin.keys.emptyDesc')}>{t('admin.keys.empty')}</PanelEmpty>
            ) : (
                sharedKeys.map((key) => (
                    <div
                        key={key}
                        className="overflow-hidden rounded-[12px]"
                        style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-hairline)' }}
                    >
                        {items[key]!.map((en) => (
                            <SharedEntryRow
                                key={en.id}
                                keyName={key}
                                en={en}
                                busy={busy}
                                onVis={(mode, handles) => run(() => setSharedSecretVisibility(key, en.id, mode, handles))}
                                onRotate={() => run(() => rotateSharedSecret(key, en.id))}
                                onDelete={() => setConfirmDel({ key, en })}
                            />
                        ))}
                    </div>
                ))
            )}

            {/* 本人密钥 → promote(复制进共享档,不删原条) */}
            {myKeys.length > 0 && (
                <div className="space-y-2 pt-2">
                    <div className="text-[11px] font-medium text-[color:var(--fg-muted)]">{t('admin.keys.promoteTitle')}</div>
                    <div
                        className="overflow-hidden rounded-[12px]"
                        style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-hairline)' }}
                    >
                        {myKeys.map((key) => (d!.mine.secrets[key] ?? []).map((en) => (
                            <div
                                key={`${key}:${en.id}`}
                                className="flex items-center gap-3 px-4 py-2.5"
                                style={{ borderBottom: '1px solid var(--border-hairline)' }}
                            >
                                <div className="min-w-0 flex-1">
                                    <div className={`truncate text-[12px] font-medium text-[color:var(--fg-primary)] ${mono}`}>
                                        {key}
                                        {en.label ? <span className="ml-1.5 text-[10.5px] font-normal text-[color:var(--fg-muted)]">{en.label}</span> : null}
                                    </div>
                                    <div className={`truncate text-[10.5px] ${mono}`} style={{ color: 'var(--fg-faint)' }}>{en.value}</div>
                                </div>
                                <button
                                    className="ghost-btn h-7 shrink-0 px-2.5 text-[11px]"
                                    disabled={busy}
                                    title={t('admin.keys.promoteHint')}
                                    onClick={() => run(() => promoteSharedSecret(key, en.id))}
                                >
                                    {t('admin.keys.promote')}
                                </button>
                            </div>
                        )))}
                    </div>
                </div>
            )}

            {/* 删除二次确认 */}
            {confirmDel && (
                <ConfirmDialog
                    danger
                    title={t('admin.keys.deleteTitle')}
                    desc={`${confirmDel.key} · ${confirmDel.en.masked} — ${t('admin.keys.deleteDesc')}`}
                    confirmLabel={t('admin.keys.delete')}
                    busy={busy}
                    onConfirm={() => {
                        const { key, en } = confirmDel;
                        setConfirmDel(null);
                        run(() => deleteSharedSecret(key, en.id));
                    }}
                    onCancel={() => setConfirmDel(null)}
                />
            )}
        </div>
    );
}

/* ------------------------------------------------------------------ */
/* AdminView —— 顶层出口(移动端走 mob.view.noMobile 占位)                */
/* ------------------------------------------------------------------ */

export function AdminView() {
    const { t } = useI18n();
    const s = useShell();

    // 高级实例管理仅 web 桌面可见 —— 移动视口直达/切屏落统一 noMobile 占位(对齐 Overlays.tsx)。
    if (s.isMobile) {
        return (
            <div className="flex min-h-0 flex-1 flex-col" style={{ background: 'var(--bg-canvas)' }}>
                <PanelEmpty
                    icon="warning"
                    desc={t('mob.view.noMobile')}
                    action={{ label: t('mob.view.back'), onClick: () => s.setView('chat') }}
                >
                    {t('nav.admin')}
                </PanelEmpty>
            </div>
        );
    }

    const nav = normAdminNav(s.adminNav);
    return (
        <section className="flex h-full min-w-0 flex-1 flex-col" style={{ background: 'var(--bg-canvas)' }}>
            <div className="min-h-0 flex-1 overflow-y-auto px-6 py-8 sm:px-10">
                <div className="mx-auto max-w-4xl">
                    {nav === 'overview' && <OverviewSection />}
                    {nav === 'users' && <UsersSection />}
                    {nav === 'keys' && <KeysSection />}
                    {nav === 'config' && <ConfigSection />}
                </div>
            </div>
        </section>
    );
}
