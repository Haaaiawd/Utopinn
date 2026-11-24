// 管理域 API 薄层 —— 消费 apps/server/src/endpoints/users-admin.js +
// /api/storage/health + /api/utopinn/_kernel + /api/utopinn/connection/test。
// 约定:
//   · /api/users/* 为 POST-only 风格(连读面 overview/get/config/get 皆 POST),
//     写面多返回 204 No Content;
//   · 全部经 apiFetch(CSRF 齐);若 CSRF 轮换后仍 403 → 映射为 AdminForbiddenError,
//     供管理视图渲染「需要管理员 handle」友好空态;
//   · config/save 安全闸拒存(400 + codes[])→ 映射为 ConfigSaveError 供 UI 逐条列原因。
import { ApiError, apiFetch } from './client';

export class AdminForbiddenError extends ApiError {
    constructor(message = '需要管理员权限 (403)') {
        super(message, 403);
        this.name = 'AdminForbiddenError';
    }
}

export class ConfigSaveError extends ApiError {
    constructor(
        message: string,
        status: number,
        public readonly codes: string[] = [],
    ) {
        super(message, status);
        this.name = 'ConfigSaveError';
    }
}

export function isAdminForbidden(err: unknown): boolean {
    if (err instanceof AdminForbiddenError) return true;
    if (err instanceof ApiError && err.status === 403) return true;
    return false;
}

interface ParsedServerError {
    message: string;
    codes: string[];
}

async function readServerError(res: Response): Promise<ParsedServerError> {
    if (res.status === 502 && res.headers.has('x-utopinn-proxy-error')) {
        return { message: 'upstream_unavailable', codes: [] };
    }
    const raw = await res.text().catch(() => '');
    if (!raw) return { message: res.statusText || `HTTP ${res.status}`, codes: [] };
    try {
        const j = JSON.parse(raw) as { error?: unknown; message?: unknown; codes?: unknown };
        const msg =
            (typeof j.error === 'string' && j.error)
            || (typeof j.message === 'string' && j.message)
            || raw;
        const codes = Array.isArray(j.codes) ? j.codes.filter((c): c is string => typeof c === 'string') : [];
        return { message: msg, codes };
    } catch {
        return { message: raw, codes: [] };
    }
}

async function assertAdminOk(res: Response): Promise<void> {
    if (res.ok) return;
    const { message } = await readServerError(res);
    if (res.status === 403) throw new AdminForbiddenError(message);
    throw new ApiError(message, res.status);
}

async function adminPostJson<T>(path: string, body: unknown = {}): Promise<T> {
    const res = await apiFetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
    await assertAdminOk(res);
    return (await res.json()) as T;
}

async function adminPostVoid(path: string, body: unknown = {}): Promise<void> {
    const res = await apiFetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
    await assertAdminOk(res);
}

/* ------------------------------------------------------------------ */
/* 实例总览 / 内核 / 存储健康 / 上游连接探测                             */
/* ------------------------------------------------------------------ */

export interface AdminOAuthGithub {
    enabled: boolean;
    clientId: string;
    clientSecret: string;
    allowAutoCreate: boolean;
}

export interface AdminOAuthDiscord {
    enabled: boolean;
    clientId: string;
    clientSecret: string;
    allowAutoCreate: boolean;
    requireGuildMembership: boolean;
    allowedGuildIds: string[];
    requiredRoleIds: string[];
    scopes: string[];
}

export interface AdminSettings {
    storage: {
        defaultUserQuotaBytes: number;
    };
    accountRegistration: {
        enabled: boolean;
    };
    oauth: {
        github: AdminOAuthGithub;
        discord: AdminOAuthDiscord;
    };
}

export interface OverviewUser {
    handle: string;
    name: string;
    admin: boolean;
    enabled: boolean;
    password: boolean;
    created?: number;
    storageBytes: number;
    storageQuotaBytes: number;
    storageUsageRatio: number | null;
}

export interface AdminOverview {
    server: {
        nodeVersion: string;
        platform: string;
        uptimeSec: number;
        now: number;
    };
    totals: {
        users: number;
        enabledUsers: number;
        adminUsers: number;
        protectedUsers: number;
        storageBytes: number;
        overQuotaUsers: number;
    };
    settings: AdminSettings;
    users: OverviewUser[];
    security: {
        adminWithoutPassword: string[];
        disabledAdmins: string[];
        disabledUsers: string[];
    };
}

export interface AdminUserItem {
    handle: string;
    name: string;
    avatar: string;
    admin: boolean;
    enabled: boolean;
    created?: number;
    password: boolean;
    storageQuotaBytes: number | null;
    oauthProviders: string[];
}

export interface StorageHealth {
    ok: boolean;
    kind: string;
    schemaVersion?: number;
    latencyMs?: number;
    error?: string;
}

export interface StorageStatus {
    currentMode: string;
    migrationInProgress: boolean;
    readOnly: boolean;
    lastMigration: string | null;
    state: unknown;
}

export interface KernelSnapshot {
    routes: unknown[];
    services: unknown[];
}

export interface ConnectionProbeResult {
    ok: boolean;
    source: string;
    /** 哪层凭据在生效(TASK-072):user=本人档 shared=服务端共享 proxy=proxy_password none=无。 */
    credential: 'user' | 'shared' | 'proxy' | 'none';
    latencyMs: number;
    modelCount?: number;
    upstreamStatus: number | null;
    error?: string;
    detail?: string;
}

export interface LukerServerPlugin {
    directory: string;
    name?: string;
    id?: string;
    version?: string;
    description?: string;
    path?: string;
    repoUrl?: string;
    dependencyStatus?: {
        hasPackageJson?: boolean;
        installed?: boolean;
        missing?: string[];
        [extra: string]: unknown;
    };
    [extra: string]: unknown;
}

export interface LukerServerPluginsList {
    ok: boolean;
    enabled: boolean;
    pluginsPath: string;
    plugins: LukerServerPlugin[];
}

export interface ConfigDocument {
    path: string;
    content: string;
}

export interface ConfigSaveResult {
    ok: boolean;
    hotReloadApplied: boolean;
    restartRecommended: boolean;
}

/** POST /api/users/overview */
export function getAdminOverview(): Promise<AdminOverview> {
    return adminPostJson<AdminOverview>('/api/users/overview');
}

/** GET /api/storage/health —— 503 时仍带结构化 JSON({ok:false, kind, error})。 */
export async function getStorageHealth(): Promise<StorageHealth> {
    const res = await apiFetch('/api/storage/health');
    if (res.status === 502 && res.headers.has('x-utopinn-proxy-error')) {
        throw new ApiError('upstream_unavailable', 502);
    }
    const text = await res.text().catch(() => '');
    try {
        return JSON.parse(text) as StorageHealth;
    } catch {
        throw new ApiError(text || res.statusText, res.status);
    }
}

/** POST /api/users/storage/status */
export function getStorageStatus(): Promise<StorageStatus> {
    return adminPostJson<StorageStatus>('/api/users/storage/status');
}

/** GET /api/utopinn/_kernel —— Cordis 内核路由与服务注册清单。 */
export async function getKernelSnapshot(): Promise<KernelSnapshot> {
    const res = await apiFetch('/api/utopinn/_kernel');
    await assertAdminOk(res);
    return (await res.json()) as KernelSnapshot;
}

/** POST /api/utopinn/connection/test —— 按当前生效 oai_settings 探测上游。 */
export async function probeUpstreamConnection(): Promise<ConnectionProbeResult> {
    const res = await apiFetch('/api/utopinn/connection/test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
    });
    await assertAdminOk(res);
    return (await res.json()) as ConnectionProbeResult;
}

/** POST /api/users/plugins/list —— Luker 兼容服务端插件(plugins/ 目录,与 Cordis 独立)。 */
export function listLukerServerPlugins(): Promise<LukerServerPluginsList> {
    return adminPostJson<LukerServerPluginsList>('/api/users/plugins/list');
}

/* ------------------------------------------------------------------ */
/* 多 Handle 生命周期(users-admin.js)                                   */
/* ------------------------------------------------------------------ */

/** POST /api/users/get */
export function listAdminUsers(): Promise<AdminUserItem[]> {
    return adminPostJson<AdminUserItem[]>('/api/users/get');
}

/** POST /api/users/slugify —— 注意服务端返回纯文本而非 JSON。 */
export async function slugifyHandle(text: string): Promise<string> {
    const res = await apiFetch('/api/users/slugify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
    });
    await assertAdminOk(res);
    return res.text();
}

/** POST /api/users/create —— passwordSet:false = 账号无密码,只能靠 SSO/管理员重置。 */
export function createUserHandle(input: {
    handle: string;
    name: string;
    password?: string;
    admin?: boolean;
}): Promise<{ handle: string; passwordSet?: boolean }> {
    return adminPostJson<{ handle: string; passwordSet?: boolean }>('/api/users/create', input);
}

/** POST /api/users/enable */
export function enableUserHandle(handle: string): Promise<void> {
    return adminPostVoid('/api/users/enable', { handle });
}

/** POST /api/users/disable */
export function disableUserHandle(handle: string): Promise<void> {
    return adminPostVoid('/api/users/disable', { handle });
}

/** POST /api/users/promote */
export function promoteUserHandle(handle: string): Promise<void> {
    return adminPostVoid('/api/users/promote', { handle });
}

/** POST /api/users/demote */
export function demoteUserHandle(handle: string): Promise<void> {
    return adminPostVoid('/api/users/demote', { handle });
}

/** POST /api/users/set-quota —— storageQuotaBytes=null 或 <0 清除单户配额(回落默认/无限)。 */
export function setUserQuota(handle: string, storageQuotaBytes: number | null): Promise<void> {
    return adminPostVoid('/api/users/set-quota', { handle, storageQuotaBytes });
}

/** POST /api/users/delete —— purge=true 连数据目录一起物理删除。 */
export function deleteUserHandle(handle: string, purge: boolean): Promise<void> {
    return adminPostVoid('/api/users/delete', { handle, purge });
}

/* ------------------------------------------------------------------ */
/* 服务端配置(config.yaml + admin settings)                             */
/* ------------------------------------------------------------------ */

/** POST /api/users/config/get */
export function getServerConfig(): Promise<ConfigDocument> {
    return adminPostJson<ConfigDocument>('/api/users/config/get');
}

/** POST /api/users/config/save —— 安全闸/YAML 错误以 ConfigSaveError 抛出。 */
export async function saveServerConfig(content: string): Promise<ConfigSaveResult> {
    const res = await apiFetch('/api/users/config/save', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content }),
    });
    if (!res.ok) {
        const { message, codes } = await readServerError(res);
        if (res.status === 403) throw new AdminForbiddenError(message);
        throw new ConfigSaveError(message, res.status, codes);
    }
    return (await res.json()) as ConfigSaveResult;
}

/** POST /api/users/settings/get */
export function getAdminSettings(): Promise<AdminSettings> {
    return adminPostJson<AdminSettings>('/api/users/settings/get');
}

/** POST /api/users/settings/save */
export function saveAdminSettings(settings: AdminSettings): Promise<AdminSettings> {
    return adminPostJson<AdminSettings>('/api/users/settings/save', settings);
}

/* ------------------------------------------------------------------ */
/* 实例共享 secrets(endpoints/shared-secrets.js,TASK-072 §2.3)          */
/* 六动词全 POST /api/users/shared-secrets/*;admin 面也只见掩码 ——       */
/* masked 由服务端无条件打码,不认 allowKeysExposure;没有任何明文读面。    */
/* ------------------------------------------------------------------ */

export type SharedSecretMode = 'all' | 'handles' | 'none';

/** admin list 单条:{id,label,active,masked,share} —— 无 value 字段。 */
export interface SharedSecretEntry {
    id: string;
    label: string;
    active: boolean;
    masked: string;
    share: { mode: SharedSecretMode; handles?: string[] };
}

export interface SharedSecretsListResponse {
    items: Record<string, SharedSecretEntry[] | null>;
}

/** POST /api/users/shared-secrets/list */
export function listSharedSecrets(): Promise<SharedSecretsListResponse> {
    return adminPostJson<SharedSecretsListResponse>('/api/users/shared-secrets/list');
}

/** POST /api/users/shared-secrets/write —— 应答 {id},不 echo 明文。 */
export function writeSharedSecret(input: {
    key: string;
    value: string;
    label?: string;
    mode?: SharedSecretMode;
    handles?: string[];
}): Promise<{ id: string }> {
    return adminPostJson<{ id: string }>('/api/users/shared-secrets/write', input);
}

/** POST /api/users/shared-secrets/delete → 204 */
export function deleteSharedSecret(key: string, id: string): Promise<void> {
    return adminPostVoid('/api/users/shared-secrets/delete', { key, id });
}

/** POST /api/users/shared-secrets/rotate → 204(切 active)。 */
export function rotateSharedSecret(key: string, id: string): Promise<void> {
    return adminPostVoid('/api/users/shared-secrets/rotate', { key, id });
}

/** POST /api/users/shared-secrets/visibility → 204(mode 必填;handles 模式必须给名单)。 */
export function setSharedSecretVisibility(
    key: string,
    id: string,
    mode: SharedSecretMode,
    handles?: string[],
): Promise<void> {
    return adminPostVoid('/api/users/shared-secrets/visibility', { key, id, mode, ...(handles ? { handles } : {}) });
}

/** POST /api/users/shared-secrets/promote —— 本人档 → 共享档复制,回新 {id}。 */
export function promoteSharedSecret(
    key: string,
    id: string,
    opts?: { label?: string; mode?: SharedSecretMode; handles?: string[] },
): Promise<{ id: string }> {
    return adminPostJson<{ id: string }>('/api/users/shared-secrets/promote', { key, id, ...opts });
}
