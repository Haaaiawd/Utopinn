/**
 * MVU schema 与模板机制 — 结构校验 + 新元素模板填充。
 * 语义基准:
 * - `function/schema.ts` 全文件(generateSchema / getSchemaForPath /
 *   reconcileAndApplySchema / cleanUpMetadata / EXTENSIBLE_MARKER)
 * - `update_variables.ts` L38-83 (applyTemplate)
 */
import {
    concat,
    deepClone,
    has,
    isObject,
    isPlainObject,
    merge,
    toPath,
} from './lodash.js';
import {
    isArraySchema,
    isObjectSchema,
    isValueWithDescription,
    type MvuArraySchema,
    type MvuData,
    type MvuObjectSchema,
    type MvuRootAdditionalProps,
    type MvuSchemaNode,
    type MvuStatData,
    type MvuTemplate,
} from './types.js';

/** upstream `EXTENSIBLE_MARKER` (schema.ts L15)。 */
export const EXTENSIBLE_MARKER = '$__META_EXTENSIBLE__$';

/**
 * upstream `generateSchema` (schema.ts L25-200):
 * 递归生成 schema;就地消费 $meta/$arrayMeta/EXTENSIBLE_MARKER(注意:
 * 会直接改动传入的 data —— 调用方必须先 deepClone)。
 */
export function generateSchema(
    data: unknown,
    oldSchemaNode?: MvuSchemaNode,
    parentRecursiveExtensible: boolean = false,
): MvuSchemaNode {
    // @ts-expect-error upstream hack for mvu zod — 保留行为
    if (oldSchemaNode === '没有用别管这个') {
        return { type: 'any' };
    }

    if (Array.isArray(data)) {
        let isExtensible = false;
        let isRecursiveExtensible = parentRecursiveExtensible;
        let oldElementType: MvuSchemaNode | undefined;
        let template: MvuTemplate | undefined;

        if (oldSchemaNode) {
            if (isArraySchema(oldSchemaNode)) {
                isExtensible = oldSchemaNode.extensible === true;
                isRecursiveExtensible =
                    oldSchemaNode.recursiveExtensible === true || parentRecursiveExtensible;
                oldElementType = oldSchemaNode.elementType;
                template = oldSchemaNode.template;
            }
        }

        const metaElementIndex = data.findIndex(
            item =>
                isObject(item) &&
                !(item instanceof Date) &&
                '$arrayMeta' in item &&
                '$meta' in item &&
                (item as Record<string, unknown>)['$arrayMeta'] === true,
        );

        if (metaElementIndex !== -1) {
            const metaElement = data[metaElementIndex] as { $meta: Record<string, unknown> };
            if (metaElement.$meta.extensible !== undefined) {
                isExtensible = metaElement.$meta.extensible === true;
            }
            if (metaElement.$meta.template !== undefined) {
                template = metaElement.$meta.template as MvuTemplate;
            }
            data.splice(metaElementIndex, 1);
        }

        const markerIndex = data.indexOf(EXTENSIBLE_MARKER);
        if (markerIndex > -1) {
            isExtensible = true;
            data.splice(markerIndex, 1);
        }

        const schemaNode: MvuArraySchema = {
            type: 'array',
            extensible: isExtensible || parentRecursiveExtensible,
            recursiveExtensible: isRecursiveExtensible,
            elementType:
                data.length > 0
                    ? generateSchema(data[0], oldElementType, isRecursiveExtensible)
                    : { type: 'any' },
        };
        if (template !== undefined) {
            schemaNode.template = template;
        }
        return schemaNode;
    }

    if (isObject(data) && !(data instanceof Date)) {
        const typedData = data as MvuStatData;

        let oldExtensible = false;
        let oldRecursiveExtensible = parentRecursiveExtensible;
        let oldProperties: MvuObjectSchema['properties'] | undefined;

        if (oldSchemaNode) {
            if (isObjectSchema(oldSchemaNode)) {
                oldExtensible = oldSchemaNode.extensible === true;
                oldRecursiveExtensible =
                    oldSchemaNode.recursiveExtensible === true || parentRecursiveExtensible;
                oldProperties = oldSchemaNode.properties;
            }
        }

        const schemaNode: MvuObjectSchema = {
            type: 'object',
            properties: {},
            extensible:
                oldExtensible ||
                typedData.$meta?.extensible === true ||
                typedData.$meta?.recursiveExtensible === true ||
                parentRecursiveExtensible,
            recursiveExtensible:
                oldRecursiveExtensible || typedData.$meta?.recursiveExtensible === true,
        };

        if (typedData.$meta?.template !== undefined) {
            schemaNode.template = typedData.$meta.template;
        } else if (oldSchemaNode && isObjectSchema(oldSchemaNode) && oldSchemaNode.template) {
            schemaNode.template = oldSchemaNode.template;
        }

        const parentMeta = typedData.$meta;
        if (typedData.$meta) {
            delete typedData.$meta;
        }

        for (const key of Object.keys(data)) {
            const oldChildNode = oldProperties?.[key];
            const childRecursiveExtensible =
                schemaNode.extensible !== false && schemaNode.recursiveExtensible === true;
            const childSchema = generateSchema(
                typedData[key],
                oldChildNode,
                childRecursiveExtensible,
            );

            let isRequired = !schemaNode.extensible;
            if (Array.isArray(parentMeta?.required) && parentMeta.required.includes(key)) {
                isRequired = true;
            }
            if (oldChildNode?.required === false) {
                isRequired = false;
            } else if (oldChildNode?.required === true) {
                isRequired = true;
            }

            schemaNode.properties[key] = {
                ...childSchema,
                required: isRequired,
            };
        }
        return schemaNode;
    }

    const dataType = typeof data;
    if (dataType === 'string' || dataType === 'number' || dataType === 'boolean') {
        return { type: dataType };
    }
    return { type: 'any' };
}

/**
 * upstream `getSchemaForPath` (schema.ts L209-239):
 * 数字段→elementType,非数字段→properties[seg],失配返回 null。
 */
export function getSchemaForPath(
    schema: MvuSchemaNode | null | undefined,
    path: string,
): MvuSchemaNode | null {
    if (!path || !schema) {
        return schema || null;
    }
    const pathSegments = toPath(path);
    let currentSchema: MvuSchemaNode | null = schema;
    for (const segment of pathSegments) {
        if (!currentSchema) return null;
        if (/^\d+$/.test(segment)) {
            if (isArraySchema(currentSchema)) {
                currentSchema = currentSchema.elementType;
            } else {
                return null;
            }
        } else if (isObjectSchema(currentSchema) && currentSchema.properties[segment]) {
            currentSchema = currentSchema.properties[segment] as MvuSchemaNode;
        } else {
            return null;
        }
    }
    return currentSchema;
}

/**
 * upstream `reconcileAndApplySchema` (schema.ts L245-283):
 * 用当前数据重生成 schema 并回写(保留 RootAdditionalProps)。
 */
export function reconcileAndApplySchema(variables: MvuData): void {
    const currentDataClone = deepClone(variables.stat_data);
    const newSchema = generateSchema(currentDataClone, variables.schema);
    if (!isObjectSchema(newSchema)) {
        return;
    }
    const newSchemaWithProps = newSchema as MvuObjectSchema & MvuRootAdditionalProps;
    if (variables.schema?.strictTemplate !== undefined) {
        newSchemaWithProps.strictTemplate = variables.schema.strictTemplate;
    }
    if (variables.schema?.strictSet !== undefined) {
        newSchemaWithProps.strictSet = variables.schema.strictSet;
    }
    if (variables.schema?.concatTemplateArray !== undefined) {
        newSchemaWithProps.concatTemplateArray = variables.schema.concatTemplateArray;
    }
    const meta = variables.stat_data['$meta'] as Record<string, unknown> | undefined;
    if (has(variables.stat_data, '$meta.strictTemplate')) {
        newSchemaWithProps.strictTemplate = meta?.strictTemplate as boolean;
    }
    if (has(variables.stat_data, '$meta.strictSet')) {
        newSchemaWithProps.strictSet = meta?.strictSet as boolean;
    }
    if (has(variables.stat_data, '$meta.concatTemplateArray')) {
        newSchemaWithProps.concatTemplateArray = meta?.concatTemplateArray as boolean;
    }
    variables.schema = newSchemaWithProps;
}

function isMetaCarrier(value: unknown): value is Record<string, unknown> & { $meta?: unknown } {
    return isObject(value) && !(value instanceof Date);
}

/** upstream `cleanUpMetadata` (schema.ts L295-327):移除 $meta / 标记元素。 */
export function cleanUpMetadata(data: unknown): void {
    if (Array.isArray(data)) {
        let i = data.length;
        while (i--) {
            if (data[i] === EXTENSIBLE_MARKER) {
                data.splice(i, 1);
            } else if (
                isObject(data[i]) &&
                !(data[i] instanceof Date) &&
                '$arrayMeta' in (data[i] as object) &&
                '$meta' in (data[i] as object) &&
                (data[i] as Record<string, unknown>)['$arrayMeta'] === true
            ) {
                data.splice(i, 1);
            } else {
                cleanUpMetadata(data[i]);
            }
        }
    } else if (isMetaCarrier(data)) {
        delete data.$meta;
        for (const key of Object.keys(data)) {
            cleanUpMetadata(data[key]);
        }
    }
}

// ─── GH#4:非变异结构校验(th.replaceVariables/replaceMvuData 写前守卫)─────

/** 单条结构校验错误:path 为 a.b[0].c 形(数组段方括号),根 stat_data 记 ''。 */
export interface MvuSchemaError {
    path: string;
    code: 'missing_required' | 'unexpected_key' | 'type_mismatch' | 'invalid_stat_data';
    message: string;
    expected?: string;
    actual?: string;
}

const schemaValueType = (v: unknown): string =>
    v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;

const joinSchemaPath = (base: string, key: string | number): string =>
    typeof key === 'number' ? `${base}[${key}]` : base ? `${base}.${key}` : String(key);

/** 数组元素元数据位:EXTENSIBLE_MARKER / {$arrayMeta:true,$meta:{…}} 不进校验。 */
const isArrayMetaItem = (item: unknown): boolean =>
    item === EXTENSIBLE_MARKER
    || (isPlainObject(item) && (item as Record<string, unknown>)['$arrayMeta'] === true && '$meta' in (item as object));

/**
 * GH#4:stat_data 对 schema 递归走查,逐路径报错;只读不写
 * (generateSchema 会就地消费 $meta/EXTENSIBLE_MARKER —— 校验面不能复用它,
 * 否则「校验」本身就毁了被校验对象)。
 *
 * 语义与 schema 约束面同口径:
 * - 非 extensible 对象:data 出现 properties 外键 → unexpected_key;
 *   recursiveExtensible 沿父链下传(存储 schema 已逐节点烘焙
 *   extensible,手写 partial schema 靠继承兜住)。
 * - properties[k].required===true 而 data 缺 k → missing_required。
 * - 叶类型不符 → type_mismatch;'any' 通配,null 宽容
 *   (generateSchema 把 null 归 'any',生态快照里 null 常态)。
 * - [值, "描述"] VWD 二元组按上游语义只校验值位,描述串不进 schema。
 * - 对象 $meta 键、数组元数据元素跳过(它们是 schema 载体不是数据)。
 * - data 缺失(undefined)由父层 required 检查裁决,自身不递归。
 */
export function validateStatDataAgainstSchema(
    data: unknown,
    schema: MvuSchemaNode | null | undefined,
    options: { maxErrors?: number } = {},
): MvuSchemaError[] {
    const errors: MvuSchemaError[] = [];
    const max = Math.max(1, options.maxErrors ?? 50);
    if (!schema) return errors;

    const push = (e: MvuSchemaError) => {
        if (errors.length < max) errors.push(e);
    };

    const walk = (
        value: unknown,
        node: MvuSchemaNode | undefined,
        path: string,
        inheritedRecursiveExtensible: boolean,
    ): void => {
        if (!node || errors.length >= max) return;
        if (value === undefined) return;   // 缺位由父层 required 判
        if (node.type === 'any') return;

        if (isObjectSchema(node)) {
            if (!isPlainObject(value)) {
                push({
                    path, code: 'type_mismatch', expected: 'object', actual: schemaValueType(value),
                    message: `${path || 'stat_data'}: expected object, got ${schemaValueType(value)}`,
                });
                return;
            }
            const obj = value as Record<string, unknown>;
            const props = node.properties ?? {};
            const extensible = node.extensible === true || inheritedRecursiveExtensible;
            const childRecursive = inheritedRecursiveExtensible || node.recursiveExtensible === true;
            for (const key of Object.keys(obj)) {
                if (key === '$meta') continue;
                const child = props[key] as MvuSchemaNode | undefined;
                if (!child) {
                    if (!extensible) {
                        push({
                            path: joinSchemaPath(path, key), code: 'unexpected_key',
                            actual: schemaValueType(obj[key]),
                            message: `${joinSchemaPath(path, key)}: key not declared in schema (object not extensible)`,
                        });
                    }
                    continue;
                }
                walk(obj[key], child, joinSchemaPath(path, key), childRecursive);
            }
            for (const [key, child] of Object.entries(props)) {
                if ((child as MvuSchemaNode & { required?: boolean }).required === true && !(key in obj)) {
                    push({
                        path: joinSchemaPath(path, key), code: 'missing_required',
                        message: `${joinSchemaPath(path, key)}: declared required by schema but absent`,
                    });
                }
            }
            return;
        }

        if (isArraySchema(node)) {
            if (!Array.isArray(value)) {
                push({
                    path, code: 'type_mismatch', expected: 'array', actual: schemaValueType(value),
                    message: `${path || 'stat_data'}: expected array, got ${schemaValueType(value)}`,
                });
                return;
            }
            // VWD 二元组:生态契约 [值, "描述"],只校验值位(下标 0)。
            const items = isValueWithDescription(value) ? [value[0]] : value;
            const childRecursive = inheritedRecursiveExtensible || node.recursiveExtensible === true;
            for (let i = 0; i < items.length; i++) {
                if (errors.length >= max) break;
                if (isArrayMetaItem(items[i])) continue;
                walk(items[i], node.elementType, joinSchemaPath(path, i), childRecursive);
            }
            return;
        }

        // 叶:string | number | boolean;null 宽容(见头注)
        if (value === null) return;
        if (typeof value !== node.type) {
            push({
                path, code: 'type_mismatch', expected: node.type, actual: schemaValueType(value),
                message: `${path}: expected ${node.type}, got ${schemaValueType(value)}`,
            });
        }
    };

    walk(data, schema, '', false);
    return errors;
}

/**
 * upstream `applyTemplate` (update_variables.ts L38-83):
 * value 优先于 template;数组按 concat/merge 两种策略;类型不匹配 → 原样。
 */
export function applyTemplate(
    value: unknown,
    template: MvuTemplate | undefined,
    strict_array_cast: boolean = false,
    array_merge_concat: boolean = true,
): unknown {
    if (!template) {
        return value;
    }
    const value_is_object = isPlainObject(value) && !(value instanceof Date);
    const value_is_array = Array.isArray(value);
    const template_is_array = Array.isArray(template);

    if (value_is_object && !template_is_array) {
        return merge({}, template, value);
    } else if (value_is_array && template_is_array) {
        if (array_merge_concat) return concat(value, template as unknown[]);
        return merge([], template, value);
    } else if (
        ((value_is_object || value_is_array) && template_is_array !== value_is_array) ||
        (!value_is_object && !value_is_array && isObject(template) && !Array.isArray(template))
    ) {
        return value;
    } else if (!value_is_object && !value_is_array && template_is_array) {
        if (strict_array_cast) return value;
        if (array_merge_concat) return concat([value], template as unknown[]);
        return merge([], template, [value]);
    }
    return value;
}
