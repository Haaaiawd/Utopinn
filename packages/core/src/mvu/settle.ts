/**
 * MVU settle 引擎核心 — UpdateVariable 命令 → stat_data 投影。
 * 语义基准:
 * - `update_variables.ts` L664-675 (pathFixPass / isNullOrWhiteSpace)
 * - `update_variables.ts` L677-1498 (updateVariables 主循环)
 * - `update_variables.ts` L1500-1575 (handleVariablesInMessage)
 * - `util.ts` L12-32 (getLastValidMessageId / getLastValidVariable)
 * - `function/initvar/variable_init.ts` (initCheck / loadInitVarData /
 *   createEmptyGameData) — 初始化折叠进同一 settle 语义
 * - `util/common.ts` correctlyMerge(数组替换式 merge)
 *
 * 投影语义(C1):stat_data = 全聊天日志 fold 的视图。实现上 = 取前置楼层
 * 最后一个含 MvuData 快照的 swipe 槽位为基底,就地 fold 本层命令,再作为
 * 本层快照写回。旧楼层被删改时不重新解析,所以不会漂移。
 *
 * 偏离与裁剪:
 * - eventEmit/toastr/console.* → 全部折算为 MvuSettleReceipt(op 日志);
 *   仅保留 onVariableUpdated 可选钩子供未来 card-script 事件桥。
 * - 不再支持 `_.set` 之外的 upstream 钩子(COMMAND_PARSED 事件改写命令)。
 * - upstream `move` 命令无执行分支 —— 解析保留,标记 'unsupported'。
 */
import {
    deepClone,
    get,
    has,
    isEmpty,
    isEqual,
    isObject,
    isObjectLike,
    isPlainObject,
    merge,
    mergeWith,
    set,
    toPath,
    unset,
} from './lodash.js';
import {
    extractCommands,
    parseCommandValue,
    pathFix,
    pathSegmentsToLodashPath,
    parseMvuString,
    trimQuotesAndBackslashes,
} from './parse.js';
import {
    applyTemplate,
    cleanUpMetadata,
    generateSchema,
    getSchemaForPath,
    reconcileAndApplySchema,
} from './schema.js';
import {
    isArraySchema,
    isMvuData,
    isObjectSchema,
    isValueWithDescription,
    type MvuCommand,
    type MvuData,
    type MvuFloorMessage,
    type MvuObjectSchema,
    type MvuSettleOp,
    type MvuSettleOptions,
    type MvuSettleReceipt,
    type MvuStatData,
} from './types.js';

/** 状态栏占位符 — upstream handleVariablesInMessage 给 assistant 楼层追加。 */
export const MVU_STATUS_PLACEHOLDER = '<StatusPlaceHolderImpl/>';

/** upstream strip 规则 (update_variables.ts L1557-1562)。 */
const STATUS_CURRENT_VARIABLE_RE = /<(status_current_variable)>(?:(?!<\1>).)*<\/\1?>/gis;

/** upstream `pathFixPass` (update_variables.ts L664-671)。 */
function pathFixPass(commands: MvuCommand[]): void {
    for (const command of commands) {
        // JSON Patch 路径已按 JSON Pointer 段编码,过 pathFix 会破坏字面点/括号。
        if (command.reason === 'json_patch') continue;
        command.args[0] = pathFix(trimQuotesAndBackslashes(command.args[0]) as string);
        // 模型常按卡 prompt 习惯带 stat_data. 前缀写相对路径(卡侧 applySetLine 同款剥除);
        // settle 作用域即 variables.stat_data,不剥会嵌套成 stat_data.stat_data.*(GH#15)。
        if (typeof command.args[0] === 'string') {
            for (const prefix of ['variables.stat_data.', 'stat_data.']) {
                if (command.args[0].startsWith(prefix)) {
                    command.args[0] = command.args[0].slice(prefix.length);
                    break;
                }
            }
            if (command.args[0] === 'stat_data' || command.args[0] === 'variables.stat_data') {
                command.args[0] = '';
            }
        }
    }
}

function isNullOrWhiteSpace(str: unknown): boolean {
    return str == null || (typeof str === 'string' && str.trim().length === 0);
}

export interface MvuSettleResult {
    /** upstream `is_modified` —— stat_data 是否实质变化。 */
    modified: boolean;
    receipt: MvuSettleReceipt;
}

export interface MvuSettleHooks extends MvuSettleOptions {
    /** upstream SINGLE_VARIABLE_UPDATED 事件的等价(deprecated,仅桥接用)。 */
    onVariableUpdated?: (statData: MvuStatData, path: string, oldValue: unknown, newValue: unknown) => void;
}

/**
 * upstream `updateVariables` (update_variables.ts L677-1498) 同步化端口:
 * 解析 content 中的更新命令,就地 fold 进 `variables`,产出回执。
 * `variables` 会被原地修改(stat_data/schema/display_data/delta_data)。
 */
export function settleMvuVariables(
    currentMessageContent: string,
    variables: MvuData,
    options: MvuSettleHooks = {},
): MvuSettleResult {
    const substitute = options.substitute ?? ((s: string) => s);
    const emitUpdated = options.onVariableUpdated ?? (() => {});

    const variablesBeforeUpdate = deepClone(variables);
    const outStatus = deepClone(variables);
    const deltaStatus: { stat_data: Record<string, unknown> } = { stat_data: {} };

    const processedContent = substitute(currentMessageContent);
    const commands = extractCommands(processedContent);

    // $internal 仅在结算期间存在(display/delta 容器引用),结束摘除。
    set(variables.stat_data as Record<string, unknown>, '$internal', {
        display_data: outStatus.stat_data,
        delta_data: deltaStatus.stat_data,
    });

    const ops: MvuSettleOp[] = [];
    const errors: { command: string; content: string }[] = [];
    let currentCommand: MvuCommand | undefined;
    const outError = (content: string): void => {
        errors.push({
            command: currentCommand?.full_match ?? '(unknown command)',
            content,
        });
    };

    const schema = variables.schema;
    const strict_template = schema?.strictTemplate ?? false;
    const concat_template_array = schema?.concatTemplateArray ?? true;
    const strict_set = schema?.strictSet ?? false;

    // 别名归一(upstream L719-727)。
    for (const cmd of commands) {
        if (cmd.type === 'remove') cmd.type = 'delete';
        else if (cmd.type === 'assign') cmd.type = 'insert';
        else if (cmd.type === 'unset') cmd.type = 'delete';
    }

    pathFixPass(commands);

    for (let commandIndex = 0; commandIndex < commands.length; commandIndex++) {
        const command = commands[commandIndex]!;
        const path = command.args[0] ?? '';
        const reasonStr = command.reason ? `(${command.reason})` : '';
        let displayStr = '';
        currentCommand = command;

        const op: MvuSettleOp = {
            index: commandIndex,
            type: command.type,
            command: command.full_match,
            path,
            reason: command.reason,
            status: 'skipped',
        };
        ops.push(op);
        const fail = (content: string): void => {
            op.status = 'error';
            op.error = content;
            outError(content);
        };

        switch (command.type) {
            case 'set': {
                // 卡侧/TH 生态的 _.set 即 lodash 语义:路径不存在自动创建(GH#15)。
                // 不再要求 has() 预存在——创建路径由 receipt oldValue=undefined 如实留痕。
                let oldValue =
                    path === '' ? deepClone(variables.stat_data) : get(variables.stat_data, path);
                let newValue = parseCommandValue(command.args.at(-1)!);
                if (newValue instanceof Date) {
                    newValue = newValue.toISOString();
                }
                let isPathVWD = false;

                if (
                    !strict_set &&
                    Array.isArray(oldValue) &&
                    oldValue.length === 2 &&
                    typeof oldValue[1] === 'string' &&
                    !Array.isArray(oldValue[0])
                ) {
                    // ValueWithDescription:只更新 [0];number 旧值且新值非 null → Number()。
                    const oldValueCopy = deepClone(oldValue[0]);
                    oldValue[0] =
                        typeof oldValue[0] === 'number' && newValue !== null
                            ? Number(newValue)
                            : newValue;
                    oldValue = oldValueCopy;
                    isPathVWD = true;
                } else if (
                    typeof oldValue === 'number' &&
                    newValue !== null &&
                    typeof newValue === 'string'
                ) {
                    set(variables.stat_data, path, Number(newValue));
                } else if (path) {
                    set(variables.stat_data, path, newValue);
                } else {
                    variables.stat_data = newValue as MvuStatData;
                }

                let finalNewValue =
                    path === '' ? variables.stat_data : get(variables.stat_data, path);
                if (isPathVWD && Array.isArray(finalNewValue)) {
                    finalNewValue = finalNewValue[0];
                }

                const isStrict = !strict_set;
                if (
                    isStrict &&
                    isValueWithDescription(oldValue) &&
                    Array.isArray(finalNewValue)
                ) {
                    displayStr =
                        `${trimQuotesAndBackslashes(JSON.stringify((oldValue as unknown[])[0]))}` +
                        `->${trimQuotesAndBackslashes(JSON.stringify((finalNewValue as unknown[])[0]))} ${reasonStr}`;
                } else {
                    displayStr =
                        `${trimQuotesAndBackslashes(JSON.stringify(oldValue))}` +
                        `->${trimQuotesAndBackslashes(JSON.stringify(finalNewValue))} ${reasonStr}`;
                }
                op.status = 'applied';
                op.oldValue = oldValue;
                op.newValue = finalNewValue;
                emitUpdated(variables.stat_data, path, oldValue, finalNewValue);
                break;
            }

            case 'insert':
            case 'assign': {
                const targetPath = path;
                const existingValue =
                    targetPath === '' ? variables.stat_data : get(variables.stat_data, targetPath);
                const targetSchema = getSchemaForPath(schema, targetPath);

                if (
                    existingValue !== null &&
                    !Array.isArray(existingValue) &&
                    !isObject(existingValue)
                ) {
                    fail(
                        `Cannot assign to '${targetPath}': target is primitive ` +
                        `(${typeof existingValue}) ${reasonStr}`,
                    );
                    continue;
                }

                if (targetSchema) {
                    if (targetSchema.type === 'object' && targetSchema.extensible === false) {
                        if (command.args.length === 2) {
                            fail(
                                `Cannot merge into non-extensible object at '${targetPath}' ${reasonStr}`,
                            );
                            continue;
                        }
                        if (command.args.length >= 3) {
                            const newKey = String(parseCommandValue(command.args[1]));
                            if (!has(targetSchema.properties, newKey)) {
                                fail(
                                    `Key '${newKey}' is not a known property of non-extensible ` +
                                    `object at '${targetPath}' ${reasonStr}`,
                                );
                                continue;
                            }
                        }
                    } else if (
                        targetSchema.type === 'array' &&
                        (targetSchema.extensible === false || targetSchema.extensible === undefined)
                    ) {
                        fail(`Cannot insert into non-extensible array at '${targetPath}' ${reasonStr}`);
                        continue;
                    }
                } else if (
                    targetPath !== '' &&
                    !get(
                        variables.stat_data,
                        pathSegmentsToLodashPath(toPath(targetPath).slice(0, -1)),
                    )
                ) {
                    fail(`Cannot assign to '${targetPath}': parent path does not exist ${reasonStr}`);
                    continue;
                }

                const oldValue = deepClone(existingValue);
                let successful = false;

                if (command.args.length === 2) {
                    let valueToAssign = parseCommandValue(command.args[1]);
                    if (valueToAssign instanceof Date) {
                        valueToAssign = valueToAssign.toISOString();
                    } else if (Array.isArray(valueToAssign)) {
                        valueToAssign = valueToAssign.map(item =>
                            item instanceof Date ? item.toISOString() : item,
                        );
                    }

                    let collection =
                        targetPath === '' ? variables.stat_data : get(variables.stat_data, path);
                    if (!Array.isArray(collection) && !isObject(collection)) {
                        collection = Array.isArray(valueToAssign) ? [] : {};
                        set(variables.stat_data, path, collection);
                    }

                    if (Array.isArray(collection)) {
                        const template =
                            targetSchema && isArraySchema(targetSchema)
                                ? targetSchema.template
                                : undefined;
                        valueToAssign = applyTemplate(
                            valueToAssign,
                            template,
                            strict_template,
                            concat_template_array,
                        );
                        collection.push(valueToAssign);
                        displayStr = `ASSIGNED ${JSON.stringify(valueToAssign)} into array '${path}' ${reasonStr}`;
                        successful = true;
                    } else if (isObject(collection)) {
                        if (isObject(valueToAssign) && !Array.isArray(valueToAssign)) {
                            merge(collection as object, valueToAssign as object);
                            displayStr =
                                `MERGED object ${JSON.stringify(valueToAssign)} ` +
                                `into object '${path}' ${reasonStr}`;
                            successful = true;
                        } else {
                            fail(
                                Array.isArray(valueToAssign)
                                    ? `Cannot merge array into object '${path}'`
                                    : `Cannot merge non-object value into object '${path}'`,
                            );
                            continue;
                        }
                    }
                } else if (command.args.length >= 3) {
                    let valueToAssign = parseCommandValue(command.args[2]);
                    const keyOrIndex = parseCommandValue(command.args[1]);
                    if (valueToAssign instanceof Date) {
                        valueToAssign = valueToAssign.toISOString();
                    } else if (Array.isArray(valueToAssign)) {
                        valueToAssign = valueToAssign.map(item =>
                            item instanceof Date ? item.toISOString() : item,
                        );
                    }

                    let collection =
                        targetPath === '' ? variables.stat_data : get(variables.stat_data, path);
                    const template =
                        targetSchema &&
                        (isArraySchema(targetSchema) || isObjectSchema(targetSchema))
                            ? targetSchema.template
                            : undefined;

                    if (
                        Array.isArray(collection) &&
                        (typeof keyOrIndex === 'number' || keyOrIndex === '-')
                    ) {
                        const insertIndex = keyOrIndex === '-' ? collection.length : (keyOrIndex as number);
                        const positionLabel =
                            keyOrIndex === '-' || keyOrIndex === -1 ? 'tail' : keyOrIndex;
                        valueToAssign = applyTemplate(
                            valueToAssign,
                            template,
                            strict_template,
                            concat_template_array,
                        );
                        collection.splice(insertIndex, 0, valueToAssign);
                        displayStr =
                            `ASSIGNED ${JSON.stringify(valueToAssign)} into '${path}' ` +
                            `at index ${positionLabel} ${reasonStr}`;
                        successful = true;
                    } else if (isObject(collection)) {
                        valueToAssign = applyTemplate(
                            valueToAssign,
                            template,
                            strict_template,
                            concat_template_array,
                        );
                        (collection as Record<string, unknown>)[String(keyOrIndex)] = valueToAssign;
                        displayStr =
                            `ASSIGNED key '${String(keyOrIndex)}' with value ` +
                            `${JSON.stringify(valueToAssign)} into object '${path}' ${reasonStr}`;
                        successful = true;
                    } else {
                        collection = {};
                        set(variables.stat_data, path, collection);
                        valueToAssign = applyTemplate(
                            valueToAssign,
                            template,
                            strict_template,
                            concat_template_array,
                        );
                        (collection as Record<string, unknown>)[String(keyOrIndex)] = valueToAssign;
                        displayStr =
                            `CREATED object at '${path}' and ASSIGNED key ` +
                            `'${String(keyOrIndex)}' ${reasonStr}`;
                        successful = true;
                    }
                }

                if (successful) {
                    const newValue = isNullOrWhiteSpace(path)
                        ? variables.stat_data
                        : get(variables.stat_data, path);
                    op.status = 'applied';
                    op.oldValue = oldValue;
                    op.newValue = newValue;
                    emitUpdated(variables.stat_data, path, oldValue, newValue);
                    try {
                        const currentDataClone = deepClone(newValue);
                        const newSchema = generateSchema(currentDataClone, targetSchema ?? undefined);
                        if (targetSchema) merge(targetSchema as object, newSchema as object);
                        cleanUpMetadata(newValue);
                    } catch (error) {
                        outError(
                            `Template resolution failed at '${path}': ` +
                            `${error instanceof Error ? error.message : String(error)}`,
                        );
                        op.error = `Template resolution failed: ${error instanceof Error ? error.message : String(error)}`;
                    }
                } else {
                    fail(`Invalid assign/insert arguments for '${path}'`);
                    continue;
                }
                break;
            }

            case 'unset':
            case 'delete':
            case 'remove': {
                const pathParts = toPath(path);
                const lastPart = pathParts[pathParts.length - 1] ?? '';
                const isArrayElementPath = /^\d+$/.test(lastPart);

                if (command.args.length === 1 && isArrayElementPath) {
                    const containerPath = pathSegmentsToLodashPath(pathParts.slice(0, -1));
                    const container = get(variables.stat_data, containerPath);
                    const indexToRemove = parseInt(lastPart, 10);
                    if (Array.isArray(container) && indexToRemove < container.length) {
                        const originalArray = deepClone(container);
                        container.splice(indexToRemove, 1);
                        displayStr =
                            `REMOVED item from '${containerPath}' ` +
                            `at index ${indexToRemove} ${reasonStr}`;
                        op.status = 'applied';
                        op.oldValue = originalArray;
                        op.newValue = container;
                        op.display = displayStr;
                        emitUpdated(variables.stat_data, containerPath, originalArray, container);
                        // upstream `continue`:fast-path 不写 display_data/delta_data。
                        continue;
                    }
                }

                if (!has(variables.stat_data, path)) {
                    fail(`Cannot remove '${path}': path does not exist`);
                    continue;
                }

                let containerPath = path;
                let keyOrIndexToRemove: string | number | undefined;
                if (command.args.length > 1) {
                    keyOrIndexToRemove = parseCommandValue(command.args[1]) as string | number;
                    if (typeof keyOrIndexToRemove === 'string') {
                        keyOrIndexToRemove = trimQuotesAndBackslashes(keyOrIndexToRemove) as string;
                    }
                } else {
                    const parts = toPath(path);
                    const last = parts.pop();
                    if (last !== undefined) {
                        keyOrIndexToRemove = /^\d+$/.test(last) ? Number(last) : last;
                        containerPath = pathSegmentsToLodashPath(parts);
                    }
                }
                if (keyOrIndexToRemove === undefined) {
                    fail(`Cannot determine delete target for '${path}' ${reasonStr}`);
                    continue;
                }
                if (containerPath !== '' && !has(variables.stat_data, containerPath)) {
                    fail(`Cannot remove from '${containerPath}': container path missing ${reasonStr}`);
                    continue;
                }

                const containerSchema = getSchemaForPath(schema, containerPath);
                if (containerSchema) {
                    if (containerSchema.type === 'array') {
                        if (containerSchema.extensible !== true) {
                            fail(
                                `Cannot remove from non-extensible array ` +
                                `at '${containerPath}' ${reasonStr}`,
                            );
                            continue;
                        }
                    } else if (containerSchema.type === 'object') {
                        const keyString = String(keyOrIndexToRemove);
                        const prop = containerSchema.properties[keyString];
                        if (
                            has(containerSchema.properties, keyString) &&
                            prop && (prop as { required?: boolean }).required === true
                        ) {
                            fail(
                                `Cannot remove required key '${keyString}' ` +
                                `from '${containerPath}' ${reasonStr}`,
                            );
                            continue;
                        }
                    }
                }

                const targetToRemove =
                    command.args.length > 1 ? parseCommandValue(command.args[1]) : undefined;
                let itemRemoved = false;
                const removedOld = deepClone(get(variables.stat_data, path));

                if (targetToRemove === undefined) {
                    unset(variables.stat_data, path);
                    displayStr = `REMOVED path '${path}' ${reasonStr}`;
                    itemRemoved = true;
                    op.oldValue = removedOld;
                    op.newValue = undefined;
                    emitUpdated(variables.stat_data, path, removedOld, undefined);
                } else {
                    const collection = get(variables.stat_data, path);
                    if (!Array.isArray(collection) && !isObject(collection)) {
                        fail(`Cannot remove from '${path}': target is not a collection ${reasonStr}`);
                        continue;
                    }
                    if (Array.isArray(collection)) {
                        const originalArray = deepClone(collection);
                        let indexToRemove = -1;
                        if (typeof targetToRemove === 'number') {
                            indexToRemove = targetToRemove;
                        } else {
                            indexToRemove = collection.findIndex(item => isEqual(item, targetToRemove));
                        }
                        if (indexToRemove >= 0 && indexToRemove < collection.length) {
                            const removed = collection[indexToRemove];
                            collection.splice(indexToRemove, 1);
                            itemRemoved = true;
                            displayStr = `REMOVED item from '${path}' ${reasonStr}`;
                            op.oldValue = removed;
                            op.newValue = collection;
                            emitUpdated(variables.stat_data, path, originalArray, collection);
                        }
                    } else if (isObject(collection)) {
                        // upstream:对象删键不发 SINGLE_VARIABLE_UPDATED。
                        if (typeof targetToRemove === 'number') {
                            const keys = Object.keys(collection as Record<string, unknown>);
                            const index = targetToRemove;
                            if (index >= 0 && index < keys.length) {
                                const keyToRemove = keys[index]!;
                                const removedValue = (collection as Record<string, unknown>)[keyToRemove];
                                delete (collection as Record<string, unknown>)[keyToRemove];
                                itemRemoved = true;
                                displayStr =
                                    `REMOVED ${index + 1}th entry ('${keyToRemove}') ` +
                                    `from object '${path}' ${reasonStr}`;
                                op.oldValue = { [keyToRemove]: removedValue };
                                op.newValue = collection;
                            }
                        } else {
                            const keyToRemove = String(targetToRemove);
                            if (has(collection, keyToRemove)) {
                                const removedValue = (collection as Record<string, unknown>)[keyToRemove];
                                delete (collection as Record<string, unknown>)[keyToRemove];
                                itemRemoved = true;
                                displayStr =
                                    `REMOVED key '${keyToRemove}' from object ` +
                                    `'${path}' ${reasonStr}`;
                                op.oldValue = removedValue;
                                op.newValue = collection;
                            }
                        }
                    }
                }

                if (itemRemoved) {
                    op.status = 'applied';
                } else {
                    fail(`Failed to remove at '${path}'`);
                    continue;
                }
                break;
            }

            case 'add': {
                if (!has(variables.stat_data, path)) {
                    fail(`Cannot add to '${path}': path does not exist ${reasonStr}`);
                    continue;
                }
                const initialValue = deepClone(get(variables.stat_data, path));
                const oldValue = get(variables.stat_data, path);
                let valueToAdd = oldValue;
                const isVWD = isValueWithDescription(oldValue) && typeof (oldValue as unknown[])[0] !== 'object';
                if (isVWD) {
                    valueToAdd = (oldValue as unknown[])[0];
                }

                let potentialDate: Date | null = null;
                if (valueToAdd instanceof Date) {
                    potentialDate = valueToAdd;
                } else if (typeof valueToAdd === 'string') {
                    const parsedDate = new Date(valueToAdd);
                    if (!isNaN(parsedDate.getTime()) && isNaN(Number(valueToAdd))) {
                        potentialDate = parsedDate;
                    }
                }

                if (command.args.length === 2) {
                    const delta = parseCommandValue(command.args[1]);
                    if (potentialDate) {
                        if (typeof delta !== 'number') {
                            fail(
                                `Cannot add date '${path}': delta ` +
                                `'${command.args[1]}' is not a number ${reasonStr}`,
                            );
                            continue;
                        }
                        const newDate = new Date(potentialDate.getTime() + delta);
                        const finalValueToSet = newDate.toISOString();
                        if (isVWD) {
                            (oldValue as unknown[])[0] = finalValueToSet;
                            set(variables.stat_data, path, oldValue);
                        } else {
                            set(variables.stat_data, path, finalValueToSet);
                        }
                        const finalNewValue = get(variables.stat_data, path);
                        displayStr = isVWD
                            ? `${JSON.stringify((initialValue as unknown[])[0])}->` +
                              `${JSON.stringify((finalNewValue as unknown[])[0])} ${reasonStr}`
                            : `${JSON.stringify(initialValue)}->` +
                              `${JSON.stringify(finalNewValue)} ${reasonStr}`;
                        op.status = 'applied';
                        op.oldValue = initialValue;
                        op.newValue = finalNewValue;
                        emitUpdated(variables.stat_data, path, initialValue, finalNewValue);
                    } else if (typeof valueToAdd === 'number') {
                        if (typeof delta !== 'number') {
                            fail(
                                `Cannot add number '${path}': delta ` +
                                `'${command.args[1]}' is not a number ${reasonStr}`,
                            );
                            continue;
                        }
                        let newValue = valueToAdd + delta;
                        newValue = parseFloat(newValue.toPrecision(12));
                        if (isVWD) {
                            (oldValue as unknown[])[0] = newValue;
                            set(variables.stat_data, path, oldValue);
                        } else {
                            set(variables.stat_data, path, newValue);
                        }
                        const finalNewValue = get(variables.stat_data, path);
                        displayStr = isVWD
                            ? `${JSON.stringify((initialValue as unknown[])[0])}->` +
                              `${JSON.stringify((finalNewValue as unknown[])[0])} ${reasonStr}`
                            : `${JSON.stringify(initialValue)}->` +
                              `${JSON.stringify(finalNewValue)} ${reasonStr}`;
                        op.status = 'applied';
                        op.oldValue = initialValue;
                        op.newValue = finalNewValue;
                        emitUpdated(variables.stat_data, path, initialValue, finalNewValue);
                    } else {
                        fail(`Cannot add to '${path}': unsupported value type ${reasonStr}`);
                        continue;
                    }
                } else {
                    fail(`Invalid add arguments for '${path}' ${reasonStr}`);
                    continue;
                }
                break;
            }

            default: {
                // upstream switch 无 'move' 分支 —— 解析保留但不执行。
                op.status = 'unsupported';
                op.error = `Command '${command.type}' is parsed but not executed by the MVU engine`;
                break;
            }
        }

        if (displayStr) {
            op.display = displayStr;
            set(outStatus.stat_data as Record<string, unknown>, path, displayStr);
            set(deltaStatus.stat_data, path, displayStr);
        }
    }

    variables.display_data = outStatus.stat_data as Record<string, unknown>;
    variables.delta_data = deltaStatus.stat_data;
    unset(variables.stat_data, '$internal');

    const isModified = !isEqual(variables.stat_data, variablesBeforeUpdate.stat_data);
    if (isModified) {
        reconcileAndApplySchema(variables);
    }

    return {
        modified: isModified,
        receipt: { version: 1, modified: isModified, ops, errors },
    };
}

/**
 * upstream `createEmptyGameData` (variable_init.ts L332-343)。
 */
export function createEmptyMvuData(): MvuData {
    return {
        display_data: {},
        initialized_lorebooks: {},
        stat_data: {} as MvuStatData,
        delta_data: {},
        schema: { type: 'object', properties: {} } as MvuObjectSchema,
    };
}

/**
 * upstream `correctlyMerge` (util/common.ts):
 * mergeWith(lhs, rhs, rhs-is-array→rhs) — 数组整体替换而非逐位合并。
 */
export function correctlyMerge<T>(lhs: T, rhs: unknown): T {
    return mergeWith(lhs, [rhs], (_l, r) => (Array.isArray(r) ? r : undefined)) as T;
}

const INITVAR_BLOCK_RE = /<(initvar)>(?:\s*```.*)?([\s\S]*?)(?:```\s*)?<\/\1>/gim;

/**
 * upstream variable_init.ts L155-176:提取 `<initvar>` 块并逐个 parse+merge。
 * 返回 [是否命中, 合并后的 StatData]。
 */
export function extractInitVarData(
    content: string,
    substitute: (s: string) => string = s => s,
): { applied: boolean; statData: Record<string, unknown>; errors: string[] } {
    const overrided: Record<string, unknown> = {};
    const errors: string[] = [];
    let applied = false;
    for (const match of content.matchAll(INITVAR_BLOCK_RE)) {
        try {
            const parsed = parseMvuString(substitute(match[2]!));
            correctlyMerge(overrided, parsed);
            applied = true;
        } catch (error) {
            errors.push(error instanceof Error ? error.message : String(error));
        }
    }
    return { applied, statData: overrided, errors };
}

export interface MvuInitLorebook {
    /** lorebook 名(initialized_lorebooks 的 key)。 */
    name: string;
    /** `getLorebookEntries` 等价物 —— 只需要 content/comment。 */
    entries: { content: string; comment?: string }[];
    /** 角色主书标记;greeting <initvar> 覆盖时保留该项,其余书重载。 */
    isPrimary?: boolean;
}

/**
 * upstream `loadInitVarData` (variable_init.ts L250-327) 纯函数版:
 * 对每个未初始化 book,取 `[initvar]` 条目 → 去 <initvar>/``` 包裹 →
 * substitute → parse → correctlyMerge → 顶层并入 stat_data。
 */
export function loadInitVarData(
    mvuData: MvuData,
    lorebooks: MvuInitLorebook[],
    substitute: (s: string) => string = s => s,
): { updated: boolean; errors: string[] } {
    const errors: string[] = [];
    let isUpdated = false;
    if (!mvuData.initialized_lorebooks || Array.isArray(mvuData.initialized_lorebooks)) {
        mvuData.initialized_lorebooks = {};
    }
    for (const book of lorebooks) {
        if (has(mvuData.initialized_lorebooks, book.name)) continue;
        mvuData.initialized_lorebooks[book.name] = [];
        try {
            const mergedData: Record<string, unknown> = {};
            for (const entry of book.entries) {
                if (!entry.comment?.toLowerCase().includes('[initvar]')) continue;
                let entryContent = entry.content;
                const xmlMatch = entryContent.trim().match(/.*<initvar>.*\n([\s\S]*)\n.*<\/initvar>.*/m);
                if (xmlMatch) {
                    entryContent = xmlMatch[1]!;
                }
                const codeblockMatch = entryContent.trim().match(/```.*\n([\s\S]*)\n```/m);
                if (codeblockMatch) {
                    entryContent = codeblockMatch[1]!;
                }
                const parsedData = parseMvuString(substitute(entryContent));
                if (parsedData) {
                    correctlyMerge(mergedData, parsedData);
                }
            }
            mvuData.stat_data = { ...mergedData, ...(mvuData.stat_data as object) } as MvuStatData;
            isUpdated = true;
        } catch (error) {
            errors.push(error instanceof Error ? error.message : String(error));
        }
    }
    return { updated: isUpdated, errors };
}

export interface MvuInitializeInput {
    /** 开场 swipe 正文(可能含 <initvar> 与 _. 命令)。 */
    swipeText: string;
    /** 启用的 lorebook 集合(顺序即 upstream 合并顺序:global→char)。 */
    lorebooks?: MvuInitLorebook[];
    /** 角色主书名;<initvar> 覆盖时保留的 book 项。默认 'unknown'。 */
    primaryLorebookName?: string;
    substitute?: (s: string) => string;
    onVariableUpdated?: MvuSettleHooks['onVariableUpdated'];
}

export interface MvuInitializeResult {
    variables: MvuData;
    /** 是否有任何 lorebook/greeting 初始化输入。 */
    updated: boolean;
    /** greeting 是否带 <initvar> 覆盖。 */
    appliedInitVarOverride: boolean;
    errors: string[];
    receipt: MvuSettleReceipt;
}

/**
 * upstream `initCheck` (variable_init.ts L22-225) 的纯函数核心:
 * createEmpty → loadInitVarData → schema 生成+$meta 清理 → greeting
 * <initvar> 覆盖(保留主书、重载其余)→ settleMvuVariables(swipe 全文)。
 * 与 upstream 的差异:不含 DOM/事件/toastr,swipe 维度一次一个。
 */
export function initializeMvuVariables(input: MvuInitializeInput): MvuInitializeResult {
    const substitute = input.substitute ?? ((s: string) => s);
    const errors: string[] = [];
    const variables = createEmptyMvuData();
    const lorebooks = input.lorebooks ?? [];

    const firstLoad = loadInitVarData(variables, lorebooks, substitute);
    errors.push(...firstLoad.errors);
    let isUpdated = firstLoad.updated;

    // upstream initCheck L99-124:有更新或 schema 缺失时重建 schema 并清理 $meta。
    if (isUpdated || !variables.schema || isEmpty(variables.schema)) {
        const dataForSchema = deepClone(variables.stat_data);
        const generatedSchema = generateSchema(dataForSchema, variables.schema);
        if (isObjectSchema(generatedSchema)) {
            const withProps = generatedSchema as MvuObjectSchema & {
                strictTemplate?: boolean;
                concatTemplateArray?: boolean;
                strictSet?: boolean;
            };
            const meta = variables.stat_data['$meta'] as Record<string, unknown> | undefined;
            if (has(variables.stat_data, '$meta.strictTemplate')) {
                withProps.strictTemplate = meta?.strictTemplate as boolean;
            }
            if (has(variables.stat_data, '$meta.concatTemplateArray')) {
                withProps.concatTemplateArray = meta?.concatTemplateArray as boolean;
            }
            if (has(variables.stat_data, '$meta.strictSet')) {
                withProps.strictSet = meta?.strictSet as boolean;
            }
            variables.schema = withProps;
        }
        cleanUpMetadata(variables.stat_data);
    }

    // greeting <initvar>:覆盖 stat_data → 保留主书 → 其余 lorebook 重载。
    const initVar = extractInitVarData(input.swipeText, substitute);
    errors.push(...initVar.errors);
    if (initVar.applied) {
        isUpdated = true;
        variables.stat_data = initVar.statData as MvuStatData;
        const primary = input.primaryLorebookName ?? 'unknown';
        variables.initialized_lorebooks = {};
        variables.initialized_lorebooks[primary] = [];
        const secondLoad = loadInitVarData(
            variables,
            lorebooks.filter(book => book.name !== primary),
            substitute,
        );
        errors.push(...secondLoad.errors);
    }

    // upstream L191:greeting 正文本身也走一遍 settle(里面可能有 _. 命令)。
    const settle = settleMvuVariables(input.swipeText, variables, {
        substitute,
        onVariableUpdated: input.onVariableUpdated,
    });
    errors.push(...settle.receipt.errors.map(e => `${e.command}: ${e.content}`));

    return {
        variables,
        updated: isUpdated || settle.modified,
        appliedInitVarOverride: initVar.applied,
        errors,
        receipt: settle.receipt,
    };
}

/**
 * upstream `getLastValidMessageId` (util.ts L12-18):
 * 在 messages[0..endIndex) 中找最后一个 `variables[own swipe_id]` 通过
 * isMvuData 的楼层。
 */
export function findMvuBaselineIndex(messages: MvuFloorMessage[], endIndex: number): number {
    const upper = Math.min(endIndex, messages.length);
    for (let i = upper - 1; i >= 0; i--) {
        const message = messages[i];
        if (!message) continue;
        const swipeId = message.swipe_id ?? 0;
        const variables = message.variables?.[swipeId as keyof typeof message.variables];
        if (isMvuData(variables)) {
            return i;
        }
    }
    return -1;
}

/** 楼层角色归一(jsonl 的 is_user/is_system ↔ TH 的 role)。 */
export function floorRole(message: MvuFloorMessage): 'user' | 'assistant' | 'system' {
    if (typeof message.role === 'string') {
        if (message.role === 'user' || message.role === 'system') return message.role;
        return 'assistant';
    }
    if (message.is_user === true) return 'user';
    if (message.is_system === true) return 'system';
    return 'assistant';
}

export interface MvuSettleMessageInput {
    /** 完整聊天体(jsonl body)。 */
    messages: MvuFloorMessage[];
    /** 目标楼层序号(= upstream message_id)。 */
    messageIndex: number;
    substitute?: (s: string) => string;
    onVariableUpdated?: MvuSettleHooks['onVariableUpdated'];
}

export interface MvuSettleMessageResult {
    /**
     * 'settled'   —— 正常执行(无论 modified 与否);
     * 'skipped'   —— 楼层不存在或 assistant 且内容 <5 字符;
     * 'no_baseline' —— 前置日志无 MvuData 快照(未 init)。
     */
    status: 'settled' | 'skipped' | 'no_baseline';
    modified: boolean;
    /** 结算后应写回 messages[i].variables[swipeId] 的快照(deepClone 后)。 */
    variables?: MvuData;
    /** 基底楼层序号(messages[baselineIndex] 提供快照)。 */
    baselineIndex: number;
    /** 写入槽位:messages[messageIndex].swipe_id ?? 0。 */
    swipeId: number;
    /** 处理后的楼层文本(占位符追加 / status_current_variable 剥离);未变则为原文。 */
    message: string;
    /** 给 chat_metadata.variables 的镜像补丁(upstream 更新到聊天变量 同构)。 */
    chatVariablesPatch: Record<string, unknown>;
    receipt: MvuSettleReceipt;
}

/**
 * upstream `handleVariablesInMessage` (update_variables.ts L1500-1575) 端口:
 * 基底快照 → fold 本层命令 → 文本后处理(占位符/status_current_variable)。
 * 持久化写回由调用方负责(messages[i].variables[swipeId] / chat_metadata)。
 */
export function settleMvuMessage(input: MvuSettleMessageInput): MvuSettleMessageResult {
    const { messages, messageIndex } = input;
    const message = messages[messageIndex];
    const emptyReceipt: MvuSettleReceipt = { version: 1, modified: false, ops: [], errors: [] };
    if (!message) {
        return {
            status: 'skipped',
            modified: false,
            baselineIndex: -1,
            swipeId: -1,
            message: '',
            chatVariablesPatch: {},
            receipt: emptyReceipt,
        };
    }

    const role = floorRole(message);
    let content = String(message.mes ?? message.message ?? '');
    const swipeId = message.swipe_id ?? 0;

    if (role === 'assistant' && content.length < 5) {
        return {
            status: 'skipped',
            modified: false,
            baselineIndex: -1,
            swipeId,
            message: content,
            chatVariablesPatch: {},
            receipt: emptyReceipt,
        };
    }

    // upstream L1512:0 层基线取 [0,1) —— 即自身(开场 init 先于本 settle 写变量)。
    const requestMessageId = messageIndex === 0 ? 1 : messageIndex;
    const baselineIndex = findMvuBaselineIndex(messages, requestMessageId);
    if (baselineIndex === -1) {
        return {
            status: 'no_baseline',
            modified: false,
            baselineIndex: -1,
            swipeId,
            message: content,
            chatVariablesPatch: {},
            receipt: emptyReceipt,
        };
    }

    const baselineMessage = messages[baselineIndex]!;
    const baseline = deepClone(
        baselineMessage.variables?.[(baselineMessage.swipe_id ?? 0) as keyof typeof baselineMessage.variables],
    ) as MvuData;
    if (!has(baseline, 'stat_data')) {
        return {
            status: 'no_baseline',
            modified: false,
            baselineIndex,
            swipeId,
            message: content,
            chatVariablesPatch: {},
            receipt: emptyReceipt,
        };
    }

    const { modified, receipt } = settleMvuVariables(content, baseline, {
        substitute: input.substitute,
        onVariableUpdated: input.onVariableUpdated,
    });

    if (role !== 'user') {
        if (!content.includes(MVU_STATUS_PLACEHOLDER)) {
            content += `\n\n${MVU_STATUS_PLACEHOLDER}`;
        }
        if (content.includes('<status_current_variable>')) {
            content = content.replace(STATUS_CURRENT_VARIABLE_RE, '');
        }
    }

    // upstream updater (L1528-1547):写回 message.variables 的字段集;
    // 同构补丁直接可用作 chat_metadata.variables 的镜像。
    const chatVariablesPatch: Record<string, unknown> = {
        initialized_lorebooks: baseline.initialized_lorebooks,
        stat_data: baseline.stat_data,
    };
    if (baseline.schema !== undefined) {
        chatVariablesPatch.schema = baseline.schema;
    }
    if (baseline.display_data !== undefined) {
        chatVariablesPatch.display_data = baseline.display_data;
    }
    if (baseline.delta_data !== undefined) {
        chatVariablesPatch.delta_data = baseline.delta_data;
    }

    return {
        status: 'settled',
        modified,
        variables: baseline,
        baselineIndex,
        swipeId,
        message: content,
        chatVariablesPatch,
        receipt,
    };
}
