// IzumiEdit 信息库面:/api/utopinn/izumi/*(服务端 plugins/utopinn-izumi.js)。
// 读面返回 entries/hiddenFloors/log + konata 注入文预览;写面 entries
// 局部改(开关/正文)+ hiddenFloors 整表换,服务端 RMW 后回同一视图。
import { apiPost } from './client';
import type {
    ChatStateTarget,
    IzumiPutRequest,
    IzumiResetResponse,
    IzumiStateView,
} from '@utopinn/protocol';

export type { IzumiEntry, IzumiHiddenRange, IzumiLogEntry, IzumiStateView } from '@utopinn/protocol';

const P = '/api/utopinn/izumi';

/** POST /izumi/state —— {ok,entries,hiddenFloors,log,worldSystemClosed,konata,catalog}。 */
export async function getIzumiState(target: ChatStateTarget): Promise<IzumiStateView> {
    return apiPost(`${P}/state`, target);
}

/** POST /izumi/put —— 局部写(entries 按操作名寻址;hiddenFloors 整表替换)。 */
export async function putIzumiState(target: ChatStateTarget, patch: IzumiPutRequest): Promise<IzumiStateView> {
    return apiPost(`${P}/put`, { ...target, patch });
}

/** POST /izumi/reset —— 清空信息库 ns。 */
export async function resetIzumiState(target: ChatStateTarget): Promise<IzumiResetResponse> {
    return apiPost(`${P}/reset`, target);
}
