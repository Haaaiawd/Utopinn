// Card runtime 读面 —— GET /api/card-runtime/cards/:charId/manifest
// (dry-run 校验,不 mint mount;server mounts.js cardRuntimeApiRouter)。
// 用于「卡绑面板」列表:当前会话卡没声明 card_app → 不挂入口,
// 不拿别卡应用冒充。
import { apiGet } from './client';
import { cardData, getCharacter } from './characters';

export interface CardAppInfo {
    /** 卡声明了 card_app 且 manifest 通过服务端校验。 */
    has: boolean;
    /** manifest/卡声明里的面板名(name|title|label 宽松读);未声明 → undefined。 */
    name?: string;
}

/* charDir → Promise 会话级缓存:卡档运行期不变,重复进 launcher 不重打。 */
const cache = new Map<string, Promise<CardAppInfo>>();

const pickName = (o: Record<string, unknown> | null | undefined): string | undefined =>
    [o?.name, o?.title, o?.label]
        .find((v): v is string => typeof v === 'string' && !!v.trim())
        ?.trim();

/** manifest 端点 + 卡文档 raw card_app 双源:归一 manifest 不保留
 *  name/title 字段,要拿声明名得读卡原文(软失败 —— 名取不到不影响
 *  has 判定,只回落通用面板名)。 */
export function cardAppInfo(charDir: string): Promise<CardAppInfo> {
    const hit = cache.get(charDir);
    if (hit) return hit;
    const p = (async (): Promise<CardAppInfo> => {
        try {
            const r = await apiGet<{ ok?: boolean; manifest?: Record<string, unknown> | null }>(
                `/api/card-runtime/cards/${encodeURIComponent(charDir)}/manifest`);
            if (!r.ok) return { has: false };
            let name = pickName(r.manifest);
            if (!name) {
                try {
                    const doc = await getCharacter(charDir);
                    const ca = cardData(doc).extensions?.card_app;
                    name = pickName(ca && typeof ca === 'object' ? ca as Record<string, unknown> : undefined);
                } catch { /* 名取不到 → undefined */ }
            }
            return { has: true, name };
        } catch { return { has: false }; }
    })();
    cache.set(charDir, p);
    return p;
}
