// 服务端贡献清单水合 —— GET /api/utopinn/ui/contrib(§C-12 manifest 面,
//  api/contrib.ts)→ 本地 panel.type 注册表对账。cordis「贡献即注册」:
//  不建第二真值通道(override store 之类),直接在注册的持有方作用域里
//  dispose + 重注册 —— 注册表本身就是对账后的唯一事实源。也因此本层只给
//  持柄方调:跨作用域拆别人的贡献不归这里,panelsFeature 把自己的
//  disposer 句柄传进来,水合在它的 fiber 里生效、随它卸载。
//
//  对账规则(目前只收编 panel.type 槽;其余槽的贡献要真组件,线形 JSON
//  声明给不了 Body —— 远端声明面落到那些槽时再来扩):
//    · 服务端 live 声明带 wired:true 而本地 wired:false → 原位纠正为 true:
//      整段 dispose 后按原序重注册,保 launcher 网格序;
//    · desc/badge/category/title 只补本地缺省,不覆写 —— 本地文案词是
//      前端资产,服务端给的是归属映射不是第二套词;
//    · 服务端声明了、本地完全没注册的类型 → 注册占位条目:wired:false +
//      category:'hidden'(没有本地 Body 的类型点不出真面,不进可点网格/
//      cmdk;代码 openPanel 可达时 Body 给「未提供」空态 —— 功能缺席只有
//      真实现与明说空态两形,不渲示例数据);icon/desc/title 吃服务端值,
//      icon 不在本地词表兜 'puzzle';
//    · 服务端没声明的本地类型 → 原样保留(BUILTIN_CONTRIB 合并在服务端做,
//      前端不二次发明);
//    · disabled:true 的声明不参与 wired 升级(插件已停,后端面没活着),
//      但仍算「声明过」:本地没有的类型照样给占位。本地已 wired 的类型
//      其提供方被停用,本层不做降级对账 —— 启停是运行时事件,归插件管理
//      面/诊断面呈现,面板自身的错误/空态兜底。
//
//  失败降级:fetch 失败/超时/非 2xx → null 返回,静态旗标原样生效
//  (它们本来就是离线真值);console.warn 一次,不重试不刷屏。
import type { ComponentType } from 'react';
import type { FeatureCtx } from '../kernel/kernel';
import type { Disposer } from '../kernel/registry';
import type { PanelTypeContribution } from '../kernel/contributions';
import { ICON_NAMES, type IconName } from '../components/Icon';
import { PanelEmpty } from '../components/panels/panelShared';
import { useI18n } from '../i18n';
import { listUiContrib, type UiContribReply } from '../api/contrib';

/** 注册方交来的持柄条目:贡献对象 + 它在本作用域里的 disposer。 */
export interface RegisteredPanel {
    contrib: PanelTypeContribution;
    dispose: Disposer;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/* Server-declared categories fill locally-unspecified ones only; 'pinned'
 * is included so a server mirror can mark a not-yet-categorized local
 * panel, while 'hidden' stays excluded on purpose (remote decls must not
 * be able to pull a local panel out of the launcher). */
const asCategory = (v: unknown): PanelTypeContribution['category'] | undefined =>
    v === 'system' || v === 'cardapp' || v === 'pinned' || v === 'suggested' ? v : undefined;

/** 服务端 icon 是任意串 —— 不在本地词表兜 'puzzle'(未知名会让 <Icon> 崩)。 */
const asIcon = (v: unknown, fallback: IconName): IconName =>
    typeof v === 'string' && ICON_NAMES.has(v) ? (v as IconName) : fallback;

/** 服务端声明、本地无体的占位板块:类型名 + 「未提供」明说空态,不装假。 */
function makeStubBody(type: string, icon: IconName): ComponentType {
    return function ContribStubBody() {
        const { t } = useI18n();
        return <PanelEmpty icon={icon} desc={t('panel.feature.unavailableDesc')}>{t(`panel.type.${type}`)}</PanelEmpty>;
    };
}

/** 本地贡献 × 服务端 live 声明 → 合并后贡献;无改动原样返回(保身份)。 */
function mergeDecl(local: PanelTypeContribution, live: Record<string, unknown>[]): PanelTypeContribution {
    const srv = live.find((c) => c.wired === true) ?? live[0]!;
    let { wired, badge, desc, category, title } = local;
    let changed = false;
    if (!wired && srv.wired === true) {
        wired = true;
        changed = true;
    }
    if (badge === undefined && str(srv.badge)) { badge = str(srv.badge); changed = true; }
    if (desc === undefined && str(srv.desc)) { desc = str(srv.desc); changed = true; }
    if (category === undefined && asCategory(srv.category)) { category = asCategory(srv.category); changed = true; }
    if (title === undefined && str(srv.title)) { title = str(srv.title); changed = true; }
    return changed ? { ...local, wired, badge, desc, category, title } : local;
}

/** 服务端声明了、本地没有的类型 → 占位条目(Body 线形给不了,永远占位壳)。
 *  category 恒 'hidden':本地没有 Body 的类型在可点网格里点不出真面,
 *  不拿服务端给的归属桶进 launcher/cmdk;服务端分类只留作元数据参考。 */
function placeholder(type: string, meta: Record<string, unknown>): PanelTypeContribution {
    const icon = asIcon(meta.icon, 'puzzle');
    return {
        type,
        icon,
        wired: false,
        Body: makeStubBody(type, icon),
        category: 'hidden',
        ...(str(meta.desc) !== undefined ? { desc: str(meta.desc) } : {}),
        ...(str(meta.title) !== undefined ? { title: str(meta.title) } : {}),
    };
}

interface Decl {
    /** 非 disabled 声明 —— 后端面活着,wired:true 作数。 */
    live: Record<string, unknown>[];
    /** 全部声明(含 disabled)—— 只证明「类型被声明过」。 */
    any: Record<string, unknown>[];
}

function reconcile(ctx: FeatureCtx, local: RegisteredPanel[], reply: UiContribReply): void {
    const decls = new Map<string, Decl>();
    for (const it of reply.items) {
        if (it.slot !== 'panel.type') continue;
        const c = it.contribution;
        if (!c || typeof c !== 'object') continue;
        const type = c.type;
        if (typeof type !== 'string' || !type) continue;
        const d = decls.get(type) ?? { live: [], any: [] };
        d.any.push(c);
        if (!it.disabled) d.live.push(c);
        decls.set(type, d);
    }

    /* 1) 本地已注册类型对账:有变化的整段 dispose + 原序重注册(保网格序)。
     *    新贡献经 ctx.add 收进同一作用域 —— feature 卸载时新旧 disposer
     *    一起走,不泄。 */
    const next = local.map((h) => h.contrib);
    let dirty = false;
    for (let i = 0; i < next.length; i++) {
        const c = next[i]!;
        const d = decls.get(c.type);
        if (!d || d.live.length === 0) continue;
        const merged = mergeDecl(c, d.live);
        if (merged !== c) {
            next[i] = merged;
            dirty = true;
        }
    }
    if (dirty) {
        for (const h of local) h.dispose();
        for (const c of next) ctx.add('panel.type', c);
    }

    /* 2) 服务端声明了、本地没有的类型 → 占位条目追加在后(新类型自然沉底)。 */
    const known = new Set(next.map((c) => c.type));
    for (const [type, d] of decls) {
        if (known.has(type)) continue;
        ctx.add('panel.type', placeholder(type, d.live[0] ?? d.any[0]!));
    }
}

/** 一次性拉取;任何失败 → null(调用方静默,静态旗标已是离线真值)。 */
async function fetchUiContrib(): Promise<UiContribReply | null> {
    try {
        return await listUiContrib();
    } catch (e) {
        console.warn('[contrib] /api/utopinn/ui/contrib unavailable; keeping local declarations.', e);
        return null;
    }
}

/**
 * panel.type 水合入口 —— 由注册方(panelsFeature)在 apply 尾部调用:
 * 挂进本作用域 effect,拉到清单后对账;作用域拆除则在途结果作废。
 */
export function hydratePanelTypes(ctx: FeatureCtx, local: RegisteredPanel[]): void {
    ctx.effect(() => {
        let alive = true;
        void fetchUiContrib().then((reply) => {
            /* items 非数组 = 响应形状漂移 —— 同失败处理:静默,静态旗标顶上。 */
            if (alive && reply && Array.isArray(reply.items)) reconcile(ctx, local, reply);
        });
        return () => { alive = false; };
    });
}
