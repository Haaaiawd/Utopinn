/**
 * 其余 /api/utopinn 域 —— mvu / plugins / data(import·backup·lan) /
 * script / th / diag(kernel)。动词形与 CLI 对齐:
 *   mvu state|settle|resettle|panel-render   plugins list|enable|disable|reload
 *   import scan-st|preview|commit           backup(zip 二进制)
 *   lan offer|import                        script run   th call   kernel
 */

import type {
    BackupRequest,
    ChatStateTarget,
    ImportCommitResponse,
    ImportPayloadRequest,
    ImportPreviewResponse,
    ImportScanRequest,
    ImportScanResponse,
    KernelInfo,
    LanImportRequest,
    LanImportResponse,
    LanOfferRequest,
    LanOfferResponse,
    MvuPanelRenderRequest,
    MvuPanelRenderResponse,
    MvuResettleRequest,
    MvuResettleResponse,
    MvuSettleRequest,
    MvuSettleResponse,
    MvuStateResponse,
    MvuTarget,
    PluginListResponse,
    PluginOpResponse,
    ScriptRunRequest,
    ScriptRunResponse,
    ThCallRequest,
    ThCallResponse,
} from '@utopinn/protocol';
import { toBase64Payload } from './base64.js';
import type { UtopinnClient } from './index.js';

const P = '/api/utopinn';
const enc = encodeURIComponent;

// ─── mvu(变量/MVU 兼容面)────────────────────────────────────────────────

export class MvuApi {
    constructor(private readonly client: UtopinnClient) {}

    /** GET /mvu/state?target(单卡 {avatar_url,file_name}|群 {is_group,id})。 */
    state(target: MvuTarget): Promise<MvuStateResponse> {
        const query: Record<string, string> = {};
        if ('is_group' in target && target.is_group) {
            query.is_group = 'true';
            query.id = target.id;
        } else {
            const t = target as { avatar_url: string; file_name: string };
            query.avatar_url = t.avatar_url;
            query.file_name = t.file_name;
        }
        return this.client.request(`${P}/mvu/state`, { query });
    }

    /** POST /mvu/settle —— 手动重结算目标楼层。 */
    settle(target: MvuTarget, opts: Pick<MvuSettleRequest, 'message_index' | 'update_chat_variables'> = {}): Promise<MvuSettleResponse> {
        return this.client.request(`${P}/mvu/settle`, { method: 'POST', body: { ...target, ...opts } });
    }

    /** POST /mvu/resettle —— 重结算 + 回写 chat 变量。 */
    resettle(target: MvuTarget, opts: Pick<MvuResettleRequest, 'update_chat_variables'> = {}): Promise<MvuResettleResponse> {
        return this.client.request(`${P}/mvu/resettle`, { method: 'POST', body: { ...target, ...opts } });
    }

    /** POST /mvu/panel/render —— 模板×变量 → 面板 HTML。 */
    panelRender(req: MvuPanelRenderRequest): Promise<MvuPanelRenderResponse> {
        return this.client.request(`${P}/mvu/panel/render`, { method: 'POST', body: req });
    }
}

// ─── plugins ────────────────────────────────────────────────────────────

export class PluginsApi {
    constructor(private readonly client: UtopinnClient) {}

    list(): Promise<PluginListResponse> {
        return this.client.request(`${P}/plugins`);
    }
    /** POST /plugins/:id/enable —— pm result 原样({ok:true}|{error})。 */
    enable(id: string): Promise<PluginOpResponse> {
        return this.client.request(`${P}/plugins/${enc(id)}/enable`, { method: 'POST' });
    }
    disable(id: string): Promise<PluginOpResponse> {
        return this.client.request(`${P}/plugins/${enc(id)}/disable`, { method: 'POST' });
    }
    reload(id: string): Promise<PluginOpResponse> {
        return this.client.request(`${P}/plugins/${enc(id)}/reload`, { method: 'POST' });
    }
}

// ─── data:import / backup / lan ─────────────────────────────────────────

/** preview/commit 的入参:wire 形 | 便捷字节形(自动 base64)。 */
export type ImportInput =
    | ImportPayloadRequest
    | ({ name: string; data: Uint8Array | ArrayBuffer | Blob } & Omit<ImportPayloadRequest, 'name' | 'dataBase64'>);

async function importBody(input: ImportInput): Promise<ImportPayloadRequest> {
    if ('dataBase64' in input && typeof input.dataBase64 === 'string') return input;
    const { name, data, ...rest } = input as { name: string; data: Uint8Array | ArrayBuffer | Blob } & Omit<ImportPayloadRequest, 'name' | 'dataBase64'>;
    return { ...(await toBase64Payload(name, data)), ...rest };
}

export interface BackupResult {
    /** zip 附件字节(RN/Node 写文件、浏览器 new Blob([data]))。 */
    data: ArrayBuffer;
    /** content-disposition 里的服务端文件名,取不到则本地合成。 */
    fileName: string;
    bytes: number;
}

export class DataApi {
    constructor(private readonly client: UtopinnClient) {}

    /** POST /import/scan-st(admin;dir 是服务端路径)。 */
    importScanSt(dir: string): Promise<ImportScanResponse> {
        const body: ImportScanRequest = { dir };
        return this.client.request(`${P}/import/scan-st`, { method: 'POST', body });
    }

    /** POST /import/preview —— base64 JSON 体;multipart 暂不进本包。 */
    async importPreview(input: ImportInput): Promise<ImportPreviewResponse> {
        return this.client.request(`${P}/import/preview`, { method: 'POST', body: await importBody(input) });
    }

    /** POST /import/commit —— 落库;conflict:'rename'(默认)|'overwrite'|'skip'。 */
    async importCommit(input: ImportInput): Promise<ImportCommitResponse> {
        return this.client.request(`${P}/import/commit`, { method: 'POST', body: await importBody(input) });
    }

    /**
     * POST /backup —— 响应是 zip 附件(application/zip + Content-Disposition),
     * 不是 JSON。CLI `backup` 落 utopinn-backup-<iso>.zip;这里回字节+文件名,
     * 落盘方式各端自选。
     */
    async backup(selection?: Record<string, boolean>): Promise<BackupResult> {
        const body: BackupRequest = selection ? { selection } : {};
        const r = await this.client.requestBinary(`${P}/backup`, { method: 'POST', body });
        const cd = r.headers.get('content-disposition') ?? '';
        const m = /filename\*?=(?:UTF-8''|")?([^";]+)/i.exec(cd);
        const fileName = m?.[1]
            ? decodeURIComponent(m[1].replace(/"$/, ''))
            : `utopinn-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.zip`;
        return { data: r.data, fileName, bytes: r.data.byteLength };
    }

    /** POST /lan/offer —— 一次性 offer URL(~10min);handle 跨用户需 admin。 */
    lanOffer(opts: LanOfferRequest = {}): Promise<LanOfferResponse> {
        return this.client.request(`${P}/lan/offer`, { method: 'POST', body: opts });
    }

    /** POST /lan/import —— legacy 面薄代理;上游应答原样透传。 */
    lanImport(req: LanImportRequest): Promise<LanImportResponse> {
        return this.client.request(`${P}/lan/import`, { method: 'POST', body: req });
    }
}

// ─── script / th / diag ─────────────────────────────────────────────────

export class ScriptApi {
    constructor(private readonly client: UtopinnClient) {}

    /** POST /script/run —— 服务端 STscript runner;{script,charDir?,chatName?}。 */
    run(req: ScriptRunRequest): Promise<ScriptRunResponse> {
        return this.client.request(`${P}/script/run`, { method: 'POST', body: req });
    }
}

export class ThApi {
    constructor(private readonly client: UtopinnClient) {}

    /**
     * POST /th/call —— TavernHelper 兼容调用。
     * {ok:true,result} | {ok:false,unsupported:true} | {ok:false,error}
     * 业务错也走 200 —— 看 body.ok,别只看 HTTP。
     */
    call(method: string, opts: { target?: ThCallRequest['target']; args?: Record<string, unknown> } = {}): Promise<ThCallResponse> {
        const body: ThCallRequest = { method, ...opts };
        return this.client.request(`${P}/th/call`, { method: 'POST', body });
    }
}

export class DiagApi {
    constructor(private readonly client: UtopinnClient) {}

    /** GET /api/utopinn/_kernel —— 内核路由/服务清单(diag 面)。 */
    kernel(): Promise<KernelInfo> {
        return this.client.request(`${P}/_kernel`);
    }
}

// re-export 目标别名,消费侧不用单独引 protocol
export type { ChatStateTarget, MvuTarget };
