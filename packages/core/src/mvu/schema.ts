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
