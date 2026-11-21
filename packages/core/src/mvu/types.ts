/**
 * MVU (MagVarUpdate) 数据与命令类型 — 上游类型移植。
 * 语义基准:`ref/dsh-tavern/.../magvarupdate/upstream/src/variable_def.ts`。
 * 字段名与上游保持一致(stat_data / display_data / delta_data / schema /
 * initialized_lorebooks),保证 chat jsonl 与 TH-MVU 生态双向可读。
 */

/** 模板类型定义。对应 upstream `TemplateType`。 */
export type MvuTemplate = MvuStatData | MvuStatData[] | unknown[];

/** StatData 元数据(对象节点 $meta 承载)。 */
export interface MvuStatDataMeta {
    extensible?: boolean;
    recursiveExtensible?: boolean;
    required?: string[];
    template?: MvuTemplate;
    strictTemplate?: boolean;
    concatTemplateArray?: boolean;
    strictSet?: boolean;
    [key: string]: unknown;
}

export type MvuJsonPrimitive = string | number | boolean | null;

/** upstream `StatData`:嵌套对象/数组,可挂 `$meta`/`$arrayMeta`。 */
export interface MvuStatData {
    [key: string]: MvuStatData | MvuJsonPrimitive | (MvuStatData | MvuJsonPrimitive)[] | MvuStatDataMeta | boolean | undefined;
    $meta?: MvuStatDataMeta;
    $arrayMeta?: boolean;
}

export type MvuSchemaNode = MvuObjectSchema | MvuArraySchema | MvuPrimitiveSchema;

export interface MvuObjectSchema {
    type: 'object';
    properties: { [key: string]: MvuSchemaNode & { required?: boolean } };
    extensible?: boolean;
    template?: MvuTemplate;
    recursiveExtensible?: boolean;
}

export interface MvuArraySchema {
    type: 'array';
    elementType: MvuSchemaNode;
    extensible?: boolean;
    template?: MvuTemplate;
    recursiveExtensible?: boolean;
}

export interface MvuPrimitiveSchema {
    type: 'string' | 'number' | 'boolean' | 'any';
}

/** upstream `ValueWithDescription<T>`:stat_data 中 `[值, "说明"]` 二元组。 */
export type MvuValueWithDescription = [unknown, string];

export function isValueWithDescription(value: unknown): value is MvuValueWithDescription {
    return Array.isArray(value) && value.length === 2 && typeof value[1] === 'string';
}

export function isArraySchema(value: MvuSchemaNode | null | undefined): value is MvuArraySchema {
    return value?.type === 'array';
}

export function isObjectSchema(value: MvuSchemaNode | null | undefined): value is MvuObjectSchema {
    return value?.type === 'object';
}

export interface MvuRootAdditionalProps {
    strictTemplate?: boolean;
    concatTemplateArray?: boolean;
    strictSet?: boolean;
}

/**
 * upstream `MvuData` — 单个楼层 swipe 槽位里的完整变量快照。
 * settle = 以前置楼层快照为基底 fold 本层 UpdateVariable 命令(C1 投影)。
 */
export interface MvuData {
    /** 已初始化的 lorebook → 附加标记数组(beta 对象格式)。 */
    initialized_lorebooks: Record<string, unknown[]>;
    /** 实际变量树。更新期间临时挂 `$internal`(display/delta 引用),结算后摘除。 */
    stat_data: MvuStatData & { $internal?: { display_data: unknown; delta_data: unknown } };
    /** 数据结构模式(校验 extensible/required/template/strict*)。 */
    schema?: MvuObjectSchema & Partial<MvuRootAdditionalProps>;
    /** @deprecated 兼容字段:变更展示数据("old->new (reason)")。仍按上游语义维护。 */
    display_data?: Record<string, unknown>;
    /** @deprecated 兼容字段:本层 delta("old->new (reason)")。 */
    delta_data?: Record<string, unknown>;
    [key: string]: unknown;
}

/** upstream `isMvuData`:`stat_data` 与 `schema` 同时在场才算合法快照。 */
export function isMvuData(variables: unknown): variables is MvuData {
    if (variables === null || typeof variables !== 'object' || Array.isArray(variables)) {
        return false;
    }
    const v = variables as Record<string, unknown>;
    return v.stat_data !== undefined && v.schema !== undefined;
}

/** 命令名集合(upstream `CommandNames`)。`move` 仅由 json_patch 产生且上游不执行。 */
export type MvuCommandType = 'set' | 'insert' | 'assign' | 'remove' | 'unset' | 'delete' | 'add' | 'move';

/** upstream `Command` — 提取出的单条变量更新命令。 */
export interface MvuCommand {
    type: MvuCommandType;
    /** 原始匹配文本(`_.set(...)` 全串或 JSON.stringify(op))。 */
    full_match: string;
    /** 未解析的参数字面量数组。 */
    args: string[];
    /** `//` 尾注释或来源标记(json_patch)。 */
    reason: string;
}

/** 结算回执(C4):每条命令一行 op 日志。 */
export interface MvuSettleOp {
    /** 按文本出现顺序的序号。 */
    index: number;
    /** 别名归一后的生效类型(remove/unset→delete,assign→insert)。 */
    type: MvuCommandType;
    command: string;
    path: string;
    reason: string;
    status: 'applied' | 'skipped' | 'error' | 'unsupported';
    /** 展示串,同 upstream display_str("old->new (reason)" / 操作描述)。 */
    display?: string;
    oldValue?: unknown;
    newValue?: unknown;
    error?: string;
}

export interface MvuSettleError {
    command: string;
    content: string;
}

export interface MvuSettleReceipt {
    version: 1;
    /** stat_data 是否发生了实质变化(upstream `is_modified`)。 */
    modified: boolean;
    ops: MvuSettleOp[];
    /** 全部错误(上游只保留首个 toast;回执保留全量)。 */
    errors: MvuSettleError[];
    /**
     * 非致命告警(GH#14):正文含 _.cmd( 语法但零指令生效等「看起来像
     * 命令、却一条没落」的情形 —— 不当 error 拦截 settle,但要让
     * 调用方/诊断面看得见,不能静默吞。
     */
    warnings?: string[];
}

/** 楼层消息的最小读取面(ST jsonl 消息 + TH `variables` 槽位)。 */
export interface MvuFloorMessage {
    /** ST jsonl 字段。 */
    mes?: string;
    /** TH `getChatMessages` 字段;`mes` 优先。 */
    message?: string;
    role?: 'user' | 'assistant' | 'system' | string;
    is_user?: boolean;
    is_system?: boolean;
    swipe_id?: number;
    /** TH/MVU 约定:按 swipe 槽位存 MvuData 快照。 */
    variables?: Record<string | number, unknown> | MvuData[];
    [key: string]: unknown;
}

export type MvuSubstituteFn = (content: string) => string;

export interface MvuSettleOptions {
    /** `substitudeMacros` 注入点(命令文本中的 {{getvar}}/{{user}} 等)。默认原样返回。 */
    substitute?: MvuSubstituteFn;
}
